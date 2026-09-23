# michelin-jev-search

Free-text restaurant search over the **6,802 restaurants** in the Michelin Guide, using **Jev** (TypeSafe AI) as the decision model and a world map to explore the result.

Jev does not generate text — it answers typed questions. Here each restaurant becomes a **0–5 score question**, and the answer is a number with a probability distribution over the rubric levels. The map shows all 6,802 points; dragging a rectangle narrows the area the search samples from.

## Running it

Requires Node 22+ (tested on 26) and a TypeSafe key ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)).

```bash
npm install
npm run serve                  # http://localhost:8788
```

Paste the key into the **chave da TypeSafe** field at the top of the page. It stays in that browser's `localStorage` and travels with each request to the local server, which forwards it to TypeSafe — the server stores no credential, never logs it and never sends it back to the client. The **esquecer** button clears it.

If you run locally and would rather not paste the key every time, use the environment variable instead:

```bash
cp .env.example .env.local    # fill in TYPESAFE_AI_API_KEY
```

Without that file the server still starts (`--env-file-if-exists`) and uses whatever key the browser sends.

The interface, the rubrics and the sample requests are in Portuguese. Type a request and click **Buscar por rodadas**. **Conferir tudo** runs the exhaustive scoring to measure what the sampling missed.

## Why it does not fit in one call

The API caps at **~64k tokens per request**, measured: 250 Score questions = 58,988 tokens pass; 300 = HTTP 400 `max_tokens_exceeded`. Each question costs **236 tokens** (compact profile + 6 rubric levels). Scoring all 6,802 would take 28 calls.

## How the search works

1. **Round 1** — 250 restaurants drawn at random from the catalogue (or from the rectangle drawn on the map). Jev scores each one.
2. **The top 50** — by score discounted by confidence — decide where the next 250 come from.
3. **Later rounds** — candidates resembling the winners move up the queue: same city, same cuisine group, same price band, same award. A base weight plus a final random draw keep some exploration.
4. **Stopping** — when a whole round brings no new name into the top 20, or at the round limit you chose.

The ordering key is `score × (1 − weight × (1 − confidence))`. The weight is adjustable in the UI; confidence can only **lower** a score, never raise it (see below).

## Measured numbers

| | round-based search (4) | exhaustive check |
|---|---|---|
| restaurants scored | 1,000 of 6,802 (14.7%) | 6,802 |
| requests | 4 | 28 |
| time | 2.7–3.5 s | 4.1–4.5 s |
| cost | ~$0.0098 | ~$0.0672 |
| hit rate on the true top 20 | 15–17 of 20 (75–85%) | — |
| best find in the true order | 1st | — |

The mean score per round rises as the net closes: 0.41 → 1.36 → 1.98 in the same search, and that line is shown in the UI.

## Finding: high confidence is not merit

Measured on a request for quiet, inexpensive Japanese food: in a mixed batch Jev is **0.84 confident** about the restaurants it certainly rejects (the distribution concentrates on level 0) and **0.59 confident** among good, similar candidates competing for probability mass. Adding confidence as a positive term rewarded "certainly does not fit" and filled the list with round-1 items. That is why it only discounts.

The scores themselves are stable: the same restaurant scored a mean of 0.79 in a homogeneous batch and 0.82 in a mixed one (largest individual difference 0.14), so they can be compared across rounds.

## Data

`data/michelin_world.json` — 6,802 records with name, city, cuisine, price, award (Bib Gourmand / 1–3 stars), review, and **valid coordinates in 100% of them**. Derived from `Michelin - World - 2023_01_03 - Reviews - not complete 2.csv` in the Concierge-Collector project.

## Structure

| file | role |
|---|---|
| `catalog.ts` | loads the catalogue, normalises price/stars/cuisine and defines the sampling pool |
| `search.ts` | the rounds, the selection key and the stopping rule |
| `scoring.ts` | scores in batches of 250 and runs the exhaustive check |
| `server.ts` | `GET /api/catalog` · `POST /api/search` · `POST /api/exhaustive` |
| `public/index.html` | map (Leaflet + Esri tiles), request box, round timeline |

The TypeSafe key comes from the browser field and is used only for the duration of each request; the server keeps no copy. `/api/catalog` needs no key at all.
