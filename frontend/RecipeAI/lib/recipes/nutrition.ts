export type RecipeNutritionSource =
  | "imported"
  | "ai_generated"
  | "manual"
  | "estimated";

export type RecipeNutritionPerServing = {
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
};

export type RecipeNutritionInfo = {
  perServing: RecipeNutritionPerServing;
  source: RecipeNutritionSource;
  updatedAt: string;
};

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizeRecipeNutritionInfo(input: unknown): RecipeNutritionInfo | null {
  if (!input || typeof input !== "object") return null;

  const candidate = input as Record<string, unknown>;

  if ("perServing" in candidate && candidate.perServing && typeof candidate.perServing === "object") {
    const perServing = candidate.perServing as Record<string, unknown>;
    return {
      perServing: {
        calories: toNullableNumber(perServing.calories),
        protein: toNullableNumber(perServing.protein),
        carbs: toNullableNumber(perServing.carbs),
        fat: toNullableNumber(perServing.fat),
      },
      source:
        candidate.source === "imported" ||
        candidate.source === "ai_generated" ||
        candidate.source === "manual" ||
        candidate.source === "estimated"
          ? candidate.source
          : "estimated",
      updatedAt:
        typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
          ? candidate.updatedAt
          : new Date().toISOString(),
    };
  }

  // Backward compatibility with the previous My Day-only shape stored on recipes.
  if (
    "caloriesPerServing" in candidate ||
    "proteinPerServing" in candidate ||
    "carbsPerServing" in candidate ||
    "fatPerServing" in candidate
  ) {
    return {
      perServing: {
        calories: toNullableNumber(candidate.caloriesPerServing),
        protein: toNullableNumber(candidate.proteinPerServing),
        carbs: toNullableNumber(candidate.carbsPerServing),
        fat: toNullableNumber(candidate.fatPerServing),
      },
      source:
        candidate.source === "imported" ||
        candidate.source === "ai_generated" ||
        candidate.source === "manual" ||
        candidate.source === "estimated" ||
        candidate.source === "myday_estimated"
          ? candidate.source === "myday_estimated"
            ? "estimated"
            : candidate.source
          : "estimated",
      updatedAt:
        typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
          ? candidate.updatedAt
          : new Date().toISOString(),
    };
  }

  return null;
}

export function getRecipeCaloriesPerServing(
  recipe: { nutritionInfo?: unknown; nutrition?: unknown } | null | undefined
): number | null {
  if (!recipe) return null;
  const normalized = normalizeRecipeNutritionInfo(
    (recipe as { nutritionInfo?: unknown; nutrition?: unknown }).nutritionInfo ??
      (recipe as { nutritionInfo?: unknown; nutrition?: unknown }).nutrition
  );
  return normalized?.perServing.calories ?? null;
}
