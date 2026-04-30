export const SUPPORTED_INGREDIENT_LOCALES = [
  "en",
  "pt-PT",
  "pt-BR",
  "es",
  "fr",
  "de",
];

const UNIT_LIMITS = {
  g: { min: 5, max: 1000 },
  kg: { min: 0.05, max: 5 },
  ml: { min: 5, max: 1500 },
  l: { min: 0.05, max: 3 },
  unit: { min: 0.25, max: 12 },
  slice: { min: 0.25, max: 8 },
  cup: { min: 0.125, max: 4 },
  tbsp: { min: 0.25, max: 12 },
  tsp: { min: 0.25, max: 24 },
};

export function normalizeAlias(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAliases(aliasesByLocale = {}) {
  const normalized = {};

  for (const locale of SUPPORTED_INGREDIENT_LOCALES) {
    const rawAliases = Array.isArray(aliasesByLocale[locale]) ? aliasesByLocale[locale] : [];
    const deduped = Array.from(
      new Set(
        rawAliases
          .map(normalizeAlias)
          .filter((alias) => alias.length >= 2)
      )
    );
    normalized[locale] = deduped;
  }

  return normalized;
}

export function validateNutritionPer100(nutrition = {}) {
  const calories = Number(nutrition.calories);
  const protein = Number(nutrition.protein);
  const carbs = Number(nutrition.carbs);
  const fat = Number(nutrition.fat);
  const unit = nutrition.unit === "ml" ? "ml" : "g";

  if (![calories, protein, carbs, fat].every(Number.isFinite)) {
    return { ok: false, reason: "missing_macros" };
  }

  if (calories < 0 || calories > 900) {
    return { ok: false, reason: "calories_out_of_range" };
  }

  if (protein < 0 || protein > 100 || carbs < 0 || carbs > 100 || fat < 0 || fat > 100) {
    return { ok: false, reason: "macro_out_of_range" };
  }

  const macroCalories = protein * 4 + carbs * 4 + fat * 9;
  if (Math.abs(macroCalories - calories) > 120) {
    return { ok: false, reason: "macro_calorie_mismatch" };
  }

  return {
    ok: true,
    value: { calories, protein, carbs, fat, unit },
  };
}

export function validateDefaultServing(serving = {}) {
  const quantity = Number(serving.quantity);
  const unit = String(serving.unit || "").trim().toLowerCase();
  const limits = UNIT_LIMITS[unit];

  if (!limits || !Number.isFinite(quantity)) {
    return { ok: false, reason: "invalid_serving" };
  }

  if (quantity < limits.min || quantity > limits.max) {
    return { ok: false, reason: "serving_out_of_range" };
  }

  return {
    ok: true,
    value: { quantity, unit },
  };
}

export function scoreCandidateForAutoPromotion(candidate = {}) {
  const reasons = [];
  let score = 0;

  const canonicalName = normalizeAlias(candidate.canonicalName);
  if (canonicalName.length >= 2) score += 20;
  else reasons.push("invalid_canonical_name");

  const aliases = normalizeAliases(candidate.aliases || {});
  const localesWithAliases = SUPPORTED_INGREDIENT_LOCALES.filter(
    (locale) => aliases[locale] && aliases[locale].length > 0
  );
  if (localesWithAliases.length === SUPPORTED_INGREDIENT_LOCALES.length) score += 25;
  else reasons.push("missing_locale_aliases");

  const nutritionResult = validateNutritionPer100(candidate.nutritionPer100);
  if (nutritionResult.ok) score += 25;
  else reasons.push(nutritionResult.reason);

  const servingResult = validateDefaultServing(candidate.defaultServing);
  if (servingResult.ok) score += 20;
  else reasons.push(servingResult.reason);

  const confidence = Number(candidate.confidence);
  if (Number.isFinite(confidence) && confidence >= 0.9) score += 10;
  else if (Number.isFinite(confidence) && confidence >= 0.82) score += 5;
  else reasons.push("low_confidence");

  return {
    score,
    reasons,
    normalized: {
      canonicalName,
      aliases,
      nutritionPer100: nutritionResult.ok ? nutritionResult.value : null,
      defaultServing: servingResult.ok ? servingResult.value : null,
    },
  };
}

export function shouldAutoPromoteCandidate(candidate = {}) {
  const result = scoreCandidateForAutoPromotion(candidate);
  const shouldPromote = result.score >= 85 && result.reasons.length <= 1;

  return {
    ...result,
    shouldPromote,
  };
}
