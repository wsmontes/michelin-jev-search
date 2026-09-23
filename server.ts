// Servidor: catálogo no mapa, busca por rodadas e conferência exaustiva.

import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { restaurants, poolFor, type Box } from './catalog.ts';
import { search, ROUND_SIZE, KEEP_BEST } from './search.ts';
import { exhaustiveRank, BATCH_SIZE } from './scoring.ts';

const PORT = Number(process.env.PORT ?? 8788);

const send = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readJson = async (req: AsyncIterable<unknown>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
};

const points = restaurants.map(restaurant => ({
  id: restaurant.id,
  name: restaurant.name,
  city: restaurant.city,
  cuisine: restaurant.cuisine,
  award: restaurant.award,
  star: restaurant.star,
  priceBand: restaurant.priceBand,
  region: restaurant.region,
  lat: +restaurant.lat.toFixed(4),
  lon: +restaurant.lon.toFixed(4),
  url: restaurant.url,
}));

const parseBox = (value: unknown): Box | null => {
  if (!value || typeof value !== 'object') return null;
  const box = value as Record<string, unknown>;
  const numbers = ['north', 'south', 'east', 'west'].map(key => Number(box[key]));
  return numbers.every(Number.isFinite)
    ? { north: numbers[0], south: numbers[1], east: numbers[2], west: numbers[3] }
    : null;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /' || route === 'GET /index.html') {
    const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }

  if (route === 'GET /api/catalog') {
    send(res, 200, {
      total: points.length,
      roundSize: ROUND_SIZE,
      keepBest: KEEP_BEST,
      batchSize: BATCH_SIZE,
      points,
    });
    return;
  }

  if (route === 'POST /api/search') {
    try {
      const body = await readJson(req);
      const request = String(body.request ?? '').trim();
      if (request.length < 3) {
        send(res, 400, { error: 'Escreva um pedido com pelo menos 3 caracteres.' });
        return;
      }
      const box = parseBox(body.box);
      const rounds = Math.max(1, Math.min(8, Number(body.rounds) || 4));
      const confidenceWeight = Math.max(0, Math.min(1, Number(body.confidenceWeight) || 0));

      const outcome = await search(request, { box, rounds, confidenceWeight });
      console.log(
        `busca: "${request.slice(0, 44)}" → ${outcome.judged} julgados de ${outcome.poolSize} ` +
        `em ${outcome.rounds.length} rodada(s) · parou por ${outcome.stopped} · ` +
        `${outcome.meta.latencyMs.toFixed(0)} ms · $${outcome.meta.costUsd.toFixed(5)}`,
      );

      send(res, 200, {
        request,
        box,
        confidenceWeight,
        rounds: outcome.rounds,
        results: outcome.results.slice(0, 30),
        judgedIds: outcome.results.map(row => row.id),
        judged: outcome.judged,
        poolSize: outcome.poolSize,
        catalogueSize: restaurants.length,
        stopped: outcome.stopped,
        meta: outcome.meta,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`busca falhou: ${message}`);
      send(res, 502, { error: message });
    }
    return;
  }

  if (route === 'POST /api/exhaustive') {
    try {
      const body = await readJson(req);
      const request = String(body.request ?? '').trim();
      const judgedIds = new Set(
        Array.isArray(body.judgedIds) ? (body.judgedIds as string[]).map(String) : [],
      );
      if (request.length < 3) {
        send(res, 400, { error: 'Escreva um pedido com pelo menos 3 caracteres.' });
        return;
      }

      const { rows, meta } = await exhaustiveRank(request);
      const top = rows.slice(0, 20);
      const hits = top.filter(row => judgedIds.has(row.id));
      const bestJudgedPosition = rows.findIndex(row => judgedIds.has(row.id)) + 1;

      console.log(
        `exaustivo: "${request.slice(0, 40)}" → ${meta.calls} chamadas · ` +
        `${(meta.latencyMs / 1000).toFixed(1)} s · $${meta.costUsd.toFixed(4)} · ` +
        `acerto top-20 = ${hits.length}/20`,
      );

      send(res, 200, {
        top,
        recall: {
          judgedSize: judgedIds.size,
          topN: top.length,
          hits: hits.length,
          missed: top
            .filter(row => !judgedIds.has(row.id))
            .map(row => ({ id: row.id, name: row.name, city: row.city, score: +row.score.toFixed(2) })),
          bestJudgedPosition,
        },
        meta,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`exaustivo falhou: ${message}`);
      send(res, 502, { error: message });
    }
    return;
  }

  send(res, 404, { error: `Rota desconhecida: ${route}` });
});

server.listen(PORT, () => {
  console.log(
    `Jev · mundo: ${restaurants.length} restaurantes · rodadas de ${ROUND_SIZE} · ` +
    `os ${KEEP_BEST} melhores guiam a rodada seguinte — http://localhost:${PORT}`,
  );
});
