type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function formatImportedRecipeNote(
  existingNotes: unknown,
  sourceUrl: unknown,
  sourceType: "url" | "instagram_reel",
  t: TranslateFn
): string {
  const cleanNotes = typeof existingNotes === "string" ? existingNotes.trim() : "";
  const cleanUrl = typeof sourceUrl === "string" ? sourceUrl.trim() : "";
  if (!cleanUrl) return cleanNotes;

  return t(
    sourceType === "instagram_reel"
      ? "recipes.imported_instagram_note"
      : "recipes.imported_url_note",
    {
      url: cleanUrl,
      defaultValue:
        sourceType === "instagram_reel"
          ? "Recipe imported through Instagram Reel: {{url}}"
          : "Recipe imported through URL: {{url}}",
    }
  );
}
