import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "../context/ThemeContext";
import { formatImportedRecipeNote } from "../lib/recipes/importNotes";
import { RecipeNutritionInfo, normalizeRecipeNutritionInfo } from "../lib/recipes/nutrition";

type DraftRecipe = {
  title: string;
  cookingTime?: number;
  difficulty?: "Easy" | "Moderate" | "Challenging";
  servings?: number;
  cost?: "Cheap" | "Medium" | "Expensive";
  ingredients: string[];
  steps: string[];
  tags?: string[];
  image?: string;
  imageUrl?: string;
  notes?: string;
  sourceUrl?: string;
  sourceMetadata?: {
    sourceUrl?: string | null;
    source?: string | null;
    importedServings?: number | null;
    importedNutritionInfo?: RecipeNutritionInfo | null;
    importedAt?: string | null;
  } | null;
  nutritionInfo?: RecipeNutritionInfo | null;
  warnings?: string[];
};

function parseParamValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return typeof value === "string" ? value : "";
}

function toNumber(value: string, fallback?: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value !== "string") return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    // Fall through to newline parsing.
  }

  return trimmed
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function notesWithSourceUrl(notes: unknown, sourceUrl: unknown): string | undefined {
  const cleanNotes = typeof notes === "string" ? notes.trim() : "";
  const cleanUrl = typeof sourceUrl === "string" ? sourceUrl.trim() : "";
  if (!cleanUrl) return cleanNotes || undefined;
  if (!cleanNotes) return cleanUrl;
  return cleanNotes.includes(cleanUrl) ? cleanNotes : `${cleanNotes}\n${cleanUrl}`;
}

function normalizeRecipeDraft(params: Record<string, string | string[] | undefined>): DraftRecipe {
  const payload = parseParamValue(params.payload);

  if (payload) {
    const decoded = JSON.parse(decodeURIComponent(payload));
    if (!decoded || typeof decoded !== "object") {
      throw new Error("Invalid recipe payload.");
    }

    const draft = decoded as DraftRecipe;
    const ingredients = normalizeLines(draft.ingredients);
    const steps = normalizeLines(draft.steps);

    if (!draft.title || !ingredients.length || !steps.length) {
      throw new Error("The recipe draft is incomplete.");
    }

    return {
      title: String(draft.title).trim(),
      cookingTime:
        typeof draft.cookingTime === "number" && Number.isFinite(draft.cookingTime)
          ? draft.cookingTime
          : undefined,
      difficulty:
        draft.difficulty === "Easy" ||
        draft.difficulty === "Moderate" ||
        draft.difficulty === "Challenging"
          ? draft.difficulty
          : undefined,
      servings:
        typeof draft.servings === "number" && Number.isFinite(draft.servings)
          ? draft.servings
          : undefined,
      cost:
        draft.cost === "Cheap" ||
        draft.cost === "Medium" ||
        draft.cost === "Expensive"
          ? draft.cost
          : undefined,
      ingredients,
      steps,
      tags: normalizeLines(draft.tags),
      image: typeof draft.image === "string" ? draft.image : undefined,
      imageUrl: typeof draft.imageUrl === "string" ? draft.imageUrl : undefined,
      notes: notesWithSourceUrl(draft.notes, (draft as any).sourceUrl),
      sourceUrl: typeof (draft as any).sourceUrl === "string" ? (draft as any).sourceUrl : undefined,
      sourceMetadata:
        (draft as any).sourceMetadata && typeof (draft as any).sourceMetadata === "object"
          ? {
              ...(draft as any).sourceMetadata,
              importedNutritionInfo: normalizeRecipeNutritionInfo(
                (draft as any).sourceMetadata.importedNutritionInfo
              ),
            }
          : undefined,
      nutritionInfo: normalizeRecipeNutritionInfo((draft as any).nutritionInfo ?? (draft as any).nutrition),
      warnings: normalizeLines(draft.warnings),
    };
  }

  const title = parseParamValue(params.title).trim();
  const ingredients = normalizeLines(parseParamValue(params.ingredients));
  const steps = normalizeLines(parseParamValue(params.steps));

  if (!title || !ingredients.length || !steps.length) {
    throw new Error("Missing recipe title, ingredients, or steps.");
  }

  const difficultyRaw = parseParamValue(params.difficulty);
  const costRaw = parseParamValue(params.cost);

  return {
    title,
    cookingTime: toNumber(parseParamValue(params.cookingTime)),
    difficulty:
      difficultyRaw === "Easy" ||
      difficultyRaw === "Moderate" ||
      difficultyRaw === "Challenging"
        ? difficultyRaw
        : undefined,
    servings: toNumber(parseParamValue(params.servings)),
    cost:
      costRaw === "Cheap" || costRaw === "Medium" || costRaw === "Expensive"
        ? costRaw
        : undefined,
    ingredients,
    steps,
    tags: normalizeLines(parseParamValue(params.tags)),
    image: parseParamValue(params.image) || undefined,
    imageUrl: parseParamValue(params.imageUrl) || undefined,
    notes: notesWithSourceUrl(parseParamValue(params.notes), parseParamValue(params.sourceUrl)),
    sourceUrl: parseParamValue(params.sourceUrl) || undefined,
    warnings: normalizeLines(parseParamValue(params.warnings)),
  };
}

export default function ImportRecipeLinkScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const { bg, text, subText, card, cta, secondary, isDark, headerBg, headerText } = useThemeColors();
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const hasHandledRef = useRef(false);

  useEffect(() => {
    if (hasHandledRef.current) return;
    hasHandledRef.current = true;

    const handleImport = async () => {
      try {
        const draft = normalizeRecipeDraft(params);
        const recipeDraft = {
          ...draft,
          notes: formatImportedRecipeNote(
            draft.notes,
            draft.sourceUrl,
            draft.sourceUrl && /instagram\.com\/reel\//i.test(draft.sourceUrl)
              ? "instagram_reel"
              : "url",
            t
          ),
          sourceMetadata: draft.sourceMetadata ?? {
            sourceUrl: draft.sourceUrl ?? null,
            source: draft.sourceUrl && /instagram\.com\/reel\//i.test(draft.sourceUrl)
              ? "instagram_reel"
              : "url",
            importedServings:
              typeof draft.servings === "number" && Number.isFinite(draft.servings)
                ? draft.servings
                : null,
            importedNutritionInfo: draft.nutritionInfo ?? null,
            importedAt: new Date().toISOString(),
          },
        };
        const draftKey = `pending_import_recipe_draft_${Date.now()}`;
        await AsyncStorage.setItem(draftKey, JSON.stringify(recipeDraft));
        router.replace({ pathname: "/add-recipe", params: { draftKey } } as any);
      } catch (err: any) {
        setError(
          t("recipes.import_link_unavailable_body", {
            defaultValue: "We could not open this recipe in Cook N'Eat AI. Please try again.",
          })
        );
      }
    };

    handleImport();
  }, [params, router, t]);

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          title: t("recipes.import_recipe_title", { defaultValue: "Import Recipe" }),
          headerStyle: { backgroundColor: headerBg },
          headerTintColor: headerText,
          headerTitleAlign: "center",
        }}
      />

      <View style={[styles.card, { backgroundColor: card }]}>
        {error ? (
          <>
            <Text style={[styles.title, { color: text }]}>
              {t("recipes.import_unavailable_title", { defaultValue: "Import unavailable" })}
            </Text>
            <Text style={[styles.body, { color: subText }]}>{error}</Text>
          </>
        ) : (
          <>
            <ActivityIndicator size="large" color={isDark ? secondary : cta} />
            <Text style={[styles.title, { color: text }]}>
              {t("recipes.import_opening_draft_title", { defaultValue: "Opening recipe draft" })}
            </Text>
            <Text style={[styles.body, { color: subText }]}>
              {t("recipes.import_opening_draft_body", {
                defaultValue:
                  "We are sending this recipe to Cook N'Eat AI so you can review and save it.",
              })}
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 18,
    padding: 24,
    alignItems: "center",
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    marginTop: 16,
    textAlign: "center",
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
    textAlign: "center",
  },
});
