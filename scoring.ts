// Julgamento: o Jev dá uma nota de 0 a 5 para cada candidato, em lotes de 250
// (teto medido de ~64k tokens por requisição com o esquema enxuto).

import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationModel,
} from 'ai';
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import { restaurants, type Restaurant } from './catalog.ts';

// O modelo é construído por chamada, com a chave que veio do navegador: o
// servidor não guarda credencial nenhuma.
const modelFor = (apiKey: string): Experimental_EvaluationModel =>
  createTypeSafeAi({ apiKey }).evaluationModel('jev-latest');

export const BATCH_SIZE = 250;
export const CONCURRENCY = 6;
export const INPUT_PRICE_PER_TOKEN = 0.042 / 1e6;

// Escala 0–5. 236 tokens por pergunta, medido: 6 níveis + perfil compacto.
export const LEVELS = [
  'Não serve: o pedido exclui este restaurante (cozinha, preço ou ocasião incompatíveis)',
  'Quase não serve: atende só um detalhe periférico e falha no principal',
  'Serve pouco: atende parte do pedido, mas desvia em um ponto importante',
  'Serve: atende o essencial do pedido, sem se destacar',
  'Serve bem: atende quase todos os pontos relevantes do pedido',
  'Serve perfeitamente: é exatamente o que o pedido descreve, inclusive nos detalhes',
];

export type ScoredRow = {
  id: string;
  name: string;
  city: string;
  cuisine: string;
  award: string;
  star: number;
  priceBand: number;
  lat: number;
  lon: number;
  url: string;
  score: number;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  round?: number;
};

export type ScoringMeta = {
  calls: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

const questionsFor = (rows: Restaurant[]) => {
  const questions: Record<string, unknown> = {};
  for (const row of rows) {
    questions[row.id] = {
      type: 'score',
      instructions: {
        restaurante: {
          nome: row.name,
          cidade: row.city,
          cozinha: row.cuisine,
          preco: row.price,
          distincao: row.award,
        },
        pergunta: 'Quão bem `restaurante` atende ao pedido em `pedido`?',
      },
      criteria: LEVELS,
    };
  }
  return questions as Parameters<typeof evaluate>[0]['questions'];
};

export type BatchResult = { rows: ScoredRow[]; inputTokens: number; outputTokens: number };

export async function scoreBatch(
  rows: Restaurant[],
  request: string,
  apiKey: string,
): Promise<BatchResult> {
  const result = await evaluate({
    model: modelFor(apiKey),
    state: { pedido: request },
    questions: questionsFor(rows),
  });

  const answers = result.answers as unknown as Record<
    string,
    { score: number; probabilities?: Record<string, number> } | undefined
  >;
  const confidence = (result.providerMetadata as
    | { typesafe?: { confidence?: Record<string, number> } }
    | undefined)?.typesafe?.confidence;

  return {
    rows: rows.map(row => ({
      id: row.id,
      name: row.name,
      city: row.city,
      cuisine: row.cuisine,
      award: row.award,
      star: row.star,
      priceBand: row.priceBand,
      lat: row.lat,
      lon: row.lon,
      url: row.url,
      score: answers[row.id]?.score ?? Number.NaN,
      confidence: confidence?.[row.id] ?? null,
      probabilities: answers[row.id]?.probabilities ?? null,
    })),
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  };
}

// Fila com concorrência limitada: 28 lotes de uma vez seria abuso de cortesia.
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function scoreAll(
  rows: Restaurant[],
  request: string,
  apiKey: string,
): Promise<{ rows: ScoredRow[]; meta: ScoringMeta }> {
  const batches: Restaurant[][] = [];
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    batches.push(rows.slice(index, index + BATCH_SIZE));
  }

  const started = performance.now();
  const results = await pool(batches, CONCURRENCY, batch => scoreBatch(batch, request, apiKey));
  const latencyMs = performance.now() - started;
  const inputTokens = results.reduce((sum, entry) => sum + entry.inputTokens, 0);
  const outputTokens = results.reduce((sum, entry) => sum + entry.outputTokens, 0);

  return {
    rows: results.flatMap(entry => entry.rows),
    meta: {
      calls: batches.length,
      latencyMs,
      inputTokens,
      outputTokens,
      costUsd: inputTokens * INPUT_PRICE_PER_TOKEN,
    },
  };
}

export async function rankCandidates(candidates: Restaurant[], request: string, apiKey: string) {
  return scoreAll(candidates, request, apiKey);
}

// Conferência: pontua o catálogo inteiro, sem amostragem nenhuma, para medir o
// que as rodadas deixaram de ver. Ordenar por nota é o que torna isso um
// gabarito — sem a ordenação, o "top 20" seria só as 20 primeiras linhas.
export async function exhaustiveRank(request: string, apiKey: string) {
  const { rows, meta } = await scoreAll(restaurants, request, apiKey);
  rows.sort((a, b) => (b.score - a.score) || ((b.confidence ?? 0) - (a.confidence ?? 0)));
  return { rows, meta };
}
