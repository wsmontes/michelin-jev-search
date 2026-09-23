# michelin-jev-search

Busca de restaurantes por descrição livre sobre os **6.802 restaurantes** do Guia Michelin, usando o **Jev** (TypeSafe AI) como modelo de decisão e um mapa mundial para explorar o resultado.

O Jev não gera texto: ele responde perguntas tipadas. Aqui cada restaurante vira uma pergunta de **nota 0–5** e a resposta é um número com distribuição de probabilidade por nível. O mapa mostra os 6.802 pontos; arrastar um retângulo restringe a área de onde a busca amostra.

## Como rodar

Precisa de Node 22+ (testado no 26) e de uma chave da TypeSafe.

```bash
npm install
cp .env.example .env.local     # preencha TYPESAFE_AI_API_KEY
npm run serve                  # http://localhost:8788
```

Escreva um pedido em português na caixa de texto e clique em **Buscar por rodadas**. `Conferir tudo` roda a pontuação exaustiva para medir o que a amostragem deixou de fora.

## Por que não cabe numa chamada

O teto da API é de **~64k tokens por requisição**, medido: 250 perguntas de Score = 58.988 tokens passam; 300 = HTTP 400 `max_tokens_exceeded`. Cada pergunta custa **236 tokens** (perfil compacto + 6 níveis de escala). Pontuar os 6.802 exigiria 28 chamadas.

## Como a busca funciona

1. **Rodada 1** — 250 restaurantes sorteados do catálogo (ou da área desenhada no mapa). O Jev dá nota a cada um.
2. **Os 50 melhores** — por nota descontada pela confiança — definem de onde tirar os 250 seguintes.
3. **Rodadas seguintes** — candidatos parecidos com os vencedores sobem na fila: mesma cidade, mesmo grupo de cozinha, mesma faixa de preço, mesma distinção. Um peso base e um sorteio no fim mantêm exploração.
4. **Parada** — quando uma rodada inteira não traz nenhum nome novo ao top-20, ou no limite de rodadas escolhido.

O critério de ordenação é `nota × (1 − peso × (1 − confiança))`. O peso é ajustável na tela; a confiança **só pode derrubar** uma nota, nunca promover (veja abaixo).

## Números medidos

| | busca por rodadas (4) | conferência exaustiva |
|---|---|---|
| restaurantes julgados | 1.000 de 6.802 (14,7%) | 6.802 |
| requisições | 4 | 28 |
| tempo | 2,7–3,5 s | 4,1–4,5 s |
| custo | ~$0,0098 | ~$0,0672 |
| acerto no top-20 real | 15–17 de 20 (75–85%) | — |
| melhor achado na ordem real | 1º | — |

A nota média por rodada sobe conforme o cerco aperta: 0,41 → 1,36 → 1,98 na mesma busca, e essa linha aparece na tela.

## Achado: confiança alta não é mérito

Medido num pedido de japonês: num lote misto o Jev fica com **confiança 0,84** nos restaurantes que ele descarta com certeza (a distribuição concentra no nível 0) e **0,59** entre candidatos bons e parecidos, que disputam probabilidade. Somar confiança como parcela positiva premiava "certamente não serve" e enchia a lista com a rodada aleatória. Por isso ela entra apenas como desconto.

As notas, em si, são estáveis: o mesmo restaurante julgado em lote homogêneo deu nota média 0,79, e em lote misto 0,82 (maior diferença individual 0,14) — dá para comparar entre rodadas.

## Dados

`data/michelin_world.json` — 6.802 registros com nome, cidade, cozinha, preço, distinção (Bib Gourmand / 1–3 estrelas), review, e **coordenadas válidas em 100% dos casos**. Derivado de `Michelin - World - 2023_01_03 - Reviews - not complete 2.csv` do projeto Concierge-Collector.

## Estrutura

| arquivo | papel |
|---|---|
| `catalog.ts` | carrega o catálogo, normaliza preço/estrelas/cozinha e define o pool de amostragem |
| `search.ts` | as rodadas, o critério de seleção e a parada |
| `scoring.ts` | julga em lotes de 250 e roda a conferência exaustiva |
| `server.ts` | `GET /api/catalog` · `POST /api/search` · `POST /api/exhaustive` |
| `public/index.html` | mapa (Leaflet + tiles Esri), caixa de texto, linha do tempo das rodadas |

A chave da TypeSafe fica só no servidor; o navegador nunca a vê.
