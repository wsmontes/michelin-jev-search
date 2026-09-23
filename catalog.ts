// Catálogo Michelin: normalização e pool de amostragem.
// Sem funil, sem BM25, sem extração de intenção: a busca é por rodadas de
// amostragem guiada, e o Jev julga cada candidato direto.

import { readFileSync } from 'node:fs';

export type Restaurant = {
  id: string;
  name: string;
  city: string;
  cuisine: string;
  price: string;
  award: string;
  review: string;
  lat: number;
  lon: number;
  url: string;
  priceBand: number;
  star: number;
  region: string;
  cuisineBuckets: string[];
};

type RawRow = Omit<Restaurant, 'priceBand' | 'star' | 'region' | 'cuisineBuckets'>;

const REGION_RULES: Array<{ name: string; test: (lat: number, lon: number) => boolean }> = [
  { name: 'Oceania', test: (lat, lon) => lat < -10 && lon >= 110 },
  { name: 'Ásia Oriental', test: (lat, lon) => lat >= 20 && lon >= 100 && lon <= 155 },
  { name: 'Sudeste Asiático', test: (lat, lon) => lat >= -12 && lat < 20 && lon >= 92 && lon <= 141 },
  { name: 'Sul da Ásia', test: (lat, lon) => lat >= 5 && lat < 40 && lon > 60 && lon <= 92 },
  { name: 'Oriente Médio', test: (lat, lon) => lat >= 12 && lat < 42 && lon >= 25 && lon <= 63 },
  { name: 'Europa', test: (lat, lon) => lat >= 34 && lon >= -25 && lon <= 45 },
  { name: 'África', test: (lat, lon) => lat >= -36 && lat < 36 && lon >= -20 && lon <= 52 },
  { name: 'América do Norte', test: (lat, lon) => lat >= 24 && lon >= -170 && lon <= -50 },
  { name: 'América Latina', test: (lat, lon) => lat < 24 && lon >= -120 && lon <= -30 },
];

// Serve para medir semelhança entre candidatos na amostragem guiada — não para
// filtrar nada. 865 cozinhas distintas viram ~28 grupos comparáveis.
const CUISINE_BUCKETS: Array<{ bucket: string; keywords: string[] }> = [
  { bucket: 'Japonesa', keywords: ['japanese', 'sushi', 'ramen', 'soba', 'izakaya', 'tempura', 'yakitori', 'udon', 'tonkatsu', 'kaiseki', 'omakase', 'kappo', 'unagi', 'anago', 'yakiniku', 'donburi'] },
  { bucket: 'Chinesa', keywords: ['chinese', 'cantonese', 'sichuan', 'shanghai', 'dim sum', 'hakka', 'hunan', 'beijing', 'wonton'] },
  { bucket: 'Coreana', keywords: ['korean', 'kimchi', 'bibimbap'] },
  { bucket: 'Tailandesa', keywords: ['thai'] },
  { bucket: 'Vietnamita', keywords: ['vietnamese', 'pho', 'banh mi'] },
  { bucket: 'Asiática', keywords: ['asian', 'singaporean', 'malaysian', 'indonesian', 'filipino', 'burmese', 'taiwanese', 'hong kong'] },
  { bucket: 'Indiana', keywords: ['indian', 'curry', 'tandoori', 'biryani', 'sri lankan', 'pakistani'] },
  { bucket: 'Francesa', keywords: ['french', 'lyonnaise', 'alsatian', 'provencal', 'bistro', 'brasserie', 'savoyard', 'norman', 'creperie', 'burgundy', 'perigord'] },
  { bucket: 'Italiana', keywords: ['italian', 'pizza', 'pasta', 'apulian', 'puglia', 'sicilian', 'lombard', 'tuscan', 'roman', 'ligurian', 'osteria', 'trattoria', 'piemont', 'neapolitan', 'emilian'] },
  { bucket: 'Espanhola', keywords: ['spanish', 'tapas', 'catalan', 'galician', 'basque', 'andalusian', 'valencian', 'castilian'] },
  { bucket: 'Portuguesa', keywords: ['portuguese', 'alentejo', 'madeira', 'algarve', 'minho'] },
  { bucket: 'Mediterrânea', keywords: ['mediterranean', 'greek', 'cypriot', 'maltese', 'croatian', 'dalmatian', 'istrian'] },
  { bucket: 'Nórdica', keywords: ['nordic', 'scandinavian', 'danish', 'swedish', 'norwegian', 'finnish', 'icelandic'] },
  { bucket: 'Britânica', keywords: ['british', 'irish', 'scottish', 'welsh', 'english', 'pub', 'gastropub'] },
  { bucket: 'Centro-Europeia', keywords: ['german', 'austrian', 'swiss', 'bavarian', 'alpine', 'tyrolean', 'viennese', 'hungarian', 'czech', 'polish', 'slovak', 'slovenian', 'bohemian'] },
  { bucket: 'Leste Europeu', keywords: ['russian', 'ukrainian', 'georgian', 'armenian', 'balkan', 'serbian', 'bulgarian', 'romanian', 'baltic'] },
  { bucket: 'Meio Oriente', keywords: ['lebanese', 'arabic', 'middle eastern', 'turkish', 'persian', 'iranian', 'israeli', 'syrian', 'jordanian', 'egyptian', 'yemeni', 'iraqi'] },
  { bucket: 'Africana', keywords: ['african', 'moroccan', 'tunisian', 'algerian', 'ethiopian', 'south african', 'nigerian', 'senegalese', 'kenyan'] },
  { bucket: 'Mexicana', keywords: ['mexican', 'taco', 'tex-mex', 'oaxacan', 'yucatec', 'burrito', 'antojitos'] },
  { bucket: 'Latino-Americana', keywords: ['peruvian', 'argentinian', 'chilean', 'colombian', 'venezuelan', 'uruguayan', 'ecuadorian', 'bolivian', 'cuban', 'caribbean', 'latin american', 'nikkei', 'ceviche'] },
  { bucket: 'Brasileira', keywords: ['brazilian', 'mineira', 'baiana', 'amazonian', 'moqueca', 'churrasco', 'feijoada'] },
  { bucket: 'Norte-Americana', keywords: ['american', 'californian', 'burger', 'diner', 'soul food', 'cajun', 'creole', 'southern', 'pacific northwest', 'new england', 'hawaiian'] },
  { bucket: 'Carne e Grelhados', keywords: ['steakhouse', 'grill', 'barbecue', 'barbeque', 'meat', 'churrascaria', 'roast', 'charcoal'] },
  { bucket: 'Frutos do Mar', keywords: ['seafood', 'fish', 'oyster', 'crustacean', 'shellfish', 'sashimi', 'clam', 'lobster', 'cod'] },
  { bucket: 'Vegetariana', keywords: ['vegetarian', 'vegan', 'vegetable', 'plant', 'health food', 'gluten'] },
  { bucket: 'Padaria e Doces', keywords: ['bakery', 'pastry', 'dessert', 'chocolate', 'ice cream', 'patisserie', 'confection', 'cake', 'gelato', 'sweet'] },
  { bucket: 'Fusão', keywords: ['fusion', 'asian influences', 'cross', 'mestizo'] },
  { bucket: 'Street Food', keywords: ['street food', 'small eats', 'market cuisine', 'noodle', 'dumpling', 'snack', 'food stall'] },
];

const parsed = JSON.parse(
  readFileSync(new URL('./data/michelin_world.json', import.meta.url), 'utf8'),
) as RawRow[];

const priceBandOf = (price: string) => Math.max(1, Math.min(4, (price.match(/[€$¥£]/g) ?? []).length));
const starOf = (award: string) =>
  award.includes('3 MICHELIN') ? 3 : award.includes('2 MICHELIN') ? 2 : award.includes('1 MICHELIN') ? 1 : 0;
const regionOf = (lat: number, lon: number) =>
  REGION_RULES.find(rule => rule.test(lat, lon))?.name ?? 'Outros';
const bucketsOf = (cuisine: string) => {
  const text = cuisine.toLowerCase();
  const found: string[] = [];
  for (const { bucket, keywords } of CUISINE_BUCKETS) {
    if (keywords.some(keyword => text.includes(keyword)) && !found.includes(bucket)) found.push(bucket);
  }
  return found;
};

export const restaurants: Restaurant[] = parsed.map(row => ({
  ...row,
  priceBand: priceBandOf(row.price),
  star: starOf(row.award),
  region: regionOf(row.lat, row.lon),
  cuisineBuckets: bucketsOf(row.cuisine),
}));

export const byId = new Map(restaurants.map(restaurant => [restaurant.id, restaurant]));

export type Box = { north: number; south: number; east: number; west: number };

// A área desenhada no mapa restringe o universo de amostragem; nada mais filtra.
export function poolFor(box: Box | null): Restaurant[] {
  if (!box) return restaurants;
  return restaurants.filter(restaurant =>
    restaurant.lat >= box.south && restaurant.lat <= box.north
    && restaurant.lon >= box.west && restaurant.lon <= box.east);
}
