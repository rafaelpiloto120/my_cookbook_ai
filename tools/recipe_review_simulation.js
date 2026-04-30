const RECIPE_LOGGING_INITIAL_LIMIT = 8;
const REVIEW_DEFAULT_VISIBLE_COUNT = 6;

const RECIPE_IGNORED_PATTERNS = [
  /\bto taste\b/i,
  /\bif needed\b/i,
  /\bif necessary\b/i,
  /\bas needed\b/i,
  /\ba gosto\b/i,
  /\bal gusto\b/i,
  /\bau go[uû]t\b/i,
  /\bnach geschmack\b/i,
  /\bq\.?\s*b\.?\b/i,
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

const RECIPE_UNIT_PHRASES = [
  "colher de café","colheres de café","colher de sobremesa","colheres de sobremesa",
  "colher de sopa","colheres de sopa","colher de chá","colheres de chá",
  "cucharada","cucharadas","cucharadita","cucharaditas",
  "cuillère à soupe","cuillères à soupe","cuillère à café","cuillères à café",
  "esslöffel","esslöffeln","teelöffel","teelöffeln","el","tl",
  "chávena","chávenas","xícara","xícaras","taza","tazas","tasse","tasses","becher",
  "cup","cups","tbsp","tbsps","tsp","tsps","tablespoon","tablespoons","teaspoon","teaspoons",
  "clove","cloves","gousse","gousses","diente","dientes","embalagem","embalagens",
  "pacote","pacotes","package","packages","packung","packungen","dente","dentes",
  "ramo","ramos","ramita","ramitas","branche","branches","folha","folhas","sheet","sheets",
  "placa","placas","fatia","fatias","slice","slices","lata","latas","boîte","boîtes","dose","dosen",
  "can","cans","pinch","pinches","pitada","pitadas","pizca","pizcas","pincée","pincées","prise","prisen",
  "unidade","unidades","unit","units","un","und","g","kg","ml","l","oz","lb",
];

const LOW_IMPACT_REVIEW_INGREDIENT_PATTERNS = [
  /\bgarlic\b/i, /\balho\b/i, /\bclove\b/i, /\bcloves\b/i, /\bcravinho\b/i, /\bcravinhos\b/i,
  /\bshallot\b/i, /\bchalota\b/i, /\bparsley\b/i, /\bsalsa\b/i, /\bcilantro\b/i, /\bcoentros?\b/i,
  /\bmint\b/i, /\bhortel[aã]\b/i, /\bmenthe\b/i, /\bminze\b/i,
  /\bbasil\b/i, /\bmanjeric[aã]o\b/i, /\boregano\b/i, /\bor[eé]g[aã]os?\b/i, /\bthyme\b/i,
  /\btomilho\b/i, /\brosemary\b/i, /\balecrim\b/i, /\bchives?\b/i, /\bcebolinho\b/i,
  /\bpaprika\b/i, /\bcumin\b/i, /\bcominhos?\b/i, /\bcinnamon\b/i, /\bcanela\b/i,
  /\bnutmeg\b/i, /\bnoz-moscada\b/i, /\bpepper\b/i, /\bpimenta\b/i, /\bsalt\b/i, /\bsal\b/i,
  /\bbay leaf\b/i, /\blouro\b/i, /\bfolha de louro\b/i, /\bdente de alho\b/i, /\bknoblauch\b/i,
  /\bguindilla\b/i, /\bchili\b/i, /\bpiri-?piri\b/i,
  /\blemon zest\b/i, /\braspa de lim[aã]o\b/i,
];

const DEFAULT_SERVING_HINTS = [
  { match: /\b(olive oil|azeite|aceite de oliva|huile d'olive|olivenöl)\b/i, quantity: 14, unit: "g" },
  { match: /\b(butter|manteiga|mantequilla|beurre)\b/i, quantity: 10, unit: "g" },
  { match: /\b(honey|mel|miel|miel de abeja)\b/i, quantity: 21, unit: "g" },
  { match: /\b(yogurt|iogurte|yogur|yaourt)\b/i, quantity: 125, unit: "g" },
  { match: /\b(cream|natas?|creme|nata|double cream|crème fraîche|sahne)\b/i, quantity: 150, unit: "ml" },
  { match: /\b(milk|leite|leche|lait|milch)\b/i, quantity: 200, unit: "ml" },
  { match: /\b(cheese|queijo|queso|fromage|käse)\b/i, quantity: 30, unit: "g" },
  { match: /\b(chicken|frango|pollo|poulet|hähnchen)\b/i, quantity: 150, unit: "g" },
  { match: /\b(beef|carne de vaca|ternera|boeuf|rind)\b/i, quantity: 150, unit: "g" },
  { match: /\b(pork|porco|cerdo|porc|schwein)\b/i, quantity: 150, unit: "g" },
  { match: /\b(cod|bacalhau|bacalao|morue|kabeljau)\b/i, quantity: 150, unit: "g" },
  { match: /\b(salmon|salm[aã]o|salmón|saumon|lachs)\b/i, quantity: 150, unit: "g" },
  { match: /(?:fillet[s]?|filet[s]?|fil[eé]s?)\b/i, quantity: 150, unit: "g" },
  { match: /\b(chouri[cç]o|lingui[cç]a|sausage|sausages|chorizo|saucisse|wurst)\b/i, quantity: 100, unit: "g" },
  { match: /\b(rice|arroz|riz|reis)\b/i, quantity: 150, unit: "g" },
  { match: /\b(pasta|massa|macarr[aã]o|tagliatelle|nudeln)\b/i, quantity: 180, unit: "g" },
  { match: /\b(potato|potatoes|batata|batatas|patata|patatas|pommes de terre|kartoffeln?)\b/i, quantity: 180, unit: "g" },
  { match: /\b(onions?|cebolas?|cebollas?|oignons?|zwiebeln?)\b/i, quantity: 80, unit: "g" },
  { match: /\b(tomato|tomates?|tomate|tomaten?)\b/i, quantity: 120, unit: "g" },
  { match: /\b(cucumber|pepino|concombre|gurke)\b/i, quantity: 250, unit: "g" },
  { match: /\b(carrot|carrots|cenoura|cenouras|zanahoria|zanahorias|carotte|carottes|karotte|karotten)\b/i, quantity: 80, unit: "g" },
  { match: /\b(celery stalk|celery|aipo|apio|c[eé]leri|sellerie|selleriestange)\b/i, quantity: 40, unit: "g" },
  { match: /\b(bell pepper|bell peppers|pepper|peppers|piment[aã]o|piment[õo]es|pimiento|pimientos|poivron|poivrons|paprika)\b/i, quantity: 150, unit: "g" },
  { match: /\b(zucchini|courgette|courgettes|curgete|curgetes|calabac[ií]n|calabacines|zucchinis?)\b/i, quantity: 200, unit: "g" },
  { match: /\b(eggplant|aubergine|aubergines|beringela|berenjena)\b/i, quantity: 280, unit: "g" },
  { match: /\b(cabbage|couve|repolho|repollo|choux?|kohl)\b/i, quantity: 250, unit: "g" },
  { match: /\b(lemon|lim[aã]o|lim[oó]n|citron|zitrone|lime|lima)\b/i, quantity: 120, unit: "g" },
  { match: /\b(mushroom|mushrooms|cogumelos?|champignons?|setas?)\b/i, quantity: 120, unit: "g" },
  { match: /\b(egg|eggs|ovo|ovos|huevo|huevos|oeufs?|eier)\b/i, quantity: 50, unit: "g" },
  { match: /\b(bean|beans|feij[aã]o|frijoles|haricots|bohnen)\b/i, quantity: 130, unit: "g" },
  { match: /\b(wine|vinho|vino|vin)\b/i, quantity: 150, unit: "ml" },
  { match: /\b(vinegar|vinagre|vinaigre|essig)\b/i, quantity: 15, unit: "ml" },
  { match: /\b(bechamel|béchamel)\b/i, quantity: 125, unit: "ml" },
  { match: /\b(tomato sauce|molho de tomate|salsa de tomate|sauce tomate)\b/i, quantity: 125, unit: "g" },
  { match: /\b(breadcrumbs?|bread crumbs?|pan rallado|p[aã]o ralado|chapelure|paniermehl)\b/i, quantity: 40, unit: "g" },
  { match: /\b(puff pastry|massa folhada|massa quebrada|p[aâ]te bris[eé]e|m[uü]rbeteig)\b/i, quantity: 230, unit: "g" },
  { match: /\b(bread slices?|sliced bread|tranches? de pain|tranches? de pain de mie|p[aã]o de forma)\b/i, quantity: 30, unit: "g" },
  { match: /\b(ham slices?|tranches? de jambon|fatias? de presunto|lonchas? de jam[oó]n)\b/i, quantity: 25, unit: "g" },
];

function cleanRecipeIngredientLine(line) {
  return String(line || "")
    .replace(/^\s*[•*-]\s*/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/^\s*maybe\s+/i, "")
    .replace(/\s+(if needed|if necessary|as needed)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRecipeLineForRelevanceCheck(line) {
  return cleanRecipeIngredientLine(line)
    .replace(/^\s*(?:\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*/i, "")
    .replace(/^\s*(kg|g|mg|ml|l|lb|oz|tbsp|tbsps|tsp|tsps|tablespoons?|teaspoons?|cups?|colher(?:es)? de sopa|colher(?:es)? de chá|cucharadas?|cucharaditas?|cuill[eè]res? à soupe|cuill[eè]res? à caf[eé]|esslöffel|teelöffel|el|tl|clove|cloves|gousse|gousses|diente|dientes|dente|dentes|ramo|ramos|ramita|ramitas|branche|branches|folha|folhas|sheet|sheets|placa|placas|fatia|fatias|slice|slices|lata|latas|bo[iî]te|bo[iî]tes|dose|dosen|can|cans|pinch|pinches|pitada|pitadas|pizca|pizcas|pinc[eé]e|pinc[eé]es|prise|prisen|unidade|unidades|unit|units|un|und)\b\s*/i, "")
    .replace(/^\s*(de|da|do|das|dos)\s+/i, "")
    .trim();
}

function isRelevantRecipeIngredientLine(line) {
  const cleaned = normalizeRecipeLineForRelevanceCheck(line);
  if (!cleaned) return false;
  return !RECIPE_IGNORED_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function scoreRecipeIngredientLine(line) {
  const cleaned = cleanRecipeIngredientLine(line);
  const lower = cleaned.toLowerCase();
  let score = 0;
  const quantityMatch = lower.match(/^(\d+(?:[.,]\d+)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*(.*)$/i);
  const quantityToken = quantityMatch?.[1] ?? null;
  const remainder = (quantityMatch?.[2] ?? lower).trim();

  if (/\b(kg|g|ml|l|oz|lb)\b/.test(remainder)) score += 5;
  if (/\b(cup|cups|tablespoon|tablespoons|teaspoon|teaspoons|tbsp|tsp|colher de sopa|colheres de sopa|colher de chá|colheres de chá|cucharada|cucharadita|cuillère à soupe|cuillère à café|esslöffel|teelöffel|el|tl)\b/.test(remainder)) score += 2;
  if (/\b(chicken|beef|pork|salmon|fish|shrimp|tofu|rice|pasta|potato|tomato|cream|cheese|milk|yogurt|egg|eggs|mushroom|cogumelos?|nata|natas|queijo|frango|arroz|massa|batata|tomate|tomates|pollo|queso|huevo|huevos|champignons?|sahne|käse|hähnchen|reis|nudeln|bacalhau|bacalao|morue|kabeljau|vinho|vino|vin|wine|bechamel|béchamel|chorizo|chouri[cç]o|lingui[cç]a)\b/.test(lower)) score += 6;
  if (/\b(garlic|alho|ajo|ail|knoblauch|shallot|chalota|echalote|parsley|salsa|persil|cilantro|coentro|coriandre|mint|hortel[aã]|menthe|minze|oregano|or[eé]g[aã]os?|basil|manjeric[aã]o|basilic|thyme|tomilho|thym|rosemary|alecrim|romarin|bay leaf|louro|laurier|clove|cloves|cravinho|cravinhos|guindilla|chili|piri-?piri|nutmeg|noz-moscada|muscade|paprika|cumin|cominho|cominos?)\b/.test(lower)) score -= 5;
  if (/\b(optional|opcional|facultatif|for garnish|for serving|to taste|a gosto|al gusto|au goût|nach geschmack|q\.?\s*b\.?)\b/.test(lower)) score -= 6;

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

function getRelevantRecipeIngredientLines(recipe, limit = 8) {
  const sourceLines = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const relevant = sourceLines
    .map((line, index) => ({ line: cleanRecipeIngredientLine(line), index }))
    .filter((entry) => Boolean(entry.line))
    .filter((entry) => isRelevantRecipeIngredientLine(entry.line))
    .sort((a, b) => {
      const diff = scoreRecipeIngredientLine(b.line) - scoreRecipeIngredientLine(a.line);
      return diff || a.index - b.index;
    })
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.line)
    .filter(Boolean);
  return relevant.length ? relevant : sourceLines.map(cleanRecipeIngredientLine).filter(Boolean).slice(0, limit);
}

function parseRecipeQuantityToken(token) {
  const normalized = token.trim().replace(",", ".").replace(/^½$/, "0.5").replace(/^¼$/, "0.25").replace(/^¾$/, "0.75").replace(/^⅓$/, "0.33").replace(/^⅔$/, "0.67");
  if (/^\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?$/.test(normalized)) {
    const [start, end] = normalized.split("-").map((part) => Number(part.trim().replace(",", ".")));
    if (Number.isFinite(start) && Number.isFinite(end)) return String(Math.round(((start + end) / 2) * 100) / 100);
  }
  if (/^\d+\s+\d+\/\d+$/.test(normalized)) {
    const [whole, fraction] = normalized.split(/\s+/);
    const [num, den] = fraction.split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return String(Number(whole) + num / den);
  }
  if (/^\d+\/\d+$/.test(normalized)) {
    const [num, den] = normalized.split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return String(num / den);
  }
  return normalized;
}

function normalizeRecipeIngredientName(name) {
  const cleaned = String(name || "")
    .trim()
    .replace(/\([^)]*\)/g, "")
    .replace(/,\s*(chopped|minced|diced|sliced|grated|melted|softened|beaten|peeled|drained|mixed|picado|picada|picados|picadas|cortado|cortada|cortados|cortadas|rallado|rallada|ralado|ralada|escorrido|escorrida|pelado|pelada|hach[eé]e?|emin[cé]e?|geschnitten|gehackt)\b.*$/i, "")
    .replace(/^\s*(?:\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*(kg|g|mg|ml|l|lb|oz)\s+/i, "")
    .replace(/^\s*(?:\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*(?:heaped|heaping|rounded|level|generous)?\s*(tbsp|tbsps|tsp|tsps|tablespoons?|teaspoons?|cups?|colher(?:es)? de sopa|colher(?:es)? de chá|cucharadas?|cucharaditas?|cuill[eè]res? à soupe|cuill[eè]res? à caf[eé]|esslöffel|teelöffel|el|tl)\s+/i, "")
    .replace(/^\s*(?:can|cans|tin|tins|jar|jars|package|packages|pack|packs|lata|latas|bo[iî]te|bo[iî]tes|dose|dosen|pacote|pacotes|embalagem|embalagens|packung|packungen)\s+/i, "")
    .replace(/^\s*de\s+/i, "").replace(/^\s*da\s+/i, "").replace(/^\s*do\s+/i, "").replace(/^\s*das\s+/i, "").replace(/^\s*dos\s+/i, "")
    .replace(/\b(grande|grandes|pequena|pequenas|pequeno|pequenos|m[eé]dia|m[eé]dias|m[eé]dio|m[eé]dios|large|small|medium)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function getDefaultServingForIngredient(name) {
  const candidates = [
    name,
    name.replace(/\b(\w+?)oes\b/gi, "$1o"),
    name.replace(/\b(\w+?)ies\b/gi, "$1y"),
    name.replace(/\b(\w+?)es\b/gi, "$1"),
    name.replace(/\b(\w+?)s\b/gi, "$1"),
  ].filter(Boolean);
  return candidates.map((candidate) => DEFAULT_SERVING_HINTS.find((hint) => hint.match.test(candidate))).find(Boolean) || null;
}

function normalizeLoggingIngredient(item) {
  const name = normalizeRecipeIngredientName(String(item.name || ""));
  if (!name || name.length < 2) return null;
  const rawQuantity = Number(String(item.quantity || "1").replace(",", "."));
  let quantity = Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1;
  let unit = String(item.unit || "serving").trim().toLowerCase() || "serving";

  if (unit === "serving" || unit === "unit" || unit === "units" || unit === "un" || unit === "und") {
    const serving = getDefaultServingForIngredient(name);
    if (serving) {
      quantity *= serving.quantity;
      unit = serving.unit.toLowerCase();
    }
  } else if (unit === "lb") {
    quantity *= 453.59237; unit = "g";
  } else if (unit === "oz") {
    quantity *= 28.349523125; unit = "g";
  } else if (["tbsp","tbsps","tablespoon","tablespoons","colher de sopa","colheres de sopa","cucharada","cucharadas","cuillère à soupe","cuillères à soupe","esslöffel","esslöffeln","el"].includes(unit)) {
    quantity *= 15; unit = "ml";
  } else if (["tsp","tsps","teaspoon","teaspoons","colher de chá","colheres de chá","cucharadita","cucharaditas","cuillère à café","cuillères à café","teelöffel","teelöffeln","tl"].includes(unit)) {
    quantity *= 5; unit = "ml";
  } else if (["cup","cups","chávena","chávenas","xícara","xícaras","taza","tazas","tasse","tasses","becher"].includes(unit)) {
    quantity *= 240; unit = "ml";
  }

  return { name, quantity: String(Math.round(quantity * 100) / 100), unit };
}

function loggingIngredientKey(item) {
  return `${item.name.trim().toLowerCase()}::${item.unit.trim().toLowerCase()}`;
}

function scoreLoggingIngredient(item) {
  const name = item.name.trim().toLowerCase();
  const unit = item.unit.trim().toLowerCase();
  const quantity = Number(String(item.quantity).replace(",", "."));
  let score = 0;

  if (/\b(chicken|frango|pollo|beef|carne|vaca|pork|porco|salmon|salm[aã]o|fish|peixe|shrimp|camar[aã]o|rice|arroz|pasta|massa|potato|batata|tomato|tomate|cream|natas?|cheese|queijo|milk|leite|yogurt|iogurte|egg|ovo|mushroom|cogumelo|beans|feij[aã]o|bread|p[aã]o|wrap|tortilla|avocado|abacate|bacalhau|bacalao|morue|kabeljau|bechamel|béchamel|chorizo|chouri[cç]o|lingui[cç]a|sausage|saucisse|wurst)\b/i.test(name)) score += 7;
  if (/\b(garlic|alho|ajo|ail|knoblauch|shallot|chalota|echalote|parsley|salsa|persil|cilantro|coentro|coriandre|mint|hortel[aã]|menthe|minze|oregano|or[eé]g[aã]os?|basil|manjeric[aã]o|basilic|thyme|tomilho|thym|rosemary|alecrim|romarin|bay leaf|louro|laurier|clove|cloves|cravinho|cravinhos|guindilla|chili|piri-?piri|nutmeg|noz-moscada|muscade|paprika|cumin|cominho|cominos?|salt|sal|pepper|pimenta|water|ice)\b/i.test(name)) score -= 8;
  if (Number.isFinite(quantity)) {
    if (unit === "g" || unit === "ml") {
      if (quantity >= 150) score += 5;
      else if (quantity >= 50) score += 3;
      else if (quantity <= 15) score -= 2;
    } else if (unit === "kg" || unit === "l") score += 5;
    else if (unit === "serving") score -= 2;
    else if (unit === "un" || unit === "unit" || unit === "units") { if (quantity >= 1 && quantity <= 6) score += 1; }
    else score += 1;
  }
  return score;
}

function isLowSignalLoggingIngredient(item) {
  return scoreLoggingIngredient(item) <= 0;
}

function mergeLoggingIngredients(ingredients) {
  const merged = new Map();
  for (const item of ingredients) {
    const normalized = normalizeLoggingIngredient(item);
    if (!normalized) continue;
    const key = loggingIngredientKey(normalized);
    const existing = merged.get(key);
    if (!existing) { merged.set(key, normalized); continue; }
    const eq = Number(existing.quantity); const nq = Number(normalized.quantity);
    if (Number.isFinite(eq) && Number.isFinite(nq)) existing.quantity = String(Math.round((eq+nq)*100)/100);
  }
  return [...merged.values()];
}

function parseRecipeIngredientLine(input) {
  const trimmed = cleanRecipeIngredientLine(input);
  const compactMetricMatch = trimmed.match(/^\s*((?:\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔))\s*(kg|g|mg|ml|l|lb|oz)\s+(.+)$/i);
  if (compactMetricMatch) {
    const [, quantity, unit, rawName] = compactMetricMatch;
    return { name: normalizeRecipeIngredientName(rawName) || trimmed, quantity: parseRecipeQuantityToken(quantity), unit: unit.toLowerCase() };
  }

  const quantifiedUnitMatch = trimmed.match(/^\s*((?:\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔|one|two|three|four|five|six|seven|eight|nine|ten|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|ein|eine|zwei|drei|vier|f[uü]nf|sechs|sieben|acht|neun|zehn))\s*(?:heaped|heaping|rounded|level|generous)?\s*(tbsp|tbsps|tsp|tsps|tablespoons?|teaspoons?|cups?|colher(?:es)? de sopa|colher(?:es)? de chá|cucharadas?|cucharaditas?|cuill[eè]res? à soupe|cuill[eè]res? à caf[eé]|esslöffel|teelöffel|el|tl)\s+(.+)$/i);
  if (quantifiedUnitMatch) {
    const [, quantity, unit, rawName] = quantifiedUnitMatch;
    return { name: normalizeRecipeIngredientName(rawName) || trimmed, quantity: parseRecipeQuantityToken(quantity), unit: unit.toLowerCase() };
  }

  const quantityMatch = trimmed.match(/^\s*((?:\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔|one|two|three|four|five|six|seven|eight|nine|ten|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|ein|eine|zwei|drei|vier|f[uü]nf|sechs|sieben|acht|neun|zehn))\s+(.+)$/i);
  if (!quantityMatch) return { name: trimmed, quantity: "1", unit: "serving" };
  const [, quantity, remainderRaw] = quantityMatch;
  const remainder = remainderRaw.trim();
  const lowerRemainder = remainder.toLowerCase();
  const matchedUnit = [...RECIPE_UNIT_PHRASES].sort((a,b)=>b.length-a.length).find((unit)=> lowerRemainder===unit || lowerRemainder.startsWith(`${unit} `));
  if (matchedUnit) {
    const rest = normalizeRecipeIngredientName(remainder.slice(matchedUnit.length));
    return { name: rest || normalizeRecipeIngredientName(trimmed), quantity: parseRecipeQuantityToken(quantity), unit: matchedUnit.toLowerCase() };
  }
  if (!/\b(de|da|do|das|dos|with|com)\b/i.test(remainder)) {
    return { name: normalizeRecipeIngredientName(remainder) || trimmed, quantity: parseRecipeQuantityToken(quantity), unit: "un" };
  }
  return { name: normalizeRecipeIngredientName(remainder) || trimmed, quantity: parseRecipeQuantityToken(quantity), unit: "serving" };
}

function buildRecipeMealLoggingRepresentation(recipe, limit = RECIPE_LOGGING_INITIAL_LIMIT) {
  const ingredients = getRelevantRecipeIngredientLines(recipe, limit * 2).map(parseRecipeIngredientLine);
  const normalized = mergeLoggingIngredients(ingredients);
  const ranked = normalized.map((item,index)=>({item,index,score:scoreLoggingIngredient(item)})).sort((a,b)=>b.score-a.score || a.index-b.index);
  const substantive = ranked.filter((entry)=>entry.score>=4).map((entry)=>entry.item);
  const filteredSource = substantive.length >= 2 && ranked.length >= 4 ? ranked.filter((entry)=>!isLowSignalLoggingIngredient(entry.item)).map((entry)=>entry.item) : ranked.map((entry)=>entry.item);
  return filteredSource.slice(0, limit);
}

function isLowImpactReviewIngredient(item) {
  const name = item.name.trim().toLowerCase()
    .replace(/^\s*(?:\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*/i,"")
    .replace(/^\s*(kg|g|mg|ml|l|lb|oz|tbsp|tbsps|tsp|tsps|tablespoons?|teaspoons?|cups?|clove|cloves|gousse|gousses|diente|dientes|dente|dentes|folha|folhas|slice|slices|fatia|fatias|unit|units|un|und|serving|servings)\b\s*/i,"")
    .replace(/^\s*(de|da|do|das|dos)\s+/i,"").trim();
  const unit = item.unit.trim().toLowerCase();
  const quantity = Number(String(item.quantity).replace(",", "."));
  const matches = LOW_IMPACT_REVIEW_INGREDIENT_PATTERNS.some((pattern)=>pattern.test(name));
  if (!matches) return false;
  if (!Number.isFinite(quantity) || quantity <= 0) return true;
  if (unit === "g" || unit === "ml") return quantity <= 30;
  if (unit === "kg" || unit === "l") return quantity <= 0.05;
  return true;
}

function getCollapsedReviewIngredients(ingredients) {
  return ingredients
    .map((item,index)=>({item,index,lowImpact:isLowImpactReviewIngredient(item)}))
    .sort((a,b)=> a.lowImpact === b.lowImpact ? a.index - b.index : (a.lowImpact ? 1 : -1))
    .slice(0, REVIEW_DEFAULT_VISIBLE_COUNT)
    .map((entry)=>entry.item);
}

function buildRecipes() {
  const recipes = [];
  const langs = {
    en: [
      ["Chicken tikka masala", ["500 g chicken thighs","150 g plain yogurt","2 tbsp lemon juice","3 cloves garlic","1 tbsp grated ginger","1 onion","400 g canned tomatoes","150 ml heavy cream","1 tsp garam masala","1 tsp paprika"]],
      ["Mushroom risotto", ["320 g arborio rice","300 g mushrooms","1 onion","80 ml white wine","1 l vegetable stock","40 g butter","60 g parmesan","2 tbsp olive oil"]],
      ["Lasagna", ["500 g ground beef","1 onion","2 cloves garlic","700 ml tomato sauce","250 g lasagna sheets","400 g ricotta","300 g mozzarella","80 g parmesan"]],
      ["Salmon tray bake", ["4 salmon fillets","600 g potatoes","250 g broccoli","2 tbsp olive oil","1 lemon","1 tsp dill"]],
      ["Creamy chicken pasta", ["400 g chicken breast","300 g pasta","200 ml cream","80 g parmesan","1 onion","2 cloves garlic"]],
      ["Beef stew", ["700 g beef chuck","300 g carrots","250 g potatoes","1 onion","250 ml red wine","500 ml beef stock","2 bay leaves"]],
      ["Vegetable curry", ["400 g chickpeas","300 g cauliflower","250 g sweet potato","200 ml coconut milk","1 onion","2 tbsp curry paste"]],
      ["Tuna pasta bake", ["300 g pasta","2 cans tuna","250 ml bechamel sauce","120 g grated cheese","1 onion","2 tbsp olive oil"]],
      ["Greek chicken bowl", ["450 g chicken breast","250 g rice","150 g greek yogurt","1 cucumber","2 tomatoes","60 g feta"]],
      ["Shepherd's pie", ["600 g minced lamb","500 g potatoes","200 g peas","1 onion","150 ml stock","30 g butter"]],
      ["Ramen bowl", ["300 g ramen noodles","250 g chicken thighs","2 eggs","200 g mushrooms","700 ml broth","1 tbsp soy sauce"]],
      ["Mac and cheese", ["350 g macaroni","300 ml milk","200 ml cream","250 g cheddar","30 g butter","20 g flour"]],
      ["Shrimp fried rice", ["350 g rice","250 g shrimp","2 eggs","120 g peas","1 carrot","1 tbsp sesame oil"]],
      ["Stuffed peppers", ["4 bell peppers","400 g minced beef","200 g rice","250 ml tomato sauce","1 onion","80 g cheese"]],
      ["Chicken fajitas", ["500 g chicken breast","3 tortillas","2 bell peppers","1 onion","2 tbsp olive oil","120 g yogurt"]],
      ["Potato gratin", ["1 kg potatoes","400 ml cream","200 ml milk","2 cloves garlic","30 g butter","80 g cheese"]],
      ["Lentil soup", ["300 g lentils","1 onion","2 carrots","1 celery stalk","1.2 l stock","2 tbsp olive oil"]],
      ["Ultra messy harvest pie (stress test)", ["1 1/2 lb sweet potatos, peeled","250g mushrooms, mixed","400 g can lentils, drained","1 heaped tbsp tomato paste","120 ml red wine","75 g cheddar","maybe 30ml milk if needed"]],
    ],
    ptPT: [
      ["Bacalhau com natas", ["400 g de bacalhau demolhado","500 g de batatas","1 cebola grande","2 dentes de alho","200 ml de natas","250 ml de molho bechamel","80 g de queijo ralado","2 colheres de sopa de azeite"]],
      ["Arroz de frango", ["500 g de peito de frango","300 g de arroz","1 cebola","2 dentes de alho","1 tomate","700 ml de caldo de galinha","2 colheres de sopa de azeite"]],
      ["Massa no forno com cogumelos", ["350 g de massa","300 g de cogumelos mistos","200 ml de natas","150 g de queijo mozzarella","1 cebola","2 colheres de sopa de azeite"]],
      ["Carne de vinha d'alhos", ["800 g de carne de porco","30 g de banha de porco","150 ml de vinho branco","15 ml de vinagre de vinho","2 cravinhos da Índia","1 folha de louro","2 dentes de alho"]],
      ["Quiche de espinafres", ["1 embalagem de massa quebrada","200 g de espinafres","4 ovos","200 ml de natas","120 g de queijo de cabra","1 cebola roxa"]],
      ["Açorda de camarão", ["300 g de camarão","250 g de pão","4 dentes de alho","1 molho de coentros","50 ml de azeite","2 ovos","800 ml de água"]],
      ["Empadão de carne", ["500 g de carne picada","700 g de puré de batata","1 cebola","2 dentes de alho","150 ml de molho de tomate","80 g de queijo ralado"]],
      ["Caldeirada de peixe", ["700 g de peixe branco","400 g de batatas","2 tomates","1 cebola","150 ml de vinho branco","40 ml de azeite","1 folha de louro"]],
      ["Arroz de pato", ["600 g de pato desfiado","350 g de arroz","1 chouriço","1 cebola","80 ml de vinho branco","900 ml de caldo"]],
      ["Feijoada à transmontana", ["500 g de feijão branco","400 g de entrecosto","200 g de chouriço","1 cebola","2 dentes de alho","1 folha de louro"]],
      ["Bifes com molho de natas", ["500 g de bifes de vaca","200 ml de natas","1 cebola","20 g de manteiga","100 ml de vinho branco"]],
      ["Jardineira de vitela", ["700 g de vitela","300 g de batatas","200 g de cenoura","150 g de ervilhas","1 cebola","2 colheres de sopa de azeite"]],
      ["Bacalhau à Brás", ["400 g de bacalhau","300 g de batata palha","6 ovos","1 cebola","30 ml de azeite","1 ramo de salsa"]],
      ["Frango assado com batatas", ["1 frango inteiro","800 g de batatas","2 dentes de alho","40 ml de azeite","1 limão","1 ramo de alecrim"]],
      ["Lasanha de atum", ["2 latas de atum","300 g de placas de lasanha","250 ml de molho bechamel","150 g de queijo ralado","1 cebola","2 colheres de sopa de azeite"]],
      ["Ervilhas com ovos escalfados", ["400 g de ervilhas","1 cebola","80 g de chouriço","4 ovos","20 ml de azeite"]],
      ["Polvo à lagareiro", ["1 kg de polvo","800 g de batatas a murro","80 ml de azeite","4 dentes de alho"]],
    ],
    ptBR: [
      ["Escondidinho de frango", ["500 g de peito de frango desfiado","700 g de mandioca","2 colheres de sopa de manteiga","150 ml de leite","1 copo de requeijão","150 g de muçarela"]],
      ["Strogonoff de carne", ["500 g de alcatra","200 g de champignon","200 ml de creme de leite","2 colheres de sopa de ketchup","1 cebola","1 colher de sopa de manteiga"]],
      ["Moqueca de peixe", ["700 g de peixe branco","1 pimentão vermelho","1 pimentão amarelo","2 tomates","1 cebola","200 ml de leite de coco","30 ml de azeite de dendê"]],
      ["Feijoada simples", ["500 g de feijão preto","300 g de linguiça calabresa","300 g de carne seca","1 cebola","4 dentes de alho","2 folhas de louro"]],
      ["Lasanha de frango", ["500 g de frango desfiado","300 g de massa para lasanha","250 ml de molho branco","200 g de muçarela","1 cebola","2 colheres de sopa de azeite"]],
      ["Arroz carreteiro", ["500 g de carne seca","350 g de arroz","1 cebola","2 dentes de alho","1 tomate","2 colheres de sopa de óleo"]],
      ["Torta de palmito", ["1 pacote de massa folhada","300 g de palmito","200 ml de creme de leite","1 cebola","2 ovos","100 g de queijo ralado"]],
      ["Bobó de camarão", ["500 g de camarão","600 g de mandioca","200 ml de leite de coco","1 cebola","2 tomates","30 ml de azeite de dendê"]],
      ["Frango com quiabo", ["700 g de frango","250 g de quiabo","1 cebola","2 dentes de alho","2 colheres de sopa de óleo"]],
      ["Panqueca de carne", ["400 g de carne moída","8 discos de panqueca","250 ml de molho de tomate","150 g de queijo","1 cebola"]],
      ["Arroz de forno", ["300 g de arroz","250 g de presunto","200 g de muçarela","150 g de milho","1 cenoura","200 ml de molho branco"]],
      ["Macarrão ao molho branco", ["350 g de macarrão","300 ml de leite","200 ml de creme de leite","80 g de parmesão","20 g de manteiga","20 g de farinha"]],
      ["Picadinho com purê", ["500 g de patinho","700 g de purê de batata","1 cebola","1 tomate","150 ml de caldo"]],
      ["Quibe assado", ["500 g de carne moída","250 g de trigo para quibe","1 cebola","1 maço de hortelã","30 ml de azeite"]],
      ["Camarão na moranga", ["600 g de camarão","400 g de abóbora","200 ml de creme de leite","150 g de requeijão","1 cebola"]],
      ["Galinhada", ["700 g de frango","350 g de arroz","1 cebola","2 dentes de alho","1 tomate","2 colheres de sopa de óleo"]],
      ["Virado à paulista", ["400 g de feijão","300 g de arroz","300 g de bisteca suína","2 ovos","1 couve","100 g de torresmo"]],
    ],
    es: [
      ["Paella mixta", ["400 g de arroz","300 g de pollo","250 g de marisco","150 g de judías verdes","1 pimiento rojo","2 tomates","1 litro de caldo"]],
      ["Tortilla de patatas", ["6 huevos","500 g de patatas","2 cebollas","4 cucharadas de aceite de oliva"]],
      ["Lasaña de verduras", ["12 láminas de lasaña","1 berenjena","2 calabacines","1 pimiento rojo","400 g de tomate triturado","250 g de ricotta","150 g de mozzarella rallada"]],
      ["Cocido madrileño", ["400 g de garbanzos","300 g de morcillo","200 g de chorizo","300 g de patatas","1 zanahoria","1 repollo"]],
      ["Pollo al ajillo", ["700 g de pollo","8 dientes de ajo","150 ml de vino blanco","40 ml de aceite de oliva","1 hoja de laurel"]],
      ["Bacalao al pil pil", ["600 g de bacalao","150 ml de aceite de oliva","4 dientes de ajo","1 guindilla"]],
      ["Arroz con pollo", ["500 g de pollo","300 g de arroz","1 cebolla","1 pimiento rojo","2 tomates","800 ml de caldo"]],
      ["Fabada asturiana", ["500 g de fabes","300 g de chorizo","200 g de morcilla","200 g de panceta","1 cebolla"]],
      ["Merluza en salsa verde", ["700 g de merluza","1 cebolla","2 dientes de ajo","150 ml de vino blanco","1 manojo de perejil","400 ml de caldo"]],
      ["Croquetas de jamón", ["200 g de jamón","500 ml de leche","50 g de mantequilla","50 g de harina","1 huevo","pan rallado"]],
      ["Gazpacho andaluz", ["1 kg de tomates","1 pepino","1 pimiento verde","1 diente de ajo","60 ml de aceite de oliva","30 ml de vinagre"]],
      ["Albóndigas en salsa", ["500 g de carne picada","1 huevo","1 cebolla","2 dientes de ajo","300 ml de tomate triturado","150 ml de caldo"]],
      ["Fideuá", ["350 g de fideos","300 g de marisco","1 tomate","1 cebolla","800 ml de caldo","40 ml de aceite"]],
      ["Huevos rotos con jamón", ["600 g de patatas","4 huevos","120 g de jamón serrano","40 ml de aceite de oliva"]],
      ["Pollo en pepitoria", ["700 g de pollo","1 cebolla","2 huevos","50 g de almendras","150 ml de vino blanco"]],
      ["Pisto manchego", ["2 calabacines","1 berenjena","2 pimientos","400 g de tomate triturado","1 cebolla","40 ml de aceite"]],
      ["Lentejas estofadas", ["400 g de lentejas","1 cebolla","2 zanahorias","1 pimiento verde","150 g de chorizo","1 hoja de laurel"]],
    ],
    fr: [
      ["Quiche lorraine", ["1 pâte brisée","200 g de lardons","4 oeufs","200 ml de crème fraîche","100 ml de lait","100 g de gruyère râpé"]],
      ["Gratin dauphinois", ["1 kg de pommes de terre","400 ml de crème liquide","200 ml de lait","2 gousses d'ail","30 g de beurre"]],
      ["Boeuf bourguignon", ["800 g de boeuf","200 g de carottes","150 g d'oignons","250 ml de vin rouge","400 ml de bouillon","200 g de champignons"]],
      ["Blanquette de veau", ["800 g de veau","2 carottes","1 oignon","200 ml de crème","1 jaune d'oeuf","500 ml de bouillon"]],
      ["Ratatouille", ["2 courgettes","1 aubergine","2 poivrons","400 g de tomates","1 oignon","40 ml d'huile d'olive"]],
      ["Tartiflette", ["1 kg de pommes de terre","200 g de lardons","1 oignon","250 ml de crème","450 g de reblochon"]],
      ["Poulet basquaise", ["700 g de poulet","2 poivrons","1 oignon","400 g de tomates","150 ml de vin blanc","30 ml d'huile d'olive"]],
      ["Cassoulet", ["500 g de haricots blancs","300 g de confit de canard","250 g de saucisse","150 g de lardons","1 oignon"]],
      ["Hachis parmentier", ["500 g de boeuf haché","700 g de purée de pommes de terre","1 oignon","100 ml de lait","40 g de beurre","80 g de fromage râpé"]],
      ["Soupe à l'oignon", ["5 oignons","40 g de beurre","150 ml de vin blanc","800 ml de bouillon","6 tranches de pain","120 g de gruyère"]],
      ["Saumon en papillote", ["4 pavés de saumon","400 g de pommes de terre","200 g de courgettes","1 citron","20 ml d'huile d'olive"]],
      ["Croque-monsieur gratiné", ["8 tranches de pain de mie","4 tranches de jambon","150 g de fromage râpé","200 ml de béchamel"]],
      ["Lasagnes aux épinards", ["250 g de feuilles de lasagne","300 g d'épinards","250 g de ricotta","200 ml de béchamel","120 g de mozzarella"]],
      ["Coq au vin", ["1 kg de poulet","200 g de champignons","150 g d'oignons grelots","250 ml de vin rouge","150 g de lardons"]],
      ["Parmentier de canard", ["500 g de confit de canard","700 g de pommes de terre","100 ml de lait","30 g de beurre","1 oignon"]],
      ["Gratin de courgettes", ["600 g de courgettes","200 ml de crème","2 oeufs","100 g de fromage râpé","1 gousse d'ail"]],
      ["Riz au poulet et champignons", ["500 g de poulet","300 g de riz","250 g de champignons","1 oignon","700 ml de bouillon","30 ml d'huile"]],
    ],
    de: [
      ["Spaghetti Carbonara", ["350 g Spaghetti","150 g Speck","3 Eier","80 g Parmesan","20 g Butter"]],
      ["Kartoffelgratin", ["1 kg Kartoffeln","400 ml Sahne","200 ml Milch","2 Knoblauchzehen","30 g Butter","80 g Käse"]],
      ["Hähnchengeschnetzeltes", ["600 g Hähnchenbrust","250 g Champignons","1 Zwiebel","200 ml Sahne","150 ml Brühe","20 g Butter"]],
      ["Rindergulasch", ["800 g Rindfleisch","2 Zwiebeln","300 g Kartoffeln","200 g Karotten","250 ml Rotwein","500 ml Brühe"]],
      ["Lachs mit Kartoffeln", ["4 Lachsfilets","600 g Kartoffeln","250 g Brokkoli","2 EL Olivenöl","1 Zitrone"]],
      ["Pilzrahmsoße mit Tagliatelle", ["300 g Tagliatelle","400 g Champignons","1 Zwiebel","2 Knoblauchzehen","200 ml Sahne","100 ml Gemüsebrühe","30 g Butter"]],
      ["Lasagne", ["500 g Hackfleisch","1 Zwiebel","2 Knoblauchzehen","700 ml Tomatensoße","250 g Lasagneblätter","200 ml Béchamelsauce","250 g Käse"]],
      ["Linseneintopf", ["400 g Linsen","2 Karotten","300 g Kartoffeln","1 Zwiebel","150 g Speck","1 l Brühe"]],
      ["Käsespätzle", ["400 g Spätzle","250 g Käse","2 Zwiebeln","20 g Butter","150 ml Sahne"]],
      ["Schweinebraten", ["1 kg Schweinebraten","800 g Kartoffeln","2 Zwiebeln","250 ml Bier","400 ml Brühe"]],
      ["Paprikahuhn", ["700 g Hähnchen","2 Paprika","1 Zwiebel","200 ml Sahne","150 ml Brühe","1 EL Paprika"]],
      ["Auflauf mit Brokkoli", ["500 g Brokkoli","300 g Kartoffeln","200 ml Sahne","150 g Käse","2 Eier"]],
      ["Fischfrikadellen", ["500 g Kabeljau","1 Ei","80 g Paniermehl","1 Zwiebel","20 ml Öl"]],
      ["Reispfanne mit Gemüse", ["300 g Reis","1 Zucchini","1 Paprika","1 Zwiebel","150 g Erbsen","20 ml Öl"]],
      ["Hackbällchen in Soße", ["500 g Hackfleisch","1 Ei","1 Zwiebel","300 ml Tomatensoße","150 ml Brühe"]],
      ["Hühnersuppe", ["600 g Hähnchen","2 Karotten","1 Selleriestange","1 Zwiebel","1 l Brühe","100 g Nudeln"]],
      ["Gemüsequiche", ["1 Packung Mürbeteig","300 g Gemüse","3 Eier","200 ml Sahne","120 g Käse"]],
    ],
  };

  Object.entries(langs).forEach(([lang, items]) => {
    items.forEach(([title, ingredients], idx) => recipes.push({ id: `${lang}-${idx+1}`, lang, title, ingredients }));
  });
  return recipes;
}

function detectIssues(recipe, visible) {
  const issues = [];
  for (const item of visible) {
    const name = item.name.trim();
    const unit = item.unit.trim().toLowerCase();
    if (/^\d/.test(name)) issues.push(`embedded_quantity_name:${name}`);
    if (/^(de|da|do|das|dos)\s+/i.test(name)) issues.push(`leading_connector:${name}`);
    if (/(bechamel sauce|heavy cream|ground beef|natural yogurt|plain yogurt|tomato sauce)/i.test(name) && recipe.lang !== "en") issues.push(`english_leak:${name}`);
    if ((unit === "serving" || unit === "un" || unit === "unit" || unit === "units") && !/(ovo|egg|oeuf|ei|huevo|tortilla|wrap|slice|fatia)/i.test(name)) issues.push(`generic_unit:${name}:${unit}`);
    if (/^(tbsp|tsp|tablespoon|teaspoon|colher de sopa|colheres de sopa|colher de chá|colheres de chá|cucharada|cucharadita|cuillère à soupe|cuillère à café|esslöffel|teelöffel)$/i.test(unit)) issues.push(`spoon_unit:${name}:${unit}`);
    if (LOW_IMPACT_REVIEW_INGREDIENT_PATTERNS.some((p)=>p.test(name.toLowerCase()))) issues.push(`low_impact_visible:${name}`);
  }
  return issues;
}

const recipes = buildRecipes();
let issueCount = 0;
const samples = [];
for (const recipe of recipes) {
  const built = buildRecipeMealLoggingRepresentation(recipe, 8);
  const visible = getCollapsedReviewIngredients(built);
  const issues = detectIssues(recipe, visible);
  if (issues.length) {
    issueCount += issues.length;
    if (samples.length < 40) {
      samples.push({ lang: recipe.lang, title: recipe.title, visible, issues });
    }
  }
}

console.log(JSON.stringify({
  recipeCount: recipes.length,
  recipesWithIssues: samples.length,
  totalIssueSignals: issueCount,
  samples,
}, null, 2));
