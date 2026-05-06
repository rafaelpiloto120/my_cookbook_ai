import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  addRecipeMeal,
  estimateMealFromText,
  MyDayMealIngredient,
  resolveStructuredMealEstimate,
} from "./myDayMeals";
import { findIngredientCatalogEntry, IngredientCatalogEntry } from "./ingredients/catalog";
import { normalizeRecipeNutritionInfo, RecipeNutritionInfo } from "./recipes/nutrition";
import { getApiBaseUrl } from "./config/api";

export type SavedRecipe = {
  id: string;
  title: string;
  image?: string | null;
  servings?: number | null;
  servingInfo?: RecipeServingInfo | null;
  difficulty?: string | null;
  tags?: string[];
  ingredients?: string[];
  isDeleted?: boolean;
  nutritionInfo?: RecipeNutritionInfo | null;
  nutrition?: RecipeNutritionEstimate | null;
  mealLoggingRepresentation?: RecipeMealLoggingRepresentation | null;
};

export type RecipeServingInfo = {
  servings: number;
  yieldUnit?: string | null;
  recipeType?: string | null;
  source: "imported" | "ai_inferred" | "manual";
  updatedAt?: string | null;
};

type ParsedRecipeIngredient = {
  item: MyDayMealIngredient;
  sourceLine: string;
  quantityStatus: "explicit" | "unknown";
};

export type RecipeNutritionEstimate = {
  caloriesPerServing: number;
  proteinPerServing: number;
  carbsPerServing: number;
  fatPerServing: number;
  servings: number;
  servingInfo?: RecipeServingInfo | null;
};

export type RecipeMealLoggingRepresentation = {
  ingredients: MyDayMealIngredient[];
  updatedAt: string;
  source: "estimated" | "manual" | "imported";
};

const RECIPE_LOGGING_INITIAL_LIMIT = 8;
const MIN_RECIPE_LOGGING_INGREDIENT_KCAL = 10;
const MIN_RECIPE_LOGGING_INGREDIENT_CALORIE_SHARE = 0.02;
const RECIPE_TABLESPOON_ML = 15;
const RECIPE_DESSERT_SPOON_ML = 10;
const RECIPE_TEASPOON_ML = 5;
const RECIPE_COFFEE_SPOON_ML = 2.5;
const RECIPE_CUP_ML = 240;
const RECIPE_PINCH_G = 0.3;
const RECIPE_DRIZZLE_OIL_G = 5;
const API_BASE_URL = getApiBaseUrl() || "http://10.0.2.2:3000";

const RECIPE_IGNORED_PATTERNS: RegExp[] = [
  /\bto taste\b/i,
  /\bif needed\b/i,
  /\bif necessary\b/i,
  /\bas needed\b/i,
  /\ba gosto\b/i,
  /\bal gusto\b/i,
  /\bau go[uû]t\b/i,
  /\bnach geschmack\b/i,
  /\bfor garnish\b/i,
  /\bfor serving\b/i,
  /\boptional\b/i,
  /\bfacultatif\b/i,
  /\bopcional\b/i,
  /\bopcionales?\b/i,
  /^\s*(salt|sea salt|kosher salt)\b/i,
  /^\s*(sal|sel)\b/i,
  /^\s*(pepper|black pepper|ground black pepper)\b/i,
  /^\s*(pimenta|pimienta|poivre)\b/i,
  /^\s*(garlic|alho|ajo|ail)\b/i,
  /^\s*(shallot|shallots|chalota|chalotas|echalote|echalotes)\b/i,
  /^\s*(parsley|salsa|persil)\b/i,
  /^\s*(cilantro|coentro|coentros|coriandre)\b/i,
  /^\s*(mint|hortel[aã]|menthe|minze)\b/i,
  /^\s*(oregano|or[eé]g[aã]os?)\b/i,
  /^\s*(basil|manjeric[aã]o|basilic)\b/i,
  /^\s*(thyme|tomilho|thym)\b/i,
  /^\s*(rosemary|alecrim|romarin)\b/i,
  /^\s*(bay leaf|louro|laurier)\b/i,
  /^\s*(clove|cloves|cravinho|cravinhos)\b/i,
  /^\s*(guindilla|chili|piri-?piri)\b/i,
  /^\s*(nutmeg|noz-moscada|muscade)\b/i,
  /^\s*(paprika)\b/i,
  /^\s*(cumin|cominho|cominos?)\b/i,
  /^\s*(knoblauch|knoblauchzehen)\b/i,
  /^\s*water\b/i,
  /^\s*ice\b/i,
];

function normalizeRecipeLineForRelevanceCheck(line: string) {
  return cleanRecipeIngredientLine(line)
    .replace(
      /^\s*(?:\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*/i,
      ""
    )
    .replace(
      /^\s*(kg|g|mg|ml|l|lb|oz|tbsp|tbsps|tsp|tsps|tablespoons?|teaspoons?|cups?|c\.?\s*sopa|c\.?\s*chá|colher(?:es)? de sopa|colher(?:es)? de chá|cucharadas?|cucharaditas?|cuill[eè]res? à soupe|cuill[eè]res? à caf[eé]|esslöffel|teelöffel|el|tl|clove|cloves|gousse|gousses|diente|dientes|dente|dentes|ramo|ramos|ramita|ramitas|branche|branches|folha|folhas|sheet|sheets|placa|placas|fatia|fatias|slice|slices|lata|latas|bo[iî]te|bo[iî]tes|dose|dosen|can|cans|pinch|pinches|pitada|pitadas|pizca|pizcas|pinc[eé]e|pinc[eé]es|prise|prisen|unidade|unidades|unit|units|un|und)\b\s*/i,
      ""
    )
    .replace(/^\s*(de|da|do|das|dos)\s+/i, "")
    .trim();
}

function cleanRecipeIngredientLine(line: string) {
  return String(line || "")
    .replace(/^\s*[•*-]\s*/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/^\s*maybe\s+/i, "")
    .replace(/\s+(if needed|if necessary|as needed)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isRelevantRecipeIngredientLine(line: string) {
  const cleaned = normalizeRecipeLineForRelevanceCheck(line);
  if (!cleaned) return false;
  return !RECIPE_IGNORED_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function scoreRecipeIngredientLine(line: string) {
  const cleaned = cleanRecipeIngredientLine(line);
  const lower = cleaned.toLowerCase();
  let score = 0;

  const quantityMatch = lower.match(/^(\d+(?:[.,]\d+)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*(.*)$/i);
  const quantityToken = quantityMatch?.[1] ?? null;
  const remainder = (quantityMatch?.[2] ?? lower).trim();

  if (/\b(kg|g|ml|l|oz|lb)\b/.test(remainder)) score += 5;
  if (
    /\b(cup|cups|tablespoon|tablespoons|teaspoon|teaspoons|tbsp|tsp|c\.?\s*sopa|c\.?\s*chá|colher de sopa|colheres de sopa|colher de chá|colheres de chá|cucharada|cucharadita|cuillère à soupe|cuillère à café|esslöffel|teelöffel|el|tl)\b/.test(
      remainder
    )
  ) {
    score += 2;
  }
  if (
    /\b(chicken|beef|pork|salmon|fish|shrimp|tofu|rice|pasta|lasagna|lasagne|lasanha|lasa[ñn]a|potato|tomato|cream|cheese|milk|yogurt|egg|eggs|mushroom|cogumelos?|nata|natas|queijo|frango|arroz|massa|batata|tomate|tomates|pollo|queso|huevo|huevos|champignons?|sahne|käse|hähnchen|reis|nudeln|bacalhau|bacalao|morue|kabeljau|bechamel|béchamel|chorizo|chouri[cç]o|lingui[cç]a)\b/.test(
      lower
    )
  ) {
    score += 6;
  }
  if (
    /\b(garlic|alho|ajo|ail|knoblauch|shallot|chalota|echalote|parsley|salsa|persil|cilantro|coentro|coriandre|mint|hortel[aã]|menthe|minze|oregano|or[eé]g[aã]os?|basil|manjeric[aã]o|basilic|thyme|tomilho|thym|rosemary|alecrim|romarin|bay leaf|louro|laurier|clove|cloves|cravinho|cravinhos|guindilla|chili|piri-?piri|nutmeg|noz-moscada|muscade|paprika|cumin|cominho|cominos?)\b/.test(
      lower
    )
  ) {
    score -= 5;
  }
  if (/\b(optional|opcional|facultatif|for garnish|for serving|to taste|a gosto|al gusto|au goût|nach geschmack)\b/.test(lower)) {
    score -= 6;
  }

  if (quantityToken) {
    const numeric = Number(quantityToken.replace(",", "."));
    if (Number.isFinite(numeric)) {
      if (numeric >= 100) score += 4;
      else if (numeric >= 20) score += 2;
      else if (numeric <= 3) score -= 1;
    } else if (/[¼½¾⅓⅔]/.test(quantityToken) || /\//.test(quantityToken)) {
      score += 1;
    }
  }

  return score;
}

export function getRelevantRecipeIngredientLines(recipe: SavedRecipe, limit = 8): string[] {
  const sourceLines = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const relevant = sourceLines
    .map((line, index) => ({
      line: cleanRecipeIngredientLine(line),
      index,
    }))
    .filter((entry) => Boolean(entry.line))
    .filter((entry) => isRelevantRecipeIngredientLine(entry.line))
    .sort((a, b) => {
      const scoreDiff = scoreRecipeIngredientLine(b.line) - scoreRecipeIngredientLine(a.line);
      if (scoreDiff !== 0) return scoreDiff;
      return a.index - b.index;
    })
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.line)
    .filter(Boolean);

  if (relevant.length > 0) {
    return relevant;
  }

  const fallback = sourceLines
    .map((line) => cleanRecipeIngredientLine(line))
    .filter(Boolean)
    .slice(0, limit);
  if (fallback.length > 0) {
    return fallback;
  }

  return [recipe.title].filter(Boolean);
}

const RECIPE_UNIT_PHRASES = [
  "colheres de café",
  "colher de café",
  "c. de café",
  "c de café",
  "c. café",
  "c café",
  "c. sopa",
  "c sopa",
  "c. chá",
  "c chá",
  "colher de sobremesa",
  "colheres de sobremesa",
  "colher de sopa",
  "colheres de sopa",
  "colher sopa",
  "colheres sopa",
  "colher de chá",
  "colheres de chá",
  "colher chá",
  "colheres chá",
  "cucharada",
  "cucharadas",
  "cucharadita",
  "cucharaditas",
  "cuillère à soupe",
  "cuillères à soupe",
  "cuillère à café",
  "cuillères à café",
  "esslöffel",
  "esslöffeln",
  "teelöffel",
  "teelöffeln",
  "el",
  "tl",
  "chávena",
  "chávenas",
  "xícara",
  "xícaras",
  "taza",
  "tazas",
  "tasse",
  "tasses",
  "becher",
  "cup",
  "cups",
  "tbsp",
  "tbsps",
  "tsp",
  "tsps",
  "tablespoon",
  "tablespoons",
  "teaspoon",
  "teaspoons",
  "clove",
  "cloves",
  "gousse",
  "gousses",
  "diente",
  "dientes",
  "embalagem",
  "embalagens",
  "pacote",
  "pacotes",
  "package",
  "packages",
  "packung",
  "packungen",
  "dente",
  "dentes",
  "ramo",
  "ramos",
  "ramita",
  "ramitas",
  "branche",
  "branches",
  "folha",
  "folhas",
  "sheet",
  "sheets",
  "placa",
  "placas",
  "fatia",
  "fatias",
  "slice",
  "slices",
  "lata",
  "latas",
  "boîte",
  "boîtes",
  "dose",
  "dosen",
  "can",
  "cans",
  "pinch",
  "pinches",
  "pitada",
  "pitadas",
  "pizca",
  "pizcas",
  "pincée",
  "pincées",
  "prise",
  "prisen",
  "unidade",
  "unidades",
  "unid.",
  "unid",
  "unit",
  "units",
  "un",
  "und",
  "g",
  "kg",
  "ml",
  "l",
  "oz",
  "lb",
] as const;

function parseRecipeQuantityToken(token: string) {
  const normalized = token
    .trim()
    .replace(",", ".")
    .replace(/^½$/, "0.5")
    .replace(/^¼$/, "0.25")
    .replace(/^¾$/, "0.75")
    .replace(/^⅓$/, "0.33")
    .replace(/^⅔$/, "0.67");

  if (/^\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?$/.test(normalized)) {
    const [start, end] = normalized.split("-").map((part) => Number(part.trim().replace(",", ".")));
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return String(Math.round((((start + end) / 2) as number) * 100) / 100);
    }
  }

  if (/^\d+\s+\d+\/\d+$/.test(normalized)) {
    const [whole, fraction] = normalized.split(/\s+/);
    const [numerator, denominator] = fraction.split("/").map(Number);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return String(Number(whole) + numerator / denominator);
    }
  }

  if (/^\d+\/\d+$/.test(normalized)) {
    const [numerator, denominator] = normalized.split("/").map(Number);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return String(numerator / denominator);
    }
  }

  return normalized;
}

function normalizeRecipeIngredientName(name: string) {
  const cleaned = name
    .trim()
    .replace(/\([^)]*\)/g, "")
    .replace(
      /,\s*(chopped|minced|diced|sliced|grated|melted|softened|beaten|peeled|drained|mixed|picado|picada|picados|picadas|cortado|cortada|cortados|cortadas|rallado|rallada|ralado|ralada|escorrido|escorrida|pelado|pelada|hach[eé]e?|emin[cé]e?|geschnitten|gehackt)\b.*$/i,
      ""
    )
    .replace(
      /^\s*(?:\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*(kg|g|gr\.?|gramos?|grammes?|gramm|mg|ml|l|lb|oz)\s+/i,
      ""
    )
    .replace(
      /^\s*(?:\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*(?:heaped|heaping|rounded|level|generous)?\s*(tbsp|tbsps|tsp|tsps|tablespoons?|teaspoons?|cups?|c\.?\s*(?:de\s*)?sopa|c\.?\s*(?:de\s*)?chá|c\.?\s*(?:de\s*)?caf[eé]|colher(?:es)?(?: de)? sopa|colher(?:es)?(?: de)? chá|colher(?:es)? de caf[eé]|cucharadas?|cucharaditas?|cuill[eè]res? à soupe|cuill[eè]res? à caf[eé]|esslöffel|teelöffel|el|tl)\s+/i,
      ""
    )
    .replace(/^\s*(?:can|cans|tin|tins|jar|jars|package|packages|pack|packs|lata|latas|bo[iî]te|bo[iî]tes|dose|dosen|pacote|pacotes|embalagem|embalagens|packung|packungen)\s+/i, "")
    .replace(/^\s*de\s+/i, "")
    .replace(/^\s*da\s+/i, "")
    .replace(/^\s*do\s+/i, "")
    .replace(/^\s*das\s+/i, "")
    .replace(/^\s*dos\s+/i, "")
    .replace(/^\s*(?:um|uma|a|an)?\s*(?:fio|drizzle|splash|dash|chorrito|filet)\s+(?:de|of|d['’])\s+/i, "")
    .replace(/\bq\.?\s*b\.?\b\.?/gi, "")
    .replace(/\b(grande|grandes|pequena|pequenas|pequeno|pequenos|m[eé]dia|m[eé]dias|m[eé]dio|m[eé]dios|large|small|medium)\b/gi, "")
    .replace(/\b(?:tamanho\s*)?(?:s|m|l|xl)\b$/gi, "")
    .replace(/\b(vermelha|vermelho|roxa|roxo|branca|branco|fresco|fresca|frescos|frescas|enlatado|enlatada|enlatados|enlatadas|ralado|ralada|ralados|raladas|picado|picada|picados|picadas|desossados?|sem pele|pingo doce)\b/gi, "")
    .replace(/\b(cortad[ao]s?\s+em\s+quartos?.*)$/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function normalizeCatalogLookupName(name: string) {
  return normalizeRecipeIngredientName(name)
    .replace(/^(queijo|cheese)\s+/i, "")
    .replace(/\s+(ralado|ralada|grated)$/i, "")
    .replace(/\s+de\s+b[uú]fala$/i, "")
    .replace(/^carne\s+picada$/i, "carne de vaca")
    .replace(/^peitos?\s+de\s+frango.*$/i, "peito de frango")
    .replace(/^pechugas?\s+de\s+pollo.*$/i, "pechuga de pollo")
    .replace(/^pechuga.*pollo.*$/i, "pechuga de pollo")
    .replace(/^filetes?\s+rusos?.*$/i, "carne de vaca")
    .replace(/^(filets?|blancs?)\s+de\s+poulet.*$/i, "poulet")
    .replace(/^h[aä]hnchen.*$/i, "hahnchen")
    .replace(/^hacksteak$/i, "beef")
    .replace(/^feta[-\s]?k[aä]se$/i, "feta")
    .replace(/^kirschtomaten$/i, "tomate")
    .replace(/^semillas?\s+de\s+s[eé]samo.*$/i, "sesame seeds")
    .replace(/^tomates?$/i, "tomate")
    .replace(/^tomate\s+picado$/i, "tomate")
    .replace(/^cebola\s+roxa$/i, "cebola")
    .replace(/^pimento\s+vermelho$/i, "pimento")
    .replace(/^pepitas?\s+de\s+chocolate$/i, "chocolate")
    .replace(/^gelado\s+de\s+baunilha.*$/i, "gelado")
    .replace(/^creme\s+de\s+coco$/i, "creme de coco")
    .replace(/^folhas?\s+de\s+lasanha$/i, "folhas de lasanha")
    .replace(/^molho\s+bechamel$/i, "bechamel")
    .replace(/^vinho\s+branco$/i, "vinho")
    .replace(/^egg\s+yolks?$/i, "egg yolk")
    .replace(/^yolks?$/i, "egg yolk")
    .replace(/^eigelb(?:er)?$/i, "egg yolk")
    .replace(/^gemas?(?:\s+de\s+ovo)?$/i, "gema de ovo")
    .replace(/^egg\s+whites?$/i, "egg white")
    .replace(/^whites?$/i, "egg white")
    .replace(/^eiweiss(?:e)?$/i, "egg white")
    .replace(/^claras?(?:\s+de\s+ovo)?$/i, "clara de ovo")
    .replace(/^(?:fio|drizzle|splash|dash|chorrito|filet)\s+(?:de|of|d['’])\s+/i, "")
    .replace(/^lima\b.*$/i, "lima")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLoggingIngredient(item: MyDayMealIngredient): MyDayMealIngredient | null {
  const name = normalizeRecipeIngredientName(String(item.name || ""));
  if (!name || name.length < 2) return null;

  const rawQuantity = Number(String(item.quantity || "1").replace(",", "."));
  let quantity = Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1;
  let unit = String(item.unit || "serving").trim().toLowerCase() || "serving";

  if (unit === "serving" || unit === "unit" || unit === "units" || unit === "un" || unit === "und") {
    const serving = getCatalogDefaultServingForIngredient(name);
    if (serving) {
      quantity *= serving.quantity;
      unit = serving.unit.toLowerCase();
    }
  } else if (unit === "lb") {
    quantity *= 453.59237;
    unit = "g";
  } else if (unit === "oz") {
    quantity *= 28.349523125;
    unit = "g";
  } else if (
    unit === "tbsp" ||
    unit === "tbsps" ||
    unit === "tablespoon" ||
    unit === "tablespoons" ||
    unit === "el" ||
    unit === "c. sopa" ||
    unit === "c sopa" ||
    unit === "colher de sopa" ||
    unit === "colheres de sopa" ||
    unit === "cucharada" ||
    unit === "cucharadas" ||
    unit === "cuillère à soupe" ||
    unit === "cuillères à soupe" ||
    unit === "esslöffel" ||
    unit === "esslöffeln"
  ) {
    quantity *= 15;
    unit = "ml";
  } else if (
    unit === "tsp" ||
    unit === "tsps" ||
    unit === "teaspoon" ||
    unit === "teaspoons" ||
    unit === "tl" ||
    unit === "c. chá" ||
    unit === "c chá" ||
    unit === "colher de chá" ||
    unit === "colheres de chá" ||
    unit === "cucharadita" ||
    unit === "cucharaditas" ||
    unit === "cuillère à café" ||
    unit === "cuillères à café" ||
    unit === "teelöffel" ||
    unit === "teelöffeln"
  ) {
    quantity *= 5;
    unit = "ml";
  } else if (
    unit === "cup" ||
    unit === "cups" ||
    unit === "chávena" ||
    unit === "chávenas" ||
    unit === "xícara" ||
    unit === "xícaras" ||
    unit === "taza" ||
    unit === "tazas" ||
    unit === "tasse" ||
    unit === "tasses" ||
    unit === "becher"
  ) {
    quantity *= 240;
    unit = "ml";
  }

  return {
    name,
    quantity: String(Math.round(quantity * 100) / 100),
    unit,
  };
}

function loggingIngredientKey(item: MyDayMealIngredient) {
  return `${item.name.trim().toLowerCase()}::${item.unit.trim().toLowerCase()}`;
}

function scoreLoggingIngredient(item: MyDayMealIngredient) {
  const name = item.name.trim().toLowerCase();
  const unit = item.unit.trim().toLowerCase();
  const quantity = Number(String(item.quantity).replace(",", "."));
  let score = 0;

  if (
    /\b(chicken|frango|pollo|beef|carne|vaca|pork|porco|salmon|salm[aã]o|fish|peixe|shrimp|camar[aã]o|rice|arroz|pasta|massa|lasagna|lasagne|lasanha|lasa[ñn]a|potato|batata|tomato|tomate|cream|natas?|cheese|queijo|milk|leite|yogurt|iogurte|egg|ovo|mushroom|cogumelo|beans|feij[aã]o|bread|p[aã]o|wrap|tortilla|avocado|abacate|bacalhau|bacalao|morue|kabeljau|bechamel|béchamel|chorizo|chouri[cç]o|lingui[cç]a|sausage|saucisse|wurst)\b/i.test(
      name
    )
  ) {
    score += 7;
  }

  if (
    /\b(garlic|alho|ajo|ail|knoblauch|shallot|chalota|echalote|parsley|salsa|persil|cilantro|coentro|coriandre|mint|hortel[aã]|menthe|minze|oregano|or[eé]g[aã]os?|basil|manjeric[aã]o|basilic|thyme|tomilho|thym|rosemary|alecrim|romarin|bay leaf|louro|laurier|clove|cloves|cravinho|cravinhos|guindilla|chili|piri-?piri|nutmeg|noz-moscada|muscade|paprika|cumin|cominho|cominos?|salt|sal|pepper|pimenta|water|ice)\b/i.test(
      name
    )
  ) {
    score -= 8;
  }

  if (Number.isFinite(quantity)) {
    if (unit === "g" || unit === "ml") {
      if (quantity >= 150) score += 5;
      else if (quantity >= 50) score += 3;
      else if (quantity <= 15) score -= 2;
    } else if (unit === "kg" || unit === "l") {
      score += 5;
    } else if (unit === "serving") {
      score -= 2;
    } else if (unit === "un" || unit === "unit" || unit === "units") {
      if (quantity >= 1 && quantity <= 6) score += 1;
    } else {
      score += 1;
    }
  }

  return score;
}

function mergeLoggingIngredients(ingredients: MyDayMealIngredient[]) {
  const merged = new Map<string, MyDayMealIngredient>();

  ingredients.forEach((item) => {
    const normalized = normalizeLoggingIngredient(item);
    if (!normalized) return;
    const key = loggingIngredientKey(normalized);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, normalized);
      return;
    }

    const existingQuantity = Number(String(existing.quantity).replace(",", "."));
    const nextQuantity = Number(String(normalized.quantity).replace(",", "."));
    if (Number.isFinite(existingQuantity) && Number.isFinite(nextQuantity)) {
      merged.set(key, {
        ...existing,
        quantity: String(Math.round((existingQuantity + nextQuantity) * 100) / 100),
      });
    }
  });

  return [...merged.values()];
}

function convertRecipeIngredientQuantityToNutritionBase(
  quantity: number,
  unit: string,
  nutritionUnit: "g" | "ml"
) {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const normalizedUnit = unit.trim().toLowerCase();

  if (nutritionUnit === "g") {
    if (normalizedUnit === "g") return quantity;
    if (normalizedUnit === "gr" || normalizedUnit === "gr." || normalizedUnit === "gramo" || normalizedUnit === "gramos" || normalizedUnit === "gramme" || normalizedUnit === "grammes" || normalizedUnit === "gramm") return quantity;
    if (normalizedUnit === "kg") return quantity * 1000;
    if (normalizedUnit === "mg") return quantity / 1000;
    if (normalizedUnit === "ml") return quantity;
    if (normalizedUnit === "l") return quantity * 1000;
    return null;
  }

  if (normalizedUnit === "ml") return quantity;
  if (normalizedUnit === "l") return quantity * 1000;
  if (normalizedUnit === "g") return quantity;
  if (normalizedUnit === "kg") return quantity * 1000;
  return null;
}

function getRecipeIngredientCatalogEntry(name: string): IngredientCatalogEntry | null {
  const candidates = Array.from(
    new Set(
      [
        name,
        normalizeRecipeIngredientName(name),
        normalizeCatalogLookupName(name),
      ].filter(Boolean)
    )
  );

  for (const candidate of candidates) {
    const entry = findIngredientCatalogEntry(candidate);
    if (entry) return entry;
  }

  return null;
}

function getCatalogDefaultServingForIngredient(name: string) {
  const catalogEntry = getRecipeIngredientCatalogEntry(name);
  return catalogEntry?.defaultServing ?? null;
}

function resolveCatalogNutritionBaseAmount(
  item: MyDayMealIngredient,
  catalogEntry: IngredientCatalogEntry
) {
  const quantity = Number(String(item.quantity || "0").replace(",", "."));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  const directAmount = convertRecipeIngredientQuantityToNutritionBase(
    quantity,
    item.unit,
    catalogEntry.nutritionPer100.unit
  );
  if (directAmount !== null) return directAmount;

  const unit = String(item.unit || "").trim().toLowerCase();
  const recipeMeasureAmount = convertRecipeMeasureUnitToBaseAmount(
    quantity,
    unit,
    catalogEntry.nutritionPer100.unit
  );
  if (recipeMeasureAmount !== null) return recipeMeasureAmount;

  const defaultServing = catalogEntry.defaultServing;
  if (
    defaultServing &&
    (DISCRETE_RECIPE_UNITS.has(unit) || unit === "unit" || unit === "units" || unit === "un" || unit === "und")
  ) {
    const defaultAmount = convertRecipeIngredientQuantityToNutritionBase(
      Number(defaultServing.quantity),
      defaultServing.unit,
      catalogEntry.nutritionPer100.unit
    );
    if (defaultAmount !== null) return quantity * defaultAmount;
  }

  return null;
}

function convertRecipeMeasureUnitToBaseAmount(
  quantity: number,
  unit: string,
  nutritionUnit: "g" | "ml"
) {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const normalizedUnit = unit.trim().toLowerCase();
  let milliliters: number | null = null;
  let grams: number | null = null;

  if (
    normalizedUnit === "tbsp" ||
    normalizedUnit === "tbsps" ||
    normalizedUnit === "tablespoon" ||
    normalizedUnit === "tablespoons" ||
    normalizedUnit === "el" ||
    normalizedUnit === "c. sopa" ||
    normalizedUnit === "c sopa" ||
    normalizedUnit === "colher de sopa" ||
    normalizedUnit === "colheres de sopa" ||
    normalizedUnit === "colher sopa" ||
    normalizedUnit === "colheres sopa" ||
    normalizedUnit === "cucharada" ||
    normalizedUnit === "cucharadas" ||
    normalizedUnit === "cuillère à soupe" ||
    normalizedUnit === "cuillères à soupe" ||
    normalizedUnit === "esslöffel" ||
    normalizedUnit === "esslöffeln"
  ) {
    milliliters = quantity * RECIPE_TABLESPOON_ML;
  } else if (
    normalizedUnit === "colher de sobremesa" ||
    normalizedUnit === "colheres de sobremesa"
  ) {
    milliliters = quantity * RECIPE_DESSERT_SPOON_ML;
  } else if (
    normalizedUnit === "tsp" ||
    normalizedUnit === "tsps" ||
    normalizedUnit === "teaspoon" ||
    normalizedUnit === "teaspoons" ||
    normalizedUnit === "tl" ||
    normalizedUnit === "c. chá" ||
    normalizedUnit === "c chá" ||
    normalizedUnit === "colher de chá" ||
    normalizedUnit === "colheres de chá" ||
    normalizedUnit === "colher chá" ||
    normalizedUnit === "colheres chá" ||
    normalizedUnit === "cucharadita" ||
    normalizedUnit === "cucharaditas" ||
    normalizedUnit === "cuillère à café" ||
    normalizedUnit === "cuillères à café" ||
    normalizedUnit === "teelöffel" ||
    normalizedUnit === "teelöffeln"
  ) {
    milliliters = quantity * RECIPE_TEASPOON_ML;
  } else if (
    normalizedUnit === "colher de café" ||
    normalizedUnit === "colheres de café" ||
    normalizedUnit === "c. de café" ||
    normalizedUnit === "c de café" ||
    normalizedUnit === "c. café" ||
    normalizedUnit === "c café"
  ) {
    milliliters = quantity * RECIPE_COFFEE_SPOON_ML;
  } else if (
    normalizedUnit === "cup" ||
    normalizedUnit === "cups" ||
    normalizedUnit === "chávena" ||
    normalizedUnit === "chávenas" ||
    normalizedUnit === "xícara" ||
    normalizedUnit === "xícaras" ||
    normalizedUnit === "taza" ||
    normalizedUnit === "tazas" ||
    normalizedUnit === "tasse" ||
    normalizedUnit === "tasses" ||
    normalizedUnit === "becher"
  ) {
    milliliters = quantity * RECIPE_CUP_ML;
  } else if (
    normalizedUnit === "pinch" ||
    normalizedUnit === "pinches" ||
    normalizedUnit === "pitada" ||
    normalizedUnit === "pitadas" ||
    normalizedUnit === "pizca" ||
    normalizedUnit === "pizcas" ||
    normalizedUnit === "pincée" ||
    normalizedUnit === "pincées" ||
    normalizedUnit === "prise" ||
    normalizedUnit === "prisen"
  ) {
    grams = quantity * RECIPE_PINCH_G;
  }

  if (nutritionUnit === "ml" && milliliters !== null) return milliliters;
  if (nutritionUnit === "g" && grams !== null) return grams;
  if (nutritionUnit === "g" && milliliters !== null) return milliliters;
  if (nutritionUnit === "ml" && grams !== null) return grams;
  return null;
}

function estimateRecipeIngredientNutritionPerServing(item: MyDayMealIngredient) {
  const catalogEntry = getRecipeIngredientCatalogEntry(item.name);
  if (!catalogEntry) return null;

  const baseAmount = resolveCatalogNutritionBaseAmount(item, catalogEntry);
  if (baseAmount === null) return null;

  const multiplier = baseAmount / 100;
  return {
    calories: catalogEntry.nutritionPer100.calories * multiplier,
    protein: catalogEntry.nutritionPer100.protein * multiplier,
    carbs: catalogEntry.nutritionPer100.carbs * multiplier,
    fat: catalogEntry.nutritionPer100.fat * multiplier,
  };
}

function estimateRecipeIngredientCaloriesPerServing(item: MyDayMealIngredient) {
  return estimateRecipeIngredientNutritionPerServing(item)?.calories ?? 0;
}

function getRecipeLoggingCalorieThreshold(recipeCaloriesPerServing?: number | null) {
  const calorieShareThreshold =
    Number.isFinite(recipeCaloriesPerServing || NaN) && (recipeCaloriesPerServing || 0) > 0
      ? Math.round((recipeCaloriesPerServing || 0) * MIN_RECIPE_LOGGING_INGREDIENT_CALORIE_SHARE)
      : 0;
  return Math.max(MIN_RECIPE_LOGGING_INGREDIENT_KCAL, calorieShareThreshold);
}

const DISCRETE_RECIPE_UNITS = new Set([
  "embalagem",
  "embalagens",
  "package",
  "packages",
  "pack",
  "packs",
  "packung",
  "packungen",
  "pacote",
  "pacotes",
  "lata",
  "latas",
  "can",
  "cans",
  "tin",
  "tins",
  "boîte",
  "boîtes",
  "dose",
  "dosen",
  "sheet",
  "sheets",
  "placa",
  "placas",
  "slice",
  "slices",
  "fatia",
  "fatias",
  "clove",
  "cloves",
  "dente",
  "dentes",
  "gousse",
  "gousses",
  "diente",
  "dientes",
  "folha",
  "folhas",
  "leaf",
  "leaves",
  "un",
  "und",
  "unid.",
  "unid",
  "unit",
  "units",
  "unidade",
  "unidades",
]);

function normalizePerServingRecipeIngredient(
  item: MyDayMealIngredient,
  servings: number
): MyDayMealIngredient {
  const rawQuantity = Number(String(item.quantity || "1").replace(",", "."));
  const rawUnit = String(item.unit || "").trim().toLowerCase();

  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0 || servings <= 1 || rawUnit === "serving") {
    return { ...item };
  }

  const scaledQuantity = Math.round((rawQuantity / servings) * 100) / 100;
  const normalizedItem: MyDayMealIngredient = {
    ...item,
    quantity: String(scaledQuantity),
  };

  if (!DISCRETE_RECIPE_UNITS.has(rawUnit)) {
    return normalizedItem;
  }

  const hasFractionalQuantity = Math.abs(scaledQuantity - Math.round(scaledQuantity)) > 0.001;
  if (!hasFractionalQuantity) {
    return normalizedItem;
  }

  const serving = getCatalogDefaultServingForIngredient(String(item.name || ""));
  if (!serving) {
    return normalizedItem;
  }

  return {
    ...item,
    quantity: String(Math.round(scaledQuantity * serving.quantity * 100) / 100),
    unit: serving.unit.toLowerCase(),
  };
}

export function parseRecipeIngredientLine(input: string): MyDayMealIngredient {
  const trimmed = cleanRecipeIngredientLine(input);
  const compactMetricMatch = trimmed.match(
    /^\s*((?:\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔))\s*(kg|g|gr\.?|gramos?|grammes?|gramm|mg|ml|l|lb|oz)\s+(.+)$/i
  );
  if (compactMetricMatch) {
    const [, quantity, unit, rawName] = compactMetricMatch;
    return {
      name: normalizeRecipeIngredientName(rawName) || trimmed,
      quantity: parseRecipeQuantityToken(quantity),
      unit: unit.toLowerCase().replace(/^gr\.?$|^gramos?$|^grammes?$|^gramm$/, "g"),
    };
  }

  const quantifiedUnitMatch = trimmed.match(
    /^\s*((?:\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔|one|two|three|four|five|six|seven|eight|nine|ten|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|ein|eine|zwei|drei|vier|f[uü]nf|sechs|sieben|acht|neun|zehn))\s*(?:heaped|heaping|rounded|level|generous)?\s*(tbsp|tbsps|tsp|tsps|tablespoons?|teaspoons?|cups?|c\.?\s*(?:de\s*)?sopa|c\.?\s*(?:de\s*)?chá|c\.?\s*(?:de\s*)?caf[eé]|colher(?:es)?(?: de)? sopa|colher(?:es)?(?: de)? chá|colher(?:es)? de caf[eé]|cucharadas?|cucharaditas?|cuill[eè]res? à soupe|cuill[eè]res? à caf[eé]|esslöffel|teelöffel|el|tl)\s+(.+)$/i
  );
  if (quantifiedUnitMatch) {
    const [, quantity, unit, rawName] = quantifiedUnitMatch;
    return {
      name: normalizeRecipeIngredientName(rawName) || trimmed,
      quantity: parseRecipeQuantityToken(quantity),
      unit: unit.toLowerCase(),
    };
  }

  const quantityMatch = trimmed.match(
    /^\s*((?:\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔|one|two|three|four|five|six|seven|eight|nine|ten|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|ein|eine|zwei|drei|vier|f[uü]nf|sechs|sieben|acht|neun|zehn))\s+(.+)$/i
  );
  if (!quantityMatch) {
    return { name: normalizeRecipeIngredientName(trimmed) || trimmed, quantity: "1", unit: "serving" };
  }

  const [, quantity, remainderRaw] = quantityMatch;
  const remainder = remainderRaw.trim();
  const lowerRemainder = remainder.toLowerCase();
  const matchedUnit = [...RECIPE_UNIT_PHRASES]
    .sort((a, b) => b.length - a.length)
    .find((unit) => lowerRemainder === unit || lowerRemainder.startsWith(`${unit} `));

  if (matchedUnit) {
    const rest = normalizeRecipeIngredientName(remainder.slice(matchedUnit.length));
    return {
      name: rest || normalizeRecipeIngredientName(trimmed),
      quantity: parseRecipeQuantityToken(quantity),
      unit: matchedUnit.toLowerCase(),
    };
  }

  if (!/\b(de|da|do|das|dos|with|com)\b/i.test(remainder)) {
    return {
      name: normalizeRecipeIngredientName(remainder) || trimmed,
      quantity: parseRecipeQuantityToken(quantity),
      unit: "un",
    };
  }

  return {
    name: normalizeRecipeIngredientName(remainder) || trimmed,
    quantity: parseRecipeQuantityToken(quantity),
    unit: "serving",
  };
}

function hasUnknownQuantityMarker(line: string) {
  return /\b(q\.?\s*b\.?|quanto baste|as needed|if needed|if necessary|a gosto|to taste|al gusto|au go[uû]t|nach geschmack|fio de|drizzle of|splash of|dash of|chorrito de|filet d['’])\b/i.test(
    line
  );
}

function parseRecipeIngredientLineWithStatus(line: string): ParsedRecipeIngredient {
  const item = parseRecipeIngredientLine(line);
  const unit = String(item.unit || "").trim().toLowerCase();
  const hasUsableQuantity = unit !== "serving" && !hasUnknownQuantityMarker(line);

  return {
    item,
    sourceLine: line,
    quantityStatus: hasUsableQuantity ? "explicit" : "unknown",
  };
}

function getRecipeServingCount(recipe: SavedRecipe) {
  if (typeof recipe.servingInfo?.servings === "number" && Number.isFinite(recipe.servingInfo.servings) && recipe.servingInfo.servings > 0) {
    return recipe.servingInfo.servings;
  }
  return typeof recipe.servings === "number" && Number.isFinite(recipe.servings) && recipe.servings > 0
    ? recipe.servings
    : null;
}

function getRecipeIngredientSourceLines(recipe: SavedRecipe) {
  const sourceCount = Array.isArray(recipe.ingredients) ? recipe.ingredients.length : 0;
  return getRelevantRecipeIngredientLines(
    recipe,
    Math.max(sourceCount, RECIPE_LOGGING_INITIAL_LIMIT * 2)
  );
}

function isOilCatalogEntry(entry: IngredientCatalogEntry | null | undefined, source = "") {
  const text = `${entry?.id || ""} ${entry?.canonicalName || ""} ${source}`.toLowerCase();
  return /\b(oil|olive oil|azeite|aceite|huile|olivenol)\b/i.test(text);
}

function hasTinyOilQuantityMarker(sourceLine: string) {
  return /\b(fio\s+de|drizzle\s+of|splash\s+of|dash\s+of|chorrito\s+de|filet\s+d['’])\b/i.test(sourceLine);
}

function resolveCatalogUsualServingIngredient(item: MyDayMealIngredient, sourceLine = "") {
  const catalogEntry = getRecipeIngredientCatalogEntry(item.name);
  const defaultServing = catalogEntry?.defaultServing ?? null;
  if (!defaultServing) {
    return {
      ...item,
      quantity: "1",
      unit: "serving",
    };
  }

  const displayName = normalizeCatalogLookupName(item.name) || item.name;
  if (isOilCatalogEntry(catalogEntry, `${sourceLine} ${item.name}`) && hasTinyOilQuantityMarker(sourceLine)) {
    return {
      name: displayName,
      quantity: String(RECIPE_DRIZZLE_OIL_G),
      unit: "g",
    };
  }

  return {
    name: displayName,
    quantity: String(defaultServing.quantity),
    unit: String(defaultServing.unit).toLowerCase(),
  };
}

function estimateRecipeNutritionFromIngredients(
  ingredients: MyDayMealIngredient[],
  servings: number
): RecipeNutritionEstimate | null {
  const totals = ingredients.reduce(
    (acc, ingredient) => {
      const nutrition = estimateRecipeIngredientNutritionPerServing(ingredient);
      if (!nutrition) return acc;
      acc.calories += nutrition.calories;
      acc.protein += nutrition.protein;
      acc.carbs += nutrition.carbs;
      acc.fat += nutrition.fat;
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );

  if (totals.calories <= 0) return null;

  return {
    caloriesPerServing: Math.max(Math.round(totals.calories), 1),
    proteinPerServing: Math.max(Math.round(totals.protein), 0),
    carbsPerServing: Math.max(Math.round(totals.carbs), 0),
    fatPerServing: Math.max(Math.round(totals.fat), 0),
    servings,
  };
}

function sumRecipeIngredientCalories(ingredients: MyDayMealIngredient[]) {
  return ingredients.reduce(
    (total, ingredient) => total + estimateRecipeIngredientCaloriesPerServing(ingredient),
    0
  );
}

export function buildRecipeMealLoggingRepresentationFromIngredients(
  ingredients: MyDayMealIngredient[],
  limit = RECIPE_LOGGING_INITIAL_LIMIT,
  servings = 1,
  recipeCaloriesPerServing?: number | null,
  thresholdOverride?: number | null
): RecipeMealLoggingRepresentation {
  const normalized = mergeLoggingIngredients(
    ingredients.map((item) => normalizePerServingRecipeIngredient(item, servings))
  );
  const threshold = thresholdOverride ?? getRecipeLoggingCalorieThreshold(recipeCaloriesPerServing);
  const ranked = normalized
    .map((item, index) => {
      const caloriesPerServing = estimateRecipeIngredientCaloriesPerServing(item);
      return {
        item,
        index,
        caloriesPerServing,
        score: scoreLoggingIngredient(item),
      };
    })
    .filter((entry) => entry.score > 0)
    .filter((entry) => entry.caloriesPerServing >= threshold)
    .sort((a, b) => {
      if (a.caloriesPerServing !== b.caloriesPerServing) return b.caloriesPerServing - a.caloriesPerServing;
      return a.index - b.index;
    });

  const prioritized = ranked
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.item);

  return {
    ingredients: prioritized,
    updatedAt: new Date().toISOString(),
    source: "estimated",
  };
}

function buildValidatedRecipeMealLoggingRepresentation(
  ingredients: MyDayMealIngredient[],
  recipeCaloriesPerServing?: number | null
) {
  const calories = Number(recipeCaloriesPerServing || 0);
  const initial = buildRecipeMealLoggingRepresentationFromIngredients(
    ingredients,
    RECIPE_LOGGING_INITIAL_LIMIT,
    1,
    recipeCaloriesPerServing
  );
  if (!Number.isFinite(calories) || calories <= 0) return initial;

  const initialCoverage = sumRecipeIngredientCalories(initial.ingredients) / calories;
  if (initialCoverage >= 0.8) return initial;

  return buildRecipeMealLoggingRepresentationFromIngredients(
    ingredients,
    RECIPE_LOGGING_INITIAL_LIMIT,
    1,
    recipeCaloriesPerServing,
    Math.max(5, Math.round(calories * 0.01))
  );
}

async function estimateRecipeNutritionWithAi(
  recipe: SavedRecipe,
  language?: string
): Promise<RecipeNutritionEstimate | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/recipes/estimate-nutrition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: recipe.title || "Recipe",
        servings: getRecipeServingCount(recipe),
        ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
        language,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const normalized = normalizeRecipeNutritionInfo(data?.nutrition);
    if (!normalized?.perServing?.calories) return null;
    const inferredServings = Number(data?.servingsUsed);
    const servingInfo: RecipeServingInfo | null =
      Number.isFinite(inferredServings) && inferredServings > 0
        ? {
            servings: Math.max(Math.round(inferredServings), 1),
            yieldUnit: typeof data?.yieldUnit === "string" && data.yieldUnit.trim() ? data.yieldUnit.trim() : null,
            recipeType: typeof data?.recipeType === "string" && data.recipeType.trim() ? data.recipeType.trim() : null,
            source:
              getRecipeServingCount(recipe) &&
              Math.round(inferredServings) === Math.round(getRecipeServingCount(recipe) || 0)
                ? "imported"
                : "ai_inferred",
            updatedAt: new Date().toISOString(),
          }
        : null;
    return {
      caloriesPerServing: Math.max(Math.round(normalized.perServing.calories || 0), 1),
      proteinPerServing: Math.max(Math.round(normalized.perServing.protein || 0), 0),
      carbsPerServing: Math.max(Math.round(normalized.perServing.carbs || 0), 0),
      fatPerServing: Math.max(Math.round(normalized.perServing.fat || 0), 0),
      servings: servingInfo?.servings ?? getRecipeServingCount(recipe) ?? 1,
      servingInfo,
    };
  } catch {
    return null;
  }
}

async function resolveRecipeIngredientsForEstimate(recipe: SavedRecipe, language?: string) {
  const servingCount = getRecipeServingCount(recipe);
  const sourceLines = getRecipeIngredientSourceLines(recipe);
  const parsedIngredients = sourceLines.map((line) => parseRecipeIngredientLineWithStatus(line));
  const baseIngredients = parsedIngredients.map(({ item, quantityStatus, sourceLine }) => {
    if (!servingCount || quantityStatus === "unknown") {
      return resolveCatalogUsualServingIngredient(item, sourceLine);
    }
    return normalizePerServingRecipeIngredient(item, servingCount);
  });

  const needsAiResolution = baseIngredients.some(
    (ingredient) => !getRecipeIngredientCatalogEntry(ingredient.name) || ingredient.unit === "serving"
  );
  if (!needsAiResolution) {
    return {
      ingredients: mergeLoggingIngredients(baseIngredients),
      usedAiFallback: false,
      servings: servingCount ?? 1,
    };
  }

  const estimate = await resolveStructuredMealEstimate(
    sourceLines.join(", "),
    baseIngredients,
    sourceLines,
    language
  );

  const ingredients = baseIngredients.map((ingredient, index) => {
    const resolved = estimate.ingredients[index];
    if (!resolved) return ingredient;
    return {
      name: String(resolved.name || ingredient.name),
      quantity: String(resolved.quantity || ingredient.quantity),
      unit: String(resolved.unit || ingredient.unit).toLowerCase(),
    };
  });

  return {
    ingredients: mergeLoggingIngredients(ingredients),
    usedAiFallback: estimate.usedAiFallback,
    servings: servingCount ?? 1,
  };
}

export function buildRecipeMealLoggingRepresentation(
  recipe: SavedRecipe,
  limit = RECIPE_LOGGING_INITIAL_LIMIT,
  recipeCaloriesPerServing?: number | null
): RecipeMealLoggingRepresentation {
  const servings = getRecipeServingCount(recipe);
  const ingredients = getRecipeIngredientSourceLines(recipe)
    .slice(0, limit * 2)
    .map((line) => parseRecipeIngredientLineWithStatus(line))
    .map(({ item, quantityStatus, sourceLine }) => {
      if (!servings || quantityStatus === "unknown") {
        return resolveCatalogUsualServingIngredient(item, sourceLine);
      }
      return normalizePerServingRecipeIngredient(item, servings);
    });
  return buildRecipeMealLoggingRepresentationFromIngredients(
    ingredients,
    limit,
    1,
    recipeCaloriesPerServing
  );
}

export function isRecipeMealLoggingRepresentationUsable(
  representation: RecipeMealLoggingRepresentation | null | undefined
) {
  if (!representation || !Array.isArray(representation.ingredients) || representation.ingredients.length === 0) {
    return false;
  }

  const suspiciousNameCount = representation.ingredients.filter((item) =>
    /^(de|da|do|das|dos)\s+/i.test(String(item.name || "").trim())
  ).length;

  if (suspiciousNameCount > 0) {
    return false;
  }

  const unnamedCount = representation.ingredients.filter(
    (item) => !String(item.name || "").trim() || String(item.name || "").trim().length < 2
  ).length;

  const embeddedQuantityCount = representation.ingredients.filter((item) =>
    /^\s*\d/.test(String(item.name || "").trim())
  ).length;
  const embeddedUnitNameCount = representation.ingredients.filter((item) =>
    /^\s*(c\.?\s*sopa|c\.?\s*chá|tbsp|tsp|colher(?:es)?\s+de\s+(?:sopa|chá))\b/i.test(
      String(item.name || "").trim()
    )
  ).length;

  return unnamedCount === 0 && embeddedQuantityCount === 0 && embeddedUnitNameCount === 0;
}

export function needsRecipeMealLoggingRepresentationEnrichment(
  representation: RecipeMealLoggingRepresentation | null | undefined
) {
  if (!isRecipeMealLoggingRepresentationUsable(representation)) return true;
  const ingredients = representation?.ingredients ?? [];
  if (ingredients.length === 0) return true;

  const substantiveCount = ingredients.filter((item) => scoreLoggingIngredient(item) >= 4).length;
  const weakCount = ingredients.filter((item) => scoreLoggingIngredient(item) <= 0).length;
  const genericUnitCount = ingredients.filter((item) => {
    const unit = String(item.unit || "").trim().toLowerCase();
    return unit === "serving" || unit === "unit" || unit === "units";
  }).length;
  const spoonUnitCount = ingredients.filter((item) => {
    const unit = String(item.unit || "").trim().toLowerCase();
    return (
      unit === "tbsp" ||
      unit === "tbsps" ||
      unit === "tablespoon" ||
      unit === "tablespoons" ||
      unit === "tsp" ||
      unit === "tsps" ||
      unit === "teaspoon" ||
      unit === "teaspoons" ||
      unit === "c. sopa" ||
      unit === "c sopa" ||
      unit === "c. chá" ||
      unit === "c chá"
    );
  }).length;

  if (ingredients.length >= 4 && substantiveCount < 2) return true;
  if (ingredients.length >= 4 && weakCount >= Math.ceil(ingredients.length / 2)) return true;
  if (ingredients.length >= 3 && genericUnitCount === ingredients.length) return true;
  if (ingredients.length >= 4 && spoonUnitCount >= Math.ceil(ingredients.length / 2)) return true;

  return false;
}

export async function loadSavedRecipes(): Promise<SavedRecipe[]> {
  try {
    const raw = await AsyncStorage.getItem("recipes");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((recipe) => recipe && typeof recipe === "object" && recipe.id && !recipe.isDeleted)
      .map((recipe) => ({
        id: recipe.id,
        title: recipe.title || "Untitled recipe",
        image:
          typeof recipe.image === "string" && recipe.image.trim()
            ? recipe.image.trim()
            : typeof recipe.imageUrl === "string" && recipe.imageUrl.trim()
              ? recipe.imageUrl.trim()
              : null,
        servings:
          typeof recipe.servings === "number" && Number.isFinite(recipe.servings)
            ? recipe.servings
            : null,
        servingInfo:
          recipe.servingInfo && typeof recipe.servingInfo === "object"
            ? {
                servings: Number(recipe.servingInfo.servings) || Number(recipe.servings) || 1,
                yieldUnit:
                  typeof recipe.servingInfo.yieldUnit === "string" ? recipe.servingInfo.yieldUnit : null,
                recipeType:
                  typeof recipe.servingInfo.recipeType === "string" ? recipe.servingInfo.recipeType : null,
                source:
                  recipe.servingInfo.source === "ai_inferred" ||
                  recipe.servingInfo.source === "manual" ||
                  recipe.servingInfo.source === "imported"
                    ? recipe.servingInfo.source
                    : "imported",
                updatedAt:
                  typeof recipe.servingInfo.updatedAt === "string" ? recipe.servingInfo.updatedAt : null,
              }
            : typeof recipe.servings === "number" && Number.isFinite(recipe.servings) && recipe.servings > 0
              ? {
                  servings: recipe.servings,
                  source: "imported",
                  updatedAt: null,
                }
              : null,
        difficulty:
          typeof recipe.difficulty === "string" && recipe.difficulty.trim()
            ? recipe.difficulty.trim()
            : null,
        tags: Array.isArray(recipe.tags)
          ? recipe.tags
              .map((tag: unknown) => String(tag || "").trim())
              .filter(Boolean)
          : [],
        ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
        isDeleted: recipe.isDeleted === true,
        nutritionInfo: normalizeRecipeNutritionInfo(recipe.nutritionInfo ?? recipe.nutrition),
        mealLoggingRepresentation:
          recipe.mealLoggingRepresentation &&
          Array.isArray(recipe.mealLoggingRepresentation.ingredients)
            ? {
                ingredients: recipe.mealLoggingRepresentation.ingredients
                  .filter((item: any) => item && typeof item === "object")
                  .map((item: any) => ({
                    name: String(item.name || "").trim(),
                    quantity: String(item.quantity || "1"),
                    unit: String(item.unit || "serving").toLowerCase(),
                  })),
                updatedAt:
                  typeof recipe.mealLoggingRepresentation.updatedAt === "string"
                    ? recipe.mealLoggingRepresentation.updatedAt
                    : new Date().toISOString(),
                source:
                  recipe.mealLoggingRepresentation.source === "manual" ||
                  recipe.mealLoggingRepresentation.source === "imported"
                    ? recipe.mealLoggingRepresentation.source
                    : "estimated",
              }
            : null,
        nutrition:
          normalizeRecipeNutritionInfo(recipe.nutritionInfo ?? recipe.nutrition)
            ? {
                caloriesPerServing:
                  normalizeRecipeNutritionInfo(recipe.nutritionInfo ?? recipe.nutrition)?.perServing.calories || 0,
                proteinPerServing:
                  normalizeRecipeNutritionInfo(recipe.nutritionInfo ?? recipe.nutrition)?.perServing.protein || 0,
                carbsPerServing:
                  normalizeRecipeNutritionInfo(recipe.nutritionInfo ?? recipe.nutrition)?.perServing.carbs || 0,
                fatPerServing:
                  normalizeRecipeNutritionInfo(recipe.nutritionInfo ?? recipe.nutrition)?.perServing.fat || 0,
                servings: Number(recipe.servings) || Number(recipe?.nutrition?.servings) || 0,
              }
            : recipe.nutrition && typeof recipe.nutrition === "object"
            ? {
                caloriesPerServing: Number(recipe.nutrition.caloriesPerServing) || 0,
                proteinPerServing: Number(recipe.nutrition.proteinPerServing) || 0,
                carbsPerServing: Number(recipe.nutrition.carbsPerServing) || 0,
                fatPerServing: Number(recipe.nutrition.fatPerServing) || 0,
                servings: Number(recipe.nutrition.servings) || 0,
              }
            : null,
      }));
  } catch {
    return [];
  }
}

export function estimateRecipeNutrition(recipe: SavedRecipe): RecipeNutritionEstimate {
  if (recipe.nutritionInfo) {
    return {
      caloriesPerServing: recipe.nutritionInfo.perServing.calories || 0,
      proteinPerServing: recipe.nutritionInfo.perServing.protein || 0,
      carbsPerServing: recipe.nutritionInfo.perServing.carbs || 0,
      fatPerServing: recipe.nutritionInfo.perServing.fat || 0,
      servings:
        typeof recipe.servings === "number" && recipe.servings > 0 ? recipe.servings : 1,
    };
  }

  if (recipe.nutrition) {
    return recipe.nutrition;
  }

  const servings = getRecipeServingCount(recipe);
  const sourceLines = getRecipeIngredientSourceLines(recipe);
  const parsedIngredients = sourceLines.map((line) => parseRecipeIngredientLineWithStatus(line));
  const catalogResolvedIngredients = parsedIngredients.map(({ item, quantityStatus, sourceLine }) => {
    if (!servings || quantityStatus === "unknown") {
      return resolveCatalogUsualServingIngredient(item, sourceLine);
    }
    return normalizePerServingRecipeIngredient(item, servings);
  });
  const catalogEstimate = estimateRecipeNutritionFromIngredients(
    catalogResolvedIngredients,
    servings ?? 1
  );
  if (catalogEstimate) return catalogEstimate;

  const combinedIngredients =
    recipe.ingredients && recipe.ingredients.length > 0
      ? recipe.ingredients.join(", ")
      : recipe.title;

  const totalEstimate = estimateMealFromText(combinedIngredients);
  const fallbackServings = servings ?? 1;

  return {
    caloriesPerServing: Math.max(Math.round(totalEstimate.calories / fallbackServings), 80),
    proteinPerServing: Math.max(Math.round(totalEstimate.protein / fallbackServings), 4),
    carbsPerServing: Math.max(Math.round(totalEstimate.carbs / fallbackServings), 6),
    fatPerServing: Math.max(Math.round(totalEstimate.fat / fallbackServings), 3),
    servings: fallbackServings,
  };
}

export async function resolveRecipeNutritionEstimate(
  recipe: SavedRecipe,
  language?: string,
  options?: {
    forceRepresentationRefresh?: boolean;
  }
): Promise<{
  nutrition: RecipeNutritionEstimate;
  ingredients: MyDayMealIngredient[];
  mealLoggingRepresentation: RecipeMealLoggingRepresentation;
  usedAiFallback: boolean;
}> {
  const servings = getRecipeServingCount(recipe) ?? 1;
  const forceRepresentationRefresh = options?.forceRepresentationRefresh === true;
  const savedNutrition =
    recipe.nutritionInfo
      ? {
          caloriesPerServing: recipe.nutritionInfo.perServing.calories || 0,
          proteinPerServing: recipe.nutritionInfo.perServing.protein || 0,
          carbsPerServing: recipe.nutritionInfo.perServing.carbs || 0,
          fatPerServing: recipe.nutritionInfo.perServing.fat || 0,
          servings,
        }
      : recipe.nutrition ?? null;

  try {
    if (savedNutrition && !forceRepresentationRefresh) {
      return {
        nutrition: savedNutrition,
        ingredients: [],
        mealLoggingRepresentation: { ingredients: [], updatedAt: new Date().toISOString(), source: "estimated" },
        usedAiFallback: false,
      };
    }

    if (savedNutrition && forceRepresentationRefresh) {
      return {
        nutrition: savedNutrition,
        ingredients: [],
        mealLoggingRepresentation: { ingredients: [], updatedAt: new Date().toISOString(), source: "estimated" },
        usedAiFallback: false,
      };
    }

    const aiNutrition = await estimateRecipeNutritionWithAi(recipe, language);
    const nutrition = aiNutrition ?? estimateRecipeNutrition(recipe);

    return {
      nutrition,
      ingredients: [],
      mealLoggingRepresentation: { ingredients: [], updatedAt: new Date().toISOString(), source: "estimated" },
      usedAiFallback: !!aiNutrition,
    };
  } catch {
    const fallback = savedNutrition ?? estimateRecipeNutrition(recipe);
    return {
      nutrition: fallback,
      ingredients: [],
      mealLoggingRepresentation: { ingredients: [], updatedAt: new Date().toISOString(), source: "estimated" },
      usedAiFallback: false,
    };
  }
}

export async function persistRecipeNutritionEstimate(
  recipeId: string,
  nutrition: RecipeNutritionEstimate,
  mealLoggingRepresentation?: RecipeMealLoggingRepresentation | null
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem("recipes");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    const next = parsed.map((recipe) => {
      if (!recipe || recipe.id !== recipeId) return recipe;
      return {
        ...recipe,
        nutrition: {
          caloriesPerServing: nutrition.caloriesPerServing,
          proteinPerServing: nutrition.proteinPerServing,
          carbsPerServing: nutrition.carbsPerServing,
          fatPerServing: nutrition.fatPerServing,
          servings: nutrition.servings,
          estimatedAt: new Date().toISOString(),
          source: "myday_estimated",
        },
        servings:
          nutrition.servingInfo?.servings ||
          nutrition.servings ||
          (typeof recipe.servings === "number" ? recipe.servings : null),
        servingInfo:
          nutrition.servingInfo ??
          recipe.servingInfo ??
          (nutrition.servings
            ? {
                servings: nutrition.servings,
                source: "manual",
                updatedAt: new Date().toISOString(),
              }
            : null),
        nutritionInfo: {
          perServing: {
            calories: nutrition.caloriesPerServing,
            protein: nutrition.proteinPerServing,
            carbs: nutrition.carbsPerServing,
            fat: nutrition.fatPerServing,
          },
          updatedAt: new Date().toISOString(),
          source: "estimated",
        },
        ...(mealLoggingRepresentation
          ? {
              mealLoggingRepresentation: {
                ingredients: mealLoggingRepresentation.ingredients,
                updatedAt: mealLoggingRepresentation.updatedAt,
                source: mealLoggingRepresentation.source,
              },
            }
          : {}),
      };
    });

    await AsyncStorage.setItem("recipes", JSON.stringify(next));
  } catch {
    // best-effort local enrichment
  }
}

export async function logRecipeMeal(
  recipe: SavedRecipe,
  servingMultiplier: number,
  options?: {
    nutritionOverride?: RecipeNutritionEstimate;
    ingredientsOverride?: MyDayMealIngredient[];
    persistRecipeEstimate?: boolean;
    date?: Date;
  }
) {
  const estimate = options?.nutritionOverride ?? estimateRecipeNutrition(recipe);
  if (options?.persistRecipeEstimate !== false) {
    await persistRecipeNutritionEstimate(recipe.id, estimate, recipe.mealLoggingRepresentation ?? null);
  }
  return addRecipeMeal({
    recipeId: recipe.id,
    title: recipe.title,
    servingMultiplier,
    calories: Math.round(estimate.caloriesPerServing * servingMultiplier),
    protein: Math.round(estimate.proteinPerServing * servingMultiplier),
    carbs: Math.round(estimate.carbsPerServing * servingMultiplier),
    fat: Math.round(estimate.fatPerServing * servingMultiplier),
    nutritionMode: "auto",
    automaticNutrition: {
      calories: Math.round(estimate.caloriesPerServing * servingMultiplier),
      protein: Math.round(estimate.proteinPerServing * servingMultiplier),
      carbs: Math.round(estimate.carbsPerServing * servingMultiplier),
      fat: Math.round(estimate.fatPerServing * servingMultiplier),
    },
    ingredients: options?.ingredientsOverride ?? [],
  }, options?.date);
}
