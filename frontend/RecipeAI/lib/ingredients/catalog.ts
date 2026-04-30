export const SUPPORTED_INGREDIENT_LOCALES = [
  "en",
  "pt-PT",
  "pt-BR",
  "es",
  "fr",
  "de",
] as const;

export type IngredientLocale = (typeof SUPPORTED_INGREDIENT_LOCALES)[number];

export type IngredientServingUnit =
  | "g"
  | "kg"
  | "ml"
  | "l"
  | "unit"
  | "slice"
  | "cup"
  | "tbsp"
  | "tsp";

export type IngredientCatalogSource =
  | "seed"
  | "imported"
  | "ai_promoted"
  | "ai_resolved"
  | "manual";

export interface IngredientNutritionPer100 {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  unit: "g" | "ml";
}

export interface IngredientDefaultServing {
  quantity: number;
  unit: IngredientServingUnit;
}

export interface IngredientCatalogEntry {
  id: string;
  canonicalName: string;
  category?: string | null;
  aliases: Record<IngredientLocale, string[]>;
  nutritionPer100: IngredientNutritionPer100;
  defaultServing: IngredientDefaultServing;
  source: IngredientCatalogSource;
  updatedAt: number;
}

export interface IngredientCatalogManifest {
  version: string;
  updatedAt: number;
  locales: IngredientLocale[];
  itemCount: number;
  checksum?: string | null;
}

export interface IngredientCatalogCandidate {
  id?: string;
  canonicalName: string;
  category?: string | null;
  aliases: Partial<Record<IngredientLocale, string[]>>;
  nutritionPer100: IngredientNutritionPer100;
  defaultServing: IngredientDefaultServing;
  suggestedBy: "ai";
  createdAt: number;
  confidence?: number | null;
  sourceText?: string | null;
}

export const INGREDIENT_CATALOG_MANIFEST_KEY = "ingredientCatalogManifest";
export const INGREDIENT_CATALOG_ITEMS_KEY = "ingredientCatalogItems";
export const INGREDIENT_CATALOG_CANDIDATES_KEY = "ingredientCatalogCandidates";
export const INGREDIENT_CATALOG_LAST_SYNC_AT_KEY = "ingredientCatalogLastSyncAt";

type IngredientCatalogMap = Record<string, IngredientCatalogEntry>;

let ingredientCatalogCache: IngredientCatalogMap = {};
let ingredientAliasCache: Record<string, IngredientCatalogEntry> = {};

const INGREDIENT_SOURCE_PRIORITY: Record<IngredientCatalogSource, number> = {
  seed: 4,
  ai_promoted: 3,
  imported: 2,
  manual: 2,
  ai_resolved: 1,
};

function normalizeLookupText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularizeLookupToken(token: string) {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("oes") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

function buildLookupVariants(value: string) {
  const normalized = normalizeLookupText(value);
  if (!normalized) return [];

  const variants = new Set([normalized]);
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length > 0) {
    const singularized = tokens.map((token) => singularizeLookupToken(token)).join(" ");
    if (singularized) variants.add(singularized);
  }

  return Array.from(variants);
}

function buildIngredientAliasCache(items: IngredientCatalogMap) {
  return Object.values(items).reduce<Record<string, IngredientCatalogEntry>>((acc, item) => {
    if (!item) return acc;

    const register = (raw: string) => {
      const normalized = normalizeLookupText(raw);
      if (!normalized) return;
      const existing = acc[normalized];
      if (!existing) {
        acc[normalized] = item;
        return;
      }

      const existingPriority = INGREDIENT_SOURCE_PRIORITY[existing.source] ?? 0;
      const nextPriority = INGREDIENT_SOURCE_PRIORITY[item.source] ?? 0;
      if (nextPriority > existingPriority) {
        acc[normalized] = item;
      }
    };

    register(item.id);
    register(item.canonicalName);

    for (const aliases of Object.values(item.aliases || {})) {
      if (!Array.isArray(aliases)) continue;
      aliases.forEach(register);
    }

    return acc;
  }, {});
}

export function setIngredientCatalogCache(items: IngredientCatalogMap) {
  ingredientCatalogCache = items || {};
  ingredientAliasCache = buildIngredientAliasCache(ingredientCatalogCache);
}

export function getIngredientCatalogCache() {
  return ingredientCatalogCache;
}

export function findIngredientCatalogEntry(
  name: string,
  preferredLocale?: IngredientLocale | null
): IngredientCatalogEntry | null {
  const variants = buildLookupVariants(name);
  if (variants.length === 0) return null;

  if (preferredLocale) {
    let bestLocaleMatch: IngredientCatalogEntry | null = null;
    for (const item of Object.values(ingredientCatalogCache)) {
      const aliases = item.aliases?.[preferredLocale] || [];
      const normalizedAliases = aliases.map((alias) => normalizeLookupText(alias));
      if (variants.some((variant) => normalizedAliases.includes(variant))) {
        if (!bestLocaleMatch) {
          bestLocaleMatch = item;
          continue;
        }

        const currentPriority = INGREDIENT_SOURCE_PRIORITY[bestLocaleMatch.source] ?? 0;
        const nextPriority = INGREDIENT_SOURCE_PRIORITY[item.source] ?? 0;
        if (nextPriority > currentPriority) {
          bestLocaleMatch = item;
        }
      }
    }
    if (bestLocaleMatch) return bestLocaleMatch;
  }

  for (const variant of variants) {
    if (ingredientAliasCache[variant]) return ingredientAliasCache[variant];
  }

  return null;
}
