import AsyncStorage from "@react-native-async-storage/async-storage";
import { nanoid } from "nanoid/non-secure";

import { findIngredientCatalogEntry, IngredientCatalogEntry, IngredientLocale } from "./ingredients/catalog";
import { upsertIngredientCatalogItemsLocally } from "./ingredients/catalogSync";
import { getApiBaseUrl } from "./config/api";

export type MyDayMealSource = "photo" | "text" | "recipe" | "manual";

export type MyDayMealIngredient = {
  name: string;
  quantity: string;
  unit: string;
};

export type MyDayMeal = {
  id: string;
  title: string;
  source: MyDayMealSource;
  createdAt: string;
  dayKey: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  rawInput?: string;
  photoUri?: string;
  recipeId?: string;
  servingMultiplier?: number;
  ingredients?: MyDayMealIngredient[];
};

export const MY_DAY_MEALS_KEY = "myDayMeals";
const API_BASE_URL = getApiBaseUrl() || "http://10.0.2.2:3000";

// Local FoodCatalog fallback for Describe Meal when the synced catalog is missing
// or the backend is unavailable. These should gradually move into catalog data.
const FOOD_HINTS: {
  match: RegExp;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}[] = [
  { match: /\b(chicken|frango|pollo)\b/i, calories: 220, protein: 32, carbs: 0, fat: 8 },
  { match: /\b(salmon|salm[aã]o|salm[oó]n)\b/i, calories: 280, protein: 29, carbs: 0, fat: 18 },
  { match: /\b(egg|eggs|ovo|ovos|huevo|huevos)\b/i, calories: 140, protein: 12, carbs: 1, fat: 10 },
  { match: /\b(rice|arroz)\b/i, calories: 210, protein: 4, carbs: 45, fat: 1 },
  { match: /\b(pasta|massa)\b/i, calories: 320, protein: 11, carbs: 58, fat: 6 },
  { match: /\b(oats|oatmeal|aveia)\b/i, calories: 230, protein: 8, carbs: 40, fat: 5 },
  { match: /\b(yogurt|iogurte|yogur)\b/i, calories: 180, protein: 15, carbs: 20, fat: 4 },
  { match: /\b(salad|salada|ensalada)\b/i, calories: 180, protein: 6, carbs: 18, fat: 9 },
  { match: /\b(banana)\b/i, calories: 105, protein: 1, carbs: 27, fat: 0 },
  { match: /\b(apple|ma[cç][aã]|manzana)\b/i, calories: 95, protein: 0, carbs: 25, fat: 0 },
  { match: /\b(toast|bread|p[aã]o|pan)\b/i, calories: 160, protein: 5, carbs: 28, fat: 3 },
  { match: /\b(coffee|caf[eé])\b/i, calories: 30, protein: 1, carbs: 3, fat: 1 },
];

function clampNumber(value: number, min: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(Math.round(value), min);
}

export function getDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function titleFromInput(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "Meal";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// MealPhraseRules uses these as client-side serving hints after text parsing.
// They are not the long-term source of truth; backend candidates are persisted
// under mealPhraseRules/default/candidates for review and promotion.
const DEFAULT_SERVING_HINTS: {
  match: RegExp;
  quantity: number;
  unit: string;
  countableUnit?: boolean;
}[] = [
  { match: /\b(scrambled eggs|ovo[s]?\s+mexido[s]?|huevos?\s+revueltos?|oeufs?\s+brouill[eé]s?|r[uü]hrei)\b/i, quantity: 100, unit: "g" },
  { match: /\b(yogurt sauce|molho de iogurte)\b/i, quantity: 30, unit: "g" },
  { match: /\b(tomato sauce|molho de tomate|salsa de tomate)\b/i, quantity: 125, unit: "g" },
  { match: /\b(olive oil|azeite|aceite de oliva)\b/i, quantity: 14, unit: "g" },
  { match: /\b(peanut butter|manteiga de amendoim|pasta de amendoim)\b/i, quantity: 16, unit: "g" },
  { match: /\b(butter|manteiga|mantequilla|beurre)\b/i, quantity: 10, unit: "g" },
  { match: /\b(honey|mel|miel)\b/i, quantity: 21, unit: "g" },
  { match: /\b(granola)\b/i, quantity: 40, unit: "g" },
  { match: /\b(low[-\s]?fat yogurt|skim(?:med)? yogurt|light yogurt|iogurte magro|iogurte natural magro)\b/i, quantity: 125, unit: "g" },
  { match: /\b(greek yogurt|iogurte grego|yogur griego)\b/i, quantity: 150, unit: "g" },
  { match: /\b(yogurt|iogurte|yogur)\b/i, quantity: 125, unit: "g" },
  { match: /\b(cottage cheese|queijo cottage|queso cottage|fromage cottage|h[uü]ttenk[aä]se)\b/i, quantity: 150, unit: "g" },
  { match: /\b(berries|berry|frutos vermelhos|berries mix)\b/i, quantity: 80, unit: "g" },
  { match: /\b(strawberr(?:y|ies)|morango|morangos|fresa|fresas)\b/i, quantity: 100, unit: "g" },
  { match: /\b(blueberr(?:y|ies)|mirtilo|mirtilos)\b/i, quantity: 80, unit: "g" },
  { match: /\b(chicken curry|caril de frango|pollo al curry)\b/i, quantity: 180, unit: "g" },
  { match: /\b(breaded chicken|chicken schnitzel|frango panado|pollo empanado)\b/i, quantity: 150, unit: "g" },
  { match: /\b(chicken|frango|pollo)\b/i, quantity: 150, unit: "g" },
  { match: /\b(salmon|salm[aã]o|salm[oó]n)\b/i, quantity: 150, unit: "g" },
  { match: /(?:fillet[s]?|filet[s]?|fil[eé]s?)\b/i, quantity: 150, unit: "g" },
  { match: /\b(tuna|atum|at[uú]n)\b/i, quantity: 120, unit: "g" },
  { match: /\b(chouri[cç]o|lingui[cç]a|sausage|sausages|chorizo|saucisse|wurst)\b/i, quantity: 100, unit: "g" },
  { match: /\b(rice|arroz)\b/i, quantity: 150, unit: "g" },
  { match: /\b(cheese|queijo|queso)\b/i, quantity: 30, unit: "g" },
  { match: /\b(orange juice|juice|sumo|suco|zumo)\b/i, quantity: 200, unit: "ml" },
  { match: /\b(coffee|caf[eé])\b/i, quantity: 200, unit: "ml" },
  { match: /\b(milk|leite|leche|lait|milch)\b/i, quantity: 200, unit: "ml" },
  { match: /\b(cola|coke|refrigerante|refresco)\b/i, quantity: 330, unit: "ml" },
  { match: /\b(soup|sopa|soupe|suppe)\b/i, quantity: 300, unit: "ml" },
  { match: /\b(egg yolk|egg yolks|yolk|yolks|gema|gemas|yema|yemas|eigelb)\b/i, quantity: 18, unit: "g", countableUnit: true },
  { match: /\b(egg white|egg whites|white|whites|clara|claras|eiweiss)\b/i, quantity: 33, unit: "g", countableUnit: true },
  { match: /\b(egg|eggs|ovo|ovos|huevo|huevos)\b/i, quantity: 50, unit: "g", countableUnit: true },
  { match: /\b(pasta|massa)\b/i, quantity: 180, unit: "g" },
  { match: /\b(naan)\b/i, quantity: 70, unit: "g" },
  { match: /\b(wrap|tortilla|tortilha)\b/i, quantity: 60, unit: "g" },
  { match: /\b(bread|toast|toasts|p[aã]o|p[aã]es|pan|panes)\b/i, quantity: 30, unit: "g", countableUnit: true },
  { match: /\b(avocado|abacate|aguacate)\b/i, quantity: 100, unit: "g" },
  { match: /\b(salad|salada|ensalada)\b/i, quantity: 80, unit: "g" },
  { match: /\b(onions?|cebolas?|cebollas?|oignons?|zwiebeln?)\b/i, quantity: 80, unit: "g" },
  { match: /\b(lettuce|alface|lechuga|laitue)\b/i, quantity: 50, unit: "g" },
  { match: /\b(tomato|tomatoes|tomate|tomates)\b/i, quantity: 120, unit: "g" },
  { match: /\b(cucumber|pepino|concombre|gurke)\b/i, quantity: 250, unit: "g" },
  { match: /\b(carrot|carrots|cenoura|cenouras|zanahoria|zanahorias|carotte|carottes|karotte|karotten)\b/i, quantity: 80, unit: "g" },
  { match: /\b(celery stalk|celery|aipo|apio|c[eé]leri|sellerie|selleriestange)\b/i, quantity: 40, unit: "g" },
  { match: /\b(bell pepper|bell peppers|pepper|peppers|piment[aã]o|piment[õo]es|pimiento|pimientos|poivron|poivrons|paprika)\b/i, quantity: 150, unit: "g" },
  { match: /\b(zucchini|courgette|courgettes|curgete|curgetes|calabac[ií]n|calabacines|zucchinis?)\b/i, quantity: 200, unit: "g" },
  { match: /\b(eggplant|aubergine|aubergines|beringela|berenjena)\b/i, quantity: 280, unit: "g" },
  { match: /\b(cabbage|couve|repolho|repollo|choux?|kohl)\b/i, quantity: 250, unit: "g" },
  { match: /\b(lemon|lim[aã]o|lim[oó]n|citron|zitrone|lime|lima)\b/i, quantity: 120, unit: "g" },
  { match: /\b(potato|potatoes|batata|batatas|patata|patatas)\b/i, quantity: 180, unit: "g" },
  { match: /\b(broccoli|br[oó]colos|brocolis|brocoli)\b/i, quantity: 90, unit: "g" },
  { match: /\b(mushroom|mushrooms|cogumelo|cogumelos|champignon|champignons)\b/i, quantity: 80, unit: "g" },
  { match: /\b(corn|milho|ma[ií]z)\b/i, quantity: 80, unit: "g" },
  { match: /\b(beans|feij[aã]o|frijoles|haricots)\b/i, quantity: 130, unit: "g" },
  { match: /\b(breadcrumbs?|bread crumbs?|pan rallado|p[aã]o ralado|chapelure|paniermehl)\b/i, quantity: 40, unit: "g" },
  { match: /\b(puff pastry|massa folhada|massa quebrada|p[aâ]te bris[eé]e|m[uü]rbeteig)\b/i, quantity: 230, unit: "g" },
  { match: /\b(bread slices?|sliced bread|tranches? de pain|tranches? de pain de mie|p[aã]o de forma)\b/i, quantity: 30, unit: "g" },
  { match: /\b(ham|fiambre|presunto|jambon|jam[oó]n|ham slices?|tranches? de jambon|fatias? de presunto|lonchas? de jam[oó]n)\b/i, quantity: 30, unit: "g" },
  { match: /\b(breaded chicken burger|frango panado burger|hamb[uú]rguer de frango panado|hamburguesa de pollo empanado|burger de poulet pan[eé]|paniertes h[aä]hnchen burger|h[aä]hnchen schnitzel burger)\b/i, quantity: 250, unit: "g" },
  { match: /\b(burger|hamburguer|hamburguesa)\b/i, quantity: 150, unit: "g" },
  { match: /\b(tuna sandwich|turkey sandwich|chicken sandwich|sandes? de atum|sandu[ií]che de atum|s[aá]ndwich de at[uú]n|sandwich au thon|thunfischsandwich|sandes? de peru|sandu[ií]che de peru|s[aá]ndwich de pavo|sandwich de dinde|putensandwich)\b/i, quantity: 220, unit: "g" },
  { match: /\b(chicken wrap|wrap de frango|wrap de pollo|wrap poulet|h[aä]hnchen-wrap)\b/i, quantity: 220, unit: "g" },
  { match: /\b(pizza slice|fatia de pizza|porci[oó]n de pizza|part de pizza|pizzast[uü]ck)\b/i, quantity: 120, unit: "g" },
  { match: /\b(pancakes?|panquecas?|tortitas?|cr[eê]pes?|pfannkuchen)\b/i, quantity: 160, unit: "g" },
  { match: /\b(lasagna|lasanha|lasa[ñn]a|lasagnes?|lasagne)\b/i, quantity: 300, unit: "g" },
  { match: /\b(fries|french fries|batatas fritas|frites)\b/i, quantity: 120, unit: "g" },
];

const COUNT_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  três: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  un: 1,
  una: 1,
  une: 1,
  dos: 2,
  deux: 2,
  trois: 3,
  cuatro: 4,
  quatre: 4,
  cinq: 5,
  siete: 7,
  sept: 7,
  ocho: 8,
  huit: 8,
  nueve: 9,
  neuf: 9,
  diez: 10,
  dix: 10,
  ein: 1,
  eine: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  funf: 5,
  fünf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
};

const COUNT_WORD_PATTERN =
  "three|seven|eight|nine|one|two|four|five|six|ten|duas|dois|três|tres|quatro|cinco|seis|sete|oito|nove|dez|uma|um|una|une|un|dos|deux|trois|cuatro|quatre|cinq|siete|sept|ocho|huit|nueve|neuf|diez|dix|eine|ein|zwei|drei|vier|funf|fünf|sechs|sieben|acht|neun|zehn";

function titleCaseIngredientName(input: string) {
  const cleaned = input.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  return cleaned
    .toLowerCase()
    .split(" ")
    .map((word) => {
      if (["de", "da", "do", "dos", "das", "e", "com"].includes(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function localeFromLanguage(language?: string): IngredientLocale | null {
  const normalized = String(language || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("pt-br")) return "pt-BR";
  if (normalized.startsWith("pt")) return "pt-PT";
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("fr")) return "fr";
  if (normalized.startsWith("de")) return "de";
  return "en";
}

function displayNameForCatalogEntry(
  entry: IngredientCatalogEntry | null | undefined,
  fallback: string,
  language?: string
) {
  if (!entry) return titleCaseIngredientName(fallback);
  const locale = localeFromLanguage(language);
  const localizedAlias = locale ? entry.aliases?.[locale]?.[0] : null;
  return titleCaseIngredientName(localizedAlias || entry.canonicalName || fallback);
}

function mergeDuplicateIngredients(items: MyDayMealIngredient[]) {
  const merged = new Map<string, MyDayMealIngredient>();

  for (const item of items) {
    const key = `${item.name.trim().toLowerCase()}::${item.unit.trim().toLowerCase()}`;
    const quantity = Number(String(item.quantity).replace(",", "."));
    if (!merged.has(key)) {
      merged.set(key, { ...item });
      continue;
    }

    const existing = merged.get(key)!;
    const existingQuantity = Number(String(existing.quantity).replace(",", "."));
    if (Number.isFinite(quantity) && Number.isFinite(existingQuantity)) {
      existing.quantity = String(Math.round((existingQuantity + quantity) * 100) / 100);
    }
  }

  return Array.from(merged.values());
}

function resolveIngredientCatalogEntry(name: string) {
  return findIngredientCatalogEntry(name);
}

function defaultServingForIngredient(name: string) {
  const candidates = [
    name,
    name.replace(/\b(\w+?)oes\b/gi, "$1o"),
    name.replace(/\b(\w+?)ies\b/gi, "$1y"),
    name.replace(/\b(\w+?)es\b/gi, "$1"),
    name.replace(/\b(\w+?)s\b/gi, "$1"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const match = DEFAULT_SERVING_HINTS.find((hint) => hint.match.test(candidate));
    if (match) {
      return match;
    }
  }

  const catalogEntry =
    resolveIngredientCatalogEntry(name) ||
    candidates.slice(1).map((candidate) => resolveIngredientCatalogEntry(candidate)).find(Boolean);
  if (catalogEntry?.defaultServing) {
    return catalogEntry.defaultServing;
  }
  return null;
}

export function getDefaultServingForIngredient(name: string) {
  return defaultServingForIngredient(name);
}

function stripLeadingQuantity(text: string) {
  return text
    .trim()
    .replace(/^(\d+(?:[.,]\d+)?)\s*(kg|g|mg|ml|l)\s*(?:of\s+|de\s+|da\s+|do\s+|d['’]\s*|von\s+)?/i, "")
    .replace(/^(\d+(?:[.,]\d+)?)\s*(?:x\s*)?(?:of\s+|de\s+|da\s+|do\s+|d['’]\s*|von\s+)?/i, "")
    .replace(/^(a|an|the)\s+/i, "")
    .replace(/^(um|uma|uns|umas|un|una|unos|unas|une|des|le|la|les|ein|eine|der|die|das)\s+/i, "")
    .trim();
}

function normalizeIngredientBaseName(text: string) {
  const cleaned = text
    .trim()
    .replace(/\b(junto|together)\b\s*$/i, "")
    .replace(/^(?:al[eé]m\s+disso|alem\s+disso|additionally|also|aussi|zus[aä]tzlich|dazu)\s+/i, "")
    .replace(/^(?:um|uma|uns|umas|un|una|unos|unas|une|des|le|la|les|ein|eine|der|die|das)\s+/i, "")
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(/^(?:some|maybe|more)\s+/i, "")
    .replace(/^(?:a\s+little|little)\s+/i, "")
    .replace(/^(?:a\s+bit\s+of|bit\s+of)\s+/i, "")
    .replace(/^(?:a\s+handful\s+of|handful\s+of)\s+/i, "")
    .replace(/^(?:a\s+piece\s+of|piece\s+of)\s+/i, "")
    .replace(/^(?:a\s+slice\s+of|slice\s+of)\s+/i, "")
    .replace(/^(?:a\s+bowl\s+of|bowl\s+of)\s+/i, "")
    .replace(/^(?:a\s+tuna\s+sandwich)$/i, "tuna sandwich")
    .replace(new RegExp(`^(?:${COUNT_WORD_PATTERN})\\s+`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();

  const dedupedWords = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((word, index, arr) => index === 0 || word.toLowerCase() !== arr[index - 1].toLowerCase())
    .map((word) => word.toLowerCase());

  return dedupedWords.join(" ").trim();
}

function parseSpecialQuantityPrefix(part: string) {
  const rules: { regex: RegExp; multiplier: number }[] = [
    { regex: /^(?:a\s+)?half\s+(.+)$/i, multiplier: 0.5 },
    { regex: /^(?:a\s+little|little)\s+(.+)$/i, multiplier: 0.5 },
    { regex: /^(?:a\s+)?handful\s+of\s+(.+)$/i, multiplier: 0.5 },
    { regex: /^(?:um|uma)\s+punhado\s+de\s+(.+)$/i, multiplier: 0.5 },
    { regex: /^(?:un|une)\s+poign[eé]e\s+d['’]?\s*(.+)$/i, multiplier: 0.5 },
    { regex: /^(?:ein|eine)\s+handvoll\s+(.+)$/i, multiplier: 0.5 },
    { regex: /^(?:a\s+)?piece\s+of\s+(.+)$/i, multiplier: 1 },
    { regex: /^(?:um|uma)\s+peda[cç]o\s+de\s+(.+)$/i, multiplier: 1 },
    { regex: /^(?:a\s+)?slice\s+of\s+(.+)$/i, multiplier: 1 },
    { regex: /^(?:um|uma)\s+fatia\s+de\s+(.+)$/i, multiplier: 1 },
    { regex: /^(?:un|une)\s+tranche\s+de\s+(.+)$/i, multiplier: 1 },
    { regex: /^(?:ein|eine)\s+scheibe\s+(.+)$/i, multiplier: 1 },
    { regex: /^(?:a\s+)?bowl\s+of\s+(.+)$/i, multiplier: 1 },
    { regex: /^(?:um|uma)\s+tigela\s+de\s+(.+)$/i, multiplier: 1 },
    { regex: /^(?:un|une)\s+bol\s+de\s+(.+)$/i, multiplier: 1 },
    { regex: /^(?:a\s+)?bit\s+of\s+(.+)$/i, multiplier: 0.75 },
    { regex: /^(?:some)\s+(.+)$/i, multiplier: 1 },
    { regex: /^(?:maybe)\s+(.+)$/i, multiplier: 1 },
  ];

  for (const rule of rules) {
    const match = part.match(rule.regex);
    if (match) {
      return {
        baseName: normalizeIngredientBaseName(match[1] || part),
        multiplier: rule.multiplier,
      };
    }
  }

  return null;
}

function hasExplicitQuantity(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;

  return (
    /^(\d+(?:[.,]\d+)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*(kg|g|mg|ml|l|oz|lb|lbs|cup|cups|tbsp|tsp|tablespoon|tablespoons|teaspoon|teaspoons|c\.?\s*sopa|c\.?\s*chá|colher(?:es)?\s+de\s+sopa|colher(?:es)?\s+de\s+chá|cucharadas?|cucharaditas?|cuill[eè]res?\s+à\s+soupe|cuill[eè]res?\s+à\s+caf[eé]|esslöffel|teelöffel|el|tl|x)?\b/i.test(trimmed) ||
    new RegExp(`^(?:${COUNT_WORD_PATTERN})\\b`, "i").test(trimmed) ||
    /^(?:a\s+)?(?:half|little|handful|piece|slice|bowl|bit)\b/i.test(trimmed) ||
    /^(?:um|uma)\s+(?:meio|meia|pouco|punhado|peda[cç]o|fatia|tigela)\b/i.test(trimmed)
  );
}

function isPluralServingPhrase(name: string, serving: { match?: RegExp; countableUnit?: boolean }) {
  if (!serving.countableUnit || !serving.match) return false;
  const match = serving.match;

  const tokens = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  return tokens.some((token) => token.length > 2 && token.endsWith("s") && match.test(token));
}

function quantityForImplicitServing(name: string, serving: { match?: RegExp; quantity: number; countableUnit?: boolean }) {
  const multiplier = isPluralServingPhrase(name, serving) ? 2 : 1;
  return Math.round(serving.quantity * multiplier);
}

function joinTitleSegments(parts: string[]) {
  if (parts.length === 0) return "Meal";
  if (parts.length === 1) return titleFromInput(parts[0]);
  if (parts.length === 2) return `${titleFromInput(parts[0])} and ${parts[1].toLowerCase()}`;
  return `${titleFromInput(parts.slice(0, -1).join(", "))} and ${parts[parts.length - 1].toLowerCase()}`;
}

export function buildMealTitleFromInput(input: string) {
  const parts = splitMealTextParts(input)
    .map((part) => normalizeIngredientBaseName(stripLeadingQuantity(part)))
    .filter((part) => part.length > 1)
    .filter((part, index, array) => array.findIndex((candidate) => candidate === part) === index)
    .slice(0, 5);

  if (parts.length === 0) return titleFromInput(input.trim());

  const hasSingleWithPhrase = /\bwith\b/i.test(input) && !/[;,]/.test(input);
  if (hasSingleWithPhrase && parts.length >= 2) {
    const [first, ...rest] = parts;
    return `${titleFromInput(first)} with ${joinTitleSegments(rest).toLowerCase()}`;
  }

  return joinTitleSegments(parts);
}

function normalizeCompositeMealPhrases(input: string) {
  return input.replace(
    /\b(hamburger|hamburguer|hamb[uú]rguer|hamburguesa|burger)\s+(with|com|con|avec|mit)\s+(breaded chicken|frango panado|pollo empanado|poulet pan[eé]|paniertes h[aä]hnchen|h[aä]hnchen schnitzel)\b/gi,
    (_match, burger, _connector, filling) => {
      const normalizedBurger = String(burger).toLowerCase();
      const normalizedFilling = String(filling).toLowerCase();
      if (/hamburguesa/.test(normalizedBurger)) return "hamburguesa de pollo empanado";
      if (/hamb[uú]rguer|hamburguer/.test(normalizedBurger)) return "hambúrguer de frango panado";
      if (/poulet/.test(normalizedFilling)) return "burger de poulet pané";
      if (/h[aä]hnchen|schnitzel/.test(normalizedFilling)) return "paniertes hähnchen burger";
      return "breaded chicken burger";
    }
  );
}

export function splitMealTextParts(input: string) {
  const normalized = normalizeCompositeMealPhrases(input)
    .replace(/\s+/g, " ")
    .replace(/\b(with also|along with|served with|junto com|juntamente com|al[eé]m disso|acompa[nñ]ado de|servi(?:do)? avec|accompagn[eé] de|avec aussi|serviert mit|dazu)\b/gi, ",")
    .replace(/\b(and|with|also|plus|e|com|y|con|et|avec|aussi|und|mit|auch)\b/gi, ",")
    .trim();

  return normalized
    .split(/,|;/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 8);
}

export function parseMealTextIngredients(input: string, language?: string): MyDayMealIngredient[] {
  const parts = splitMealTextParts(input);

  return mergeDuplicateIngredients(parts.map((part) => {
    const explicitWeightMatch = part.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|mg|ml|l)\s*(?:of\s+|de\s+|da\s+|do\s+|d['’]\s*|von\s+)?(.+)$/i);
    if (explicitWeightMatch) {
      const [, quantity, unit, rawName] = explicitWeightMatch;
      const baseName = normalizeIngredientBaseName(stripLeadingQuantity(rawName));
      const catalogEntry = resolveIngredientCatalogEntry(baseName);
      return {
        name: displayNameForCatalogEntry(catalogEntry, baseName, language),
        quantity: quantity.replace(",", "."),
        unit: unit.toLowerCase(),
      };
    }

    const specialPrefix = parseSpecialQuantityPrefix(part);
    if (specialPrefix) {
      const catalogEntry = resolveIngredientCatalogEntry(specialPrefix.baseName);
      const serving = defaultServingForIngredient(specialPrefix.baseName);
      return {
        name: displayNameForCatalogEntry(catalogEntry, specialPrefix.baseName, language),
        quantity: String(Math.round((serving?.quantity ?? 100) * specialPrefix.multiplier)),
        unit: serving?.unit ?? "g",
      };
    }

    const countMatch = part.match(
      new RegExp(`^(\\d+(?:[.,]\\d+)?|${COUNT_WORD_PATTERN})\\s*(?:x\\s*)?(?:of\\s+|de\\s+|da\\s+|do\\s+|d['’]\\s*|von\\s+)?(.+)$`, "i")
    );
    if (countMatch) {
      const [, countRaw, rawName] = countMatch;
      const normalizedCountRaw = countRaw.toLowerCase();
      const count =
        COUNT_WORDS[normalizedCountRaw] ??
        Number(countRaw.replace(",", "."));
      const baseName = normalizeIngredientBaseName(stripLeadingQuantity(rawName));
      const catalogEntry = resolveIngredientCatalogEntry(baseName);
      const serving = defaultServingForIngredient(baseName);
      return {
        name: displayNameForCatalogEntry(catalogEntry, baseName, language),
        quantity: serving
          ? String(Math.round((Number.isFinite(count) ? count : 1) * serving.quantity))
          : String(Number.isFinite(count) ? count : 1),
        unit: serving?.unit || "serving",
      };
    }

    const baseName = normalizeIngredientBaseName(stripLeadingQuantity(part));
    const catalogEntry = resolveIngredientCatalogEntry(baseName);
    const serving = defaultServingForIngredient(baseName);
    return {
      name: displayNameForCatalogEntry(catalogEntry, baseName, language),
      quantity: serving ? String(quantityForImplicitServing(baseName, serving)) : "1",
      unit: serving?.unit || "serving",
    };
  }));
}

export function splitMealTextIntoIngredients(input: string) {
  const parsed = parseMealTextIngredients(input).map((item) => item.name).filter(Boolean);
  if (parsed.length > 0) return parsed;
  const fallback = input.trim();
  return fallback ? [fallback] : [];
}

function buildEntryMap(entries: IngredientCatalogEntry[]) {
  return entries.reduce<Record<string, IngredientCatalogEntry>>((acc, entry) => {
    if (!entry?.canonicalName) return acc;
    acc[entry.canonicalName.trim().toLowerCase()] = entry;
    return acc;
  }, {});
}

function estimateMealNutrition(
  input: string,
  parsedIngredients: MyDayMealIngredient[],
  extraEntries?: IngredientCatalogEntry[]
) {
  const normalized = input.trim();
  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  let unmatchedFallbackCount = 0;
  const extraEntryMap = buildEntryMap(extraEntries || []);

  if (parsedIngredients.length === 0) {
    return {
      title: buildMealTitleFromInput(normalized),
      calories: 220,
      protein: 10,
      carbs: 24,
      fat: 8,
    };
  }

  for (const ingredient of parsedIngredients) {
    const catalogEntry =
      resolveIngredientCatalogEntry(ingredient.name) ||
      extraEntryMap[ingredient.name.trim().toLowerCase()] ||
      null;
    if (!catalogEntry) continue;
    const servingAmount = resolveIngredientAmountForNutrition(ingredient, catalogEntry);
    if (!servingAmount || servingAmount <= 0) continue;

    const multiplier = servingAmount / 100;
    calories += catalogEntry.nutritionPer100.calories * multiplier;
    protein += catalogEntry.nutritionPer100.protein * multiplier;
    carbs += catalogEntry.nutritionPer100.carbs * multiplier;
    fat += catalogEntry.nutritionPer100.fat * multiplier;
  }

  for (const ingredient of parsedIngredients) {
    const ingredientText = ingredient.name;
    const hasCatalogMatch =
      resolveIngredientCatalogEntry(ingredientText) ||
      extraEntryMap[ingredientText.trim().toLowerCase()] ||
      null;
    if (hasCatalogMatch) continue;

    let matchedHint = false;
    for (const hint of FOOD_HINTS) {
      if (!hint.match.test(ingredientText)) continue;
      calories += hint.calories;
      protein += hint.protein;
      carbs += hint.carbs;
      fat += hint.fat;
      matchedHint = true;
      break;
    }

    if (!matchedHint) unmatchedFallbackCount += 1;
  }

  if (unmatchedFallbackCount > 0) {
    calories += unmatchedFallbackCount * 120;
    protein += unmatchedFallbackCount * 5;
    carbs += unmatchedFallbackCount * 12;
    fat += unmatchedFallbackCount * 4;
  }

  return {
    title: buildMealTitleFromInput(normalized),
    calories: clampNumber(calories, 120),
    protein: clampNumber(protein, 5),
    carbs: clampNumber(carbs, 8),
    fat: clampNumber(fat, 3),
  };
}

export function estimateMealFromText(input: string) {
  const parsedIngredients = parseMealTextIngredients(input);
  return estimateMealNutrition(input, parsedIngredients);
}

function convertUnitToNutritionBase(
  quantity: number,
  unit: string,
  nutritionUnit: "g" | "ml"
) {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const normalizedUnit = unit.toLowerCase();

  if (nutritionUnit === "g") {
    if (normalizedUnit === "g") return quantity;
    if (normalizedUnit === "kg") return quantity * 1000;
    if (normalizedUnit === "mg") return quantity / 1000;
    return null;
  }

  if (normalizedUnit === "ml") return quantity;
  if (normalizedUnit === "l") return quantity * 1000;
  return null;
}

function resolveIngredientAmountForNutrition(
  ingredient: MyDayMealIngredient,
  catalogEntry: IngredientCatalogEntry
) {
  const quantity = Number(String(ingredient.quantity).replace(",", "."));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  const direct = convertUnitToNutritionBase(
    quantity,
    ingredient.unit,
    catalogEntry.nutritionPer100.unit
  );
  if (direct !== null) return direct;

  return null;
}

function normalizeFoodText(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function clampRuntimeResolvedQuantity(
  quantity: any,
  entry: IngredientCatalogEntry,
  sourceText: string,
  fallback: MyDayMealIngredient
) {
  const rawQuantity = Number(quantity?.quantity);
  const rawUnit = String(quantity?.unit || fallback.unit || "g").toLowerCase();
  const base = {
    quantity: Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : Number(fallback.quantity) || 1,
    unit: rawUnit,
  };
  const text = normalizeFoodText(
    `${sourceText} ${fallback.name} ${entry.canonicalName || ""} ${Object.values(entry.aliases || {}).flat().join(" ")}`
  );

  const isOil =
    /\b(olive oil|oil|azeite|aceite|huile|olivenol)\b/.test(text) &&
    !/\b(coconut oil|coconut milk|leite de coco)\b/.test(text);
  const isTinyOil = /\b(fio de|drizzle of|splash of|dash of|chorrito de|filet d['’]?|q\.?\s*b\.?|quanto baste|as needed|to taste)\b/.test(text);
  if (isOil && isTinyOil) return { quantity: 5, unit: base.unit === "ml" ? "ml" : "g" };
  if (isOil && ["g", "ml"].includes(base.unit) && base.quantity > 20) {
    return { quantity: 14, unit: base.unit };
  }

  const isEggYolk = /\b(egg yolks?|yolks?|gema|gemas|eigelb|yema|yemas|jaune)\b/.test(text);
  if (isEggYolk && ["g", "ml"].includes(base.unit) && base.quantity > 30) {
    return { quantity: 18, unit: "g" };
  }

  const isEggWhite = /\b(egg whites?|whites?|clara|claras|eiweiss|blanc d oeuf)\b/.test(text);
  if (isEggWhite && ["g", "ml"].includes(base.unit) && base.quantity > 50) {
    return { quantity: 33, unit: "g" };
  }

  const isWholeEgg = /\b(eggs?|ovos?|huevos?|oeufs?|eier?)\b/.test(text);
  const isPreparedEggServing =
    /\b(scrambled eggs|ovo[s]? mexido[s]?|huevos? revueltos?|oeufs? brouilles?|rührei|ruhrei|boiled eggs|ovos? cozidos?|huevos? cocidos?|oeufs? durs?|gekochte eier)\b/.test(text);
  if (isWholeEgg && isPreparedEggServing && ["g", "ml"].includes(base.unit) && base.quantity < 90) {
    return { quantity: 100, unit: "g" };
  }
  if (isWholeEgg && ["g", "ml"].includes(base.unit) && base.quantity > 80) {
    return { quantity: 50, unit: "g" };
  }

  return base;
}

type ResolvedMealEstimate = ReturnType<typeof estimateMealFromText> & {
  ingredients: MyDayMealIngredient[];
  usedAiFallback: boolean;
};

function hasAmbiguousMealConnector(input: string) {
  return /\b(com|with|con|avec|mit)\b/i.test(input);
}

function hasAwkwardParsedIngredientName(name: string) {
  const normalized = normalizeFoodText(name).trim();
  return (
    /^(de|da|do|das|dos|d|e|and|with|com|con|avec|mit)\b/.test(normalized) ||
    /\b(de|da|do|das|dos|d|e)$/i.test(normalized)
  );
}

function hasNutritionConvertibleUnit(ingredient: MyDayMealIngredient, entry?: IngredientCatalogEntry | null) {
  const quantity = Number(String(ingredient.quantity).replace(",", "."));
  const nutritionUnit = entry?.nutritionPer100?.unit === "ml" ? "ml" : "g";
  return convertUnitToNutritionBase(quantity, ingredient.unit, nutritionUnit) !== null;
}

function shouldResolveMealTextWithAi(input: string, baseIngredients: MyDayMealIngredient[]) {
  if (baseIngredients.length === 0) return true;

  const unknowns = baseIngredients.filter((ingredient) => !resolveIngredientCatalogEntry(ingredient.name));
  const awkwardNames = baseIngredients.some((ingredient) => hasAwkwardParsedIngredientName(ingredient.name));
  const nonConvertibleUnits = baseIngredients.some((ingredient) => {
    const entry = resolveIngredientCatalogEntry(ingredient.name);
    return !hasNutritionConvertibleUnit(ingredient, entry);
  });

  if (awkwardNames || nonConvertibleUnits) return true;
  if (unknowns.length > 0) return true;
  if (hasAmbiguousMealConnector(input) && unknowns.length > 0) return true;

  return false;
}

function sanitizeResolvedMealIngredient(item: any): MyDayMealIngredient | null {
  const name = titleCaseIngredientName(String(item?.name || "").trim()).slice(0, 80);
  const quantity = Number(item?.quantity);
  const unit = String(item?.unit || "").trim().toLowerCase();
  if (!name || !Number.isFinite(quantity) || quantity <= 0) return null;
  if (unit !== "g" && unit !== "ml") return null;
  return {
    name,
    quantity: String(Math.round(quantity * 10) / 10),
    unit,
  };
}

async function resolveMealTextWithAi(
  input: string,
  baseIngredients: MyDayMealIngredient[],
  language?: string
): Promise<ResolvedMealEstimate | null> {
  const response = await fetch(`${API_BASE_URL}/meals/text/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input,
      language,
      parsedIngredients: baseIngredients,
    }),
  });

  if (!response.ok) throw new Error(`Meal text resolve failed (${response.status})`);
  const data = await response.json().catch(() => null);
  const ingredients = Array.isArray(data?.ingredients)
    ? data.ingredients.map(sanitizeResolvedMealIngredient).filter(Boolean) as MyDayMealIngredient[]
    : [];
  const nutrition = data?.nutrition || {};
  if (ingredients.length === 0) return null;

  return {
    title: titleFromInput(String(data?.title || input)),
    calories: clampNumber(Number(nutrition.calories), 120),
    protein: clampNumber(Number(nutrition.protein), 5),
    carbs: clampNumber(Number(nutrition.carbs), 8),
    fat: clampNumber(Number(nutrition.fat), 3),
    ingredients,
    usedAiFallback: true,
  };
}

async function resolveIngredientsWithAiFallback(
  baseIngredients: MyDayMealIngredient[],
  sourceTexts: string[],
  language?: string
): Promise<{
  ingredients: MyDayMealIngredient[];
  usedAiFallback: boolean;
  localEntries: IngredientCatalogEntry[];
}> {
  const unknownItems = baseIngredients
    .map((ingredient, index) => ({
      ingredient,
      sourceText: sourceTexts[index] || ingredient.name,
    }))
    .filter(
      (entry) =>
        !resolveIngredientCatalogEntry(entry.ingredient.name)
    );

  if (unknownItems.length === 0) {
    return {
      ingredients: baseIngredients,
      usedAiFallback: false,
      localEntries: [],
    };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/ingredients/runtime/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language,
        ingredients: unknownItems.map((entry) => ({
          sourceText: entry.sourceText,
          name: entry.ingredient.name,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Ingredient resolve failed (${response.status})`);
    }

    const data = await response.json().catch(() => null);
    const resolvedItems: any[] = Array.isArray(data?.items) ? data.items : [];
    const localEntries = resolvedItems
      .map((item) => item?.localEntry)
      .filter(Boolean) as IngredientCatalogEntry[];

    if (localEntries.length > 0) {
      await upsertIngredientCatalogItemsLocally(localEntries);
    }

    const resolvedBySource = resolvedItems.reduce((acc: Record<string, any>, item: any) => {
      const key = String(item?.sourceText || "").trim().toLowerCase();
      if (key) acc[key] = item;
      return acc;
    }, {});

    const nextIngredients = baseIngredients.map((ingredient, index) => {
      const sourceText = (sourceTexts[index] || ingredient.name).trim().toLowerCase();
      const resolved = resolvedBySource[sourceText];
      if (!resolved?.localEntry || !resolved?.resolvedQuantity) return ingredient;
      const preserveLocalQuantity =
        hasExplicitQuantity(sourceText) &&
        convertUnitToNutritionBase(
          Number(String(ingredient.quantity).replace(",", ".")),
          ingredient.unit,
          resolved.localEntry.nutritionPer100?.unit === "ml" ? "ml" : "g"
        ) !== null;
      const resolvedQuantity = clampRuntimeResolvedQuantity(
        resolved.resolvedQuantity,
        resolved.localEntry,
        sourceTexts[index] || ingredient.name,
        ingredient
      );
      return {
        name: displayNameForCatalogEntry(resolved.localEntry, ingredient.name, language),
        quantity: preserveLocalQuantity ? ingredient.quantity : String(resolvedQuantity.quantity),
        unit: preserveLocalQuantity ? ingredient.unit : String(resolvedQuantity.unit || ingredient.unit).toLowerCase(),
      };
    });

    return {
      ingredients: nextIngredients,
      usedAiFallback: resolvedItems.length > 0,
      localEntries,
    };
  } catch {
    return {
      ingredients: baseIngredients,
      usedAiFallback: false,
      localEntries: [],
    };
  }
}

export async function resolveStructuredMealEstimate(
  input: string,
  baseIngredients: MyDayMealIngredient[],
  sourceTexts: string[],
  language?: string
): Promise<ResolvedMealEstimate> {
  const resolved = await resolveIngredientsWithAiFallback(baseIngredients, sourceTexts, language);

  return {
    ...estimateMealNutrition(input, resolved.ingredients, resolved.localEntries),
    ingredients: resolved.ingredients,
    usedAiFallback: resolved.usedAiFallback,
  };
}

export async function resolveMealEstimate(input: string, language?: string): Promise<ResolvedMealEstimate> {
  const baseIngredients = parseMealTextIngredients(input, language);
  const parts = splitMealTextParts(input);
  if (shouldResolveMealTextWithAi(input, baseIngredients)) {
    try {
      const aiEstimate = await resolveMealTextWithAi(input, baseIngredients, language);
      if (aiEstimate) return aiEstimate;
    } catch {
      // Fall through to the structured ingredient resolver below.
    }
  }
  return resolveStructuredMealEstimate(input, baseIngredients, parts, language);
}

export async function loadMyDayMeals(): Promise<MyDayMeal[]> {
  try {
    const raw = await AsyncStorage.getItem(MY_DAY_MEALS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveMyDayMeals(meals: MyDayMeal[]): Promise<void> {
  await AsyncStorage.setItem(MY_DAY_MEALS_KEY, JSON.stringify(meals));
}

export async function addTextMeal(input: string, date = new Date()): Promise<MyDayMeal> {
  const meals = await loadMyDayMeals();
  const estimate = estimateMealFromText(input);
  const meal: MyDayMeal = {
    id: nanoid(),
    title: estimate.title,
    source: "text",
    createdAt: date.toISOString(),
    dayKey: getDayKey(date),
    calories: estimate.calories,
    protein: estimate.protein,
    carbs: estimate.carbs,
    fat: estimate.fat,
    rawInput: input.trim(),
    ingredients: parseMealTextIngredients(input),
  };

  const nextMeals = [meal, ...meals].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  await saveMyDayMeals(nextMeals);
  return meal;
}

export async function addRecipeMeal(
  input: {
    recipeId: string;
    title: string;
    servingMultiplier: number;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    ingredients?: MyDayMealIngredient[];
  },
  date = new Date()
): Promise<MyDayMeal> {
  const meals = await loadMyDayMeals();
  const meal: MyDayMeal = {
    id: nanoid(),
    title: input.title,
    source: "recipe",
    createdAt: date.toISOString(),
    dayKey: getDayKey(date),
    calories: clampNumber(input.calories, 80),
    protein: clampNumber(input.protein, 4),
    carbs: clampNumber(input.carbs, 6),
    fat: clampNumber(input.fat, 3),
    recipeId: input.recipeId,
    servingMultiplier: input.servingMultiplier,
    ingredients: input.ingredients,
  };

  const nextMeals = [meal, ...meals].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  await saveMyDayMeals(nextMeals);
  return meal;
}

export async function addPhotoMeal(
  input: {
    title: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    photoUri?: string;
    ingredients?: MyDayMealIngredient[];
  },
  date = new Date()
): Promise<MyDayMeal> {
  const meals = await loadMyDayMeals();
  const meal: MyDayMeal = {
    id: nanoid(),
    title: input.title,
    source: "photo",
    createdAt: date.toISOString(),
    dayKey: getDayKey(date),
    calories: clampNumber(input.calories, 0),
    protein: clampNumber(input.protein, 0),
    carbs: clampNumber(input.carbs, 0),
    fat: clampNumber(input.fat, 0),
    photoUri: typeof input.photoUri === "string" && input.photoUri.trim() ? input.photoUri.trim() : undefined,
    ingredients: input.ingredients,
  };

  const nextMeals = [meal, ...meals].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  await saveMyDayMeals(nextMeals);
  return meal;
}

export async function removeMeal(mealId: string): Promise<void> {
  const meals = await loadMyDayMeals();
  await saveMyDayMeals(meals.filter((meal) => meal.id !== mealId));
}

export async function updateMeal(
  mealId: string,
  updates: Partial<Pick<MyDayMeal, "title" | "calories" | "protein" | "carbs" | "fat" | "servingMultiplier" | "ingredients">>
): Promise<void> {
  const meals = await loadMyDayMeals();
  const next = meals.map((meal) => {
    if (meal.id !== mealId) return meal;
    return {
      ...meal,
      ...updates,
      calories:
        updates.calories !== undefined ? clampNumber(updates.calories, 0) : meal.calories,
      protein:
        updates.protein !== undefined ? clampNumber(updates.protein, 0) : meal.protein,
      carbs:
        updates.carbs !== undefined ? clampNumber(updates.carbs, 0) : meal.carbs,
      fat: updates.fat !== undefined ? clampNumber(updates.fat, 0) : meal.fat,
    };
  });
  await saveMyDayMeals(next);
}

export function getMealsForDay(meals: MyDayMeal[], dayKey: string): MyDayMeal[] {
  return meals
    .filter((meal) => meal.dayKey === dayKey)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
