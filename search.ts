// A busca: rodadas de amostragem. A cada rodada o Jev julga 250 candidatos;
// os 50 melhores (nota + confiança combinadas) orientam de onde tirar os 250
// seguintes. A cada rodada o cerco aperta em volta do que está funcionando.

import { byId, poolFor, type Box, type Restaurant } from './catalog.ts';
import { rankCandidates, type ScoredRow } from './scoring.ts';

export const ROUND_SIZE = 250;
export const KEEP_BEST = 50;
export const DEFAULT_ROUNDS = 4;
export const DEFAULT_CONFIDENCE_WEIGHT = 0.3;

export type Round = {
  index: number;
  strategy: string;
  judged: number;
  meanScore: number;
  meanConfidence: number;
  bestScore: number | null;
  bestName: string | null;
  bestCity: string | null;
  newInTop: number;
  topNames: string[];
  ms: number;
  costUsd: number;
};

export type SearchOutcome = {
  rounds: Round[];
  results: ScoredRow[];
  judged: number;
  poolSize: number;
  stopped: 'rodadas' | 'estável' | 'pool esgotado';
  meta: { calls: number; latencyMs: number; inputTokens: number; costUsd: number };
};

// Nota e confiança combinadas, mas a confiança só pode DESCONTAR.
// Motivo medido: num lote misto o Jev fica com confiança alta (0,82) nos
// restaurantes que ele descarta com certeza, e baixa (0,55) entre candidatos
// disputados. Somar confiança como parcela positiva promovia justamente os
// "certamente não serve" — a rodada 1 dominava a lista por isso.
//   peso 0 → nota pura · peso 1 → nota × confiança
export const combined = (row: ScoredRow, weight: number) => {
  const score = Number.isFinite(row.score) ? row.score : 0;
  const confidence = row.confidence ?? 0;
  return score * (1 - weight * (1 - confidence));
};

const shuffled = (items: Restaurant[]) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
};

// "Cercar": candidatos parecidos com os melhores sobem na fila (mesma cidade,
// mesmo grupo de cozinha, mesma faixa de preço, mesma distinção). O peso base e
// o sorteio final mantêm exploração — sem eles a busca trava no primeiro bairro.
const guidedBatch = (unseen: Restaurant[], winners: ScoredRow[], size: number) => {
  const cities = new Set(winners.map(winner => winner.city));
  const bands = new Set(winners.map(winner => winner.priceBand));
  const stars = new Set(winners.map(winner => winner.star));
  const buckets = new Set(
    winners.flatMap(winner => byId.get(winner.id)?.cuisineBuckets ?? []),
  );

  const ranked = unseen.map(restaurant => {
    let affinity = 0.3;
    if (cities.has(restaurant.city)) affinity += 1;
    if (restaurant.cuisineBuckets.some(bucket => buckets.has(bucket))) affinity += 0.7;
    if (bands.has(restaurant.priceBand)) affinity += 0.35;
    if (stars.has(restaurant.star)) affinity += 0.2;
    return { restaurant, key: affinity * (0.6 + Math.random() * 0.8) };
  });
  ranked.sort((a, b) => b.key - a.key);
  return ranked.slice(0, size).map(entry => entry.restaurant);
};

export async function search(
  request: string,
  options: {
    apiKey: string;
    box: Box | null;
    rounds?: number;
    confidenceWeight?: number;
    onRound?: (round: Round) => void;
  },
): Promise<SearchOutcome> {
  const roundCount = options.rounds ?? DEFAULT_ROUNDS;
  const weight = options.confidenceWeight ?? DEFAULT_CONFIDENCE_WEIGHT;
  const pool = poolFor(options.box);

  let unseen = shuffled(pool);
  const judged: ScoredRow[] = [];
  const rounds: Round[] = [];
  const started = performance.now();
  let calls = 0;
  let inputTokens = 0;
  let stopped: SearchOutcome['stopped'] = 'rodadas';
  let previousTop = new Set<string>();

  for (let index = 0; index < roundCount; index++) {
    const winners = [...judged]
      .sort((a, b) => combined(b, weight) - combined(a, weight))
      .slice(0, KEEP_BEST);

    const isFirst = index === 0 || winners.length === 0;
    const batch = isFirst ? unseen.slice(0, ROUND_SIZE) : guidedBatch(unseen, winners, ROUND_SIZE);
    const taken = new Set(batch.map(restaurant => restaurant.id));
    unseen = unseen.filter(restaurant => !taken.has(restaurant.id));

    const roundStarted = performance.now();
    const { rows, meta } = await rankCandidates(batch, request, options.apiKey);
    calls += meta.calls;
    inputTokens += meta.inputTokens;
    judged.push(...rows.map(row => ({ ...row, round: index + 1 })));

    const top = [...judged]
      .filter(row => Number.isFinite(row.score))
      .sort((a, b) => combined(b, weight) - combined(a, weight))
      .slice(0, 20);
    const topIds = new Set(top.map(row => row.id));
    const newInTop = [...topIds].filter(id => !previousTop.has(id)).length;
    const best = top[0];
    const validos = rows.filter(row => Number.isFinite(row.score));

    const round: Round = {
      index: index + 1,
      strategy: isFirst ? 'aleatório' : 'cercando os melhores',
      judged: rows.length,
      meanScore: validos.length ? validos.reduce((sum, row) => sum + row.score, 0) / validos.length : 0,
      meanConfidence: validos.length
        ? validos.reduce((sum, row) => sum + (row.confidence ?? 0), 0) / validos.length
        : 0,
      bestScore: best ? +best.score.toFixed(2) : null,
      bestName: best?.name ?? null,
      bestCity: best?.city ?? null,
      newInTop,
      topNames: top.slice(0, 3).map(row => `${row.name} (${row.score.toFixed(2)})`),
      ms: performance.now() - roundStarted,
      costUsd: meta.costUsd,
    };
    rounds.push(round);
    options.onRound?.(round);
    previousTop = topIds;

    // Estabilizou: uma rodada inteira sem nenhum nome novo no top-20.
    if (index > 0 && newInTop === 0) { stopped = 'estável'; break; }
    if (unseen.length === 0) { stopped = 'pool esgotado'; break; }
  }

  return {
    rounds,
    results: judged
      .filter(row => Number.isFinite(row.score))
      .sort((a, b) => combined(b, weight) - combined(a, weight)),
    judged: judged.length,
    poolSize: pool.length,
    stopped,
    meta: {
      calls,
      latencyMs: performance.now() - started,
      inputTokens,
      costUsd: inputTokens * 0.042 / 1e6,
    },
  };
}
