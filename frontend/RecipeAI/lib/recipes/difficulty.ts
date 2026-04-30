export type RecipeDifficultyUi = "Easy" | "Moderate" | "Challenging";

export function normalizeRecipeDifficulty(input: unknown): RecipeDifficultyUi {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";

  if (value === "easy") return "Easy";
  if (value === "moderate" || value === "medium") return "Moderate";
  if (value === "challenging" || value === "hard") return "Challenging";

  return "Easy";
}
