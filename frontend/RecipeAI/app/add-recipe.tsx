import React, { useState, useEffect, useRef } from "react";
// --- Input sanitizer ---
function sanitizeInput(text: string, multiline = false): string {
  // Remove leading/trailing whitespace, normalize line endings, remove control chars except \n for multiline
  let sanitized = text.replace(/\r\n/g, "\n");
  if (!multiline) {
    sanitized = sanitized.replace(/[\r\n]/g, " ");
  }
  sanitized = sanitized.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, "");
  // Do not trim here; trimming on every keystroke breaks typing spaces in single-line inputs.
  // We will trim where necessary (e.g., on submit/validation) instead.
  return sanitized;
}
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Alert,
  TouchableOpacity,
  Image,
  Switch,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
  Modal,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter, Stack, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../context/ThemeContext";
import { auth } from "../firebaseConfig";
import { signInAnonymously } from "firebase/auth";
import AppButton from "../components/AppButton";
import AppCard from "../components/AppCard";
import InsufficientCookiesModal from "../components/InsufficientCookiesModal";
import EggIcon from "../components/EggIcon";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { getDeviceId } from "../utils/deviceId";
import { useSyncEngine } from "../lib/sync/SyncEngine";
import { getApiBaseUrl } from "../lib/config/api";
import {
  claimEconomyReward,
  fetchEconomyCatalogBundle,
  fetchEconomySnapshot,
  shouldHidePremiumPricing,
  writeCachedEconomySnapshot,
  type EconomyCatalogOffer,
} from "../lib/economy/client";
import {
  claimRewardKeysSequentially,
  getRecipeRewardKeysForCount,
} from "../lib/economy/rewards";
import {
  RecipeNutritionInfo,
  normalizeRecipeNutritionInfo,
} from "../lib/recipes/nutrition";
import { normalizeRecipeDifficulty } from "../lib/recipes/difficulty";
import {
  estimateRecipeNutrition,
  resolveRecipeNutritionEstimate,
  SavedRecipe,
} from "../lib/myDayRecipes";

const defaultImage = require("../assets/default_recipe.png");

interface Recipe {
  id: string;
  title: string;
  cookingTime: number;
  difficulty: "Easy" | "Moderate" | "Challenging";
  servings: number;
  cost: "Cheap" | "Medium" | "Expensive";
  ingredients: string[];
  steps: string[];
  tags: string[];
  cookbooks: { id: string; name: string }[];
  createdAt: string;
  image?: string;      // 🔹 main image field
  imageUrl?: string;   // 🔹 mirror field for compatibility with readers expecting imageUrl
  nutritionInfo?: RecipeNutritionInfo | null;
  nutritionEstimateMeta?: {
    ingredientsSignature: string;
    perServing: {
      calories: string;
      protein: string;
      carbs: string;
      fat: string;
    };
  } | null;
  mealLoggingRepresentation?: SavedRecipe["mealLoggingRepresentation"];
  servingInfo?: SavedRecipe["servingInfo"];
}

interface Cookbook {
  id: string;
  name: string;
}

const BULLET_PREFIX = "• ";
type ListKind = "bullet" | "numbered";

function stripListPrefix(line: string): string {
  return line.replace(/^\s*(?:[•*-]|\d+[.)])\s*/, "").trim();
}

function stripListPrefixForEditing(line: string): string {
  return line.replace(/^\s*(?:[•*-]|\d+[.)])\s*/, "");
}

function parseListMultiline(value: string): string[] {
  return value
    .split("\n")
    .map((line) => stripListPrefix(line))
    .filter(Boolean);
}

function formatListLine(content: string, index: number, kind: ListKind): string {
  return kind === "numbered" ? `${index + 1}. ${content}` : `${BULLET_PREFIX}${content}`;
}

function emptyListMarker(index: number, kind: ListKind): string {
  return kind === "numbered" ? `${index + 1}. ` : BULLET_PREFIX;
}

function toFormattedListMultiline(
  lines: string[] | null | undefined,
  kind: ListKind
): string {
  const normalized = Array.isArray(lines)
    ? lines.map((line) => stripListPrefix(String(line ?? ""))).filter(Boolean)
    : [];
  if (normalized.length === 0) {
    return emptyListMarker(0, kind);
  }
  return normalized.map((line, index) => formatListLine(line, index, kind)).join("\n");
}

function normalizeListInput(text: string, kind: ListKind): string {
  const sanitized = sanitizeInput(text, true).replace(/\r\n/g, "\n");
  const rawLines = sanitized.split("\n");
  const hasTrailingNewline = sanitized.endsWith("\n");
  const contentLines = rawLines
    .map((line) => stripListPrefixForEditing(line))
    .filter((line) => line.trim().length > 0);

  if (contentLines.length === 0) {
    return emptyListMarker(0, kind);
  }

  const normalizedLines = contentLines.map((line, index) =>
    formatListLine(line, index, kind)
  );

  if (hasTrailingNewline) {
    normalizedLines.push(emptyListMarker(contentLines.length, kind));
  }

  return normalizedLines.join("\n");
}

function sanitizeNutritionDecimalInput(text: string): string {
  const normalized = sanitizeInput(text).replace(",", ".");
  const cleaned = normalized.replace(/[^0-9.]/g, "");
  if (!cleaned) return "";

  const firstDotIndex = cleaned.indexOf(".");
  if (firstDotIndex === -1) {
    return cleaned;
  }

  const integerPart = cleaned.slice(0, firstDotIndex);
  const decimalRaw = cleaned.slice(firstDotIndex + 1).replace(/\./g, "");
  const decimalPart = decimalRaw.slice(0, 2);

  if (normalized.endsWith(".") && decimalPart.length === 0) {
    return `${integerPart}.`;
  }

  return `${integerPart}.${decimalPart}`;
}

function parseNullableNutritionValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function haveNutritionValuesChanged(
  previous: RecipeNutritionInfo | null | undefined,
  nextPerServing: RecipeNutritionInfo["perServing"]
): boolean {
  if (!previous) return true;
  return (
    previous.perServing.calories !== nextPerServing.calories ||
    previous.perServing.protein !== nextPerServing.protein ||
    previous.perServing.carbs !== nextPerServing.carbs ||
    previous.perServing.fat !== nextPerServing.fat
  );
}

function buildNutritionInfoForSave(
  previous: RecipeNutritionInfo | null | undefined,
  values: {
    calories: string;
    protein: string;
    carbs: string;
    fat: string;
  }
): RecipeNutritionInfo | null {
  const perServing = {
    calories: parseNullableNutritionValue(values.calories),
    protein: parseNullableNutritionValue(values.protein),
    carbs: parseNullableNutritionValue(values.carbs),
    fat: parseNullableNutritionValue(values.fat),
  };

  const hasAnyValue = Object.values(perServing).some((value) => value !== null);
  if (!hasAnyValue) return null;

  if (!haveNutritionValuesChanged(previous, perServing) && previous) {
    return previous;
  }

  return {
    perServing,
    source: "manual",
    updatedAt: new Date().toISOString(),
  };
}

function normalizeComparableNutritionValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return trimmed;
  return parsed.toString();
}

function buildIngredientsSignature(value: string): string {
  return parseListMultiline(value).join("|");
}

function buildNutritionSnapshot(values: {
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
}) {
  return {
    calories: normalizeComparableNutritionValue(values.calories),
    protein: normalizeComparableNutritionValue(values.protein),
    carbs: normalizeComparableNutritionValue(values.carbs),
    fat: normalizeComparableNutritionValue(values.fat),
  };
}

export default function AddRecipe() {
  const { t, i18n } = useTranslation();
  const params = useLocalSearchParams<{
    edit?: string;
    editId?: string;
    cookbookId?: string;
    draftKey?: string;
  }>();
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);

  const [title, setTitle] = useState("");
  const [cookingTime, setCookingTime] = useState("");
  const [difficulty, setDifficulty] = useState<"Easy" | "Moderate" | "Challenging">("Easy");
  const [servings, setServings] = useState("");
  const [cost, setCost] = useState<"Cheap" | "Medium" | "Expensive">("Cheap");
  const [ingredients, setIngredients] = useState(BULLET_PREFIX);
  const [steps, setSteps] = useState("1. ");
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [allTags, setAllTags] = useState<string[]>([]);
  const [image, setImage] = useState<string | undefined>(undefined); // 🔹 imagem escolhida
  const [nutritionCalories, setNutritionCalories] = useState("");
  const [nutritionProtein, setNutritionProtein] = useState("");
  const [nutritionCarbs, setNutritionCarbs] = useState("");
  const [nutritionFat, setNutritionFat] = useState("");
  const [isEstimatingNutrition, setIsEstimatingNutrition] = useState(false);
  const [nutritionEstimateLocked, setNutritionEstimateLocked] = useState(false);
  const [nutritionEstimateMeta, setNutritionEstimateMeta] = useState<{
    ingredientsSignature: string;
    calories: string;
    protein: string;
    carbs: string;
    fat: string;
    servingInfo?: SavedRecipe["servingInfo"] | null;
  } | null>(null);
  const [estimatedMealLoggingRepresentation, setEstimatedMealLoggingRepresentation] =
    useState<SavedRecipe["mealLoggingRepresentation"] | null>(null);

  const [cookbooks, setCookbooks] = useState<Cookbook[]>([]);
  const [selectedCookbooks, setSelectedCookbooks] = useState<string[]>([]);
  const [newCookbookName, setNewCookbookName] = useState("");

  const [saving, setSaving] = useState(false);

  const router = useRouter();
  const { bg, text, border, card, isDark } = useThemeColors();
  const syncEngine = useSyncEngine();
  const hasAtLeastOneIngredientLine =
    parseListMultiline(ingredients).length > 0;
  const currentIngredientsSignature = buildIngredientsSignature(ingredients);
  const backendUrl = getApiBaseUrl();
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  console.log("Using backend URL:", backendUrl, "env:", appEnv);

  useEffect(() => {
    if (!nutritionEstimateMeta) return;

    const currentSnapshot = buildNutritionSnapshot({
      calories: nutritionCalories,
      protein: nutritionProtein,
      carbs: nutritionCarbs,
      fat: nutritionFat,
    });
    const estimatedSnapshot = buildNutritionSnapshot(nutritionEstimateMeta);

    const matchesEstimate =
      currentSnapshot.calories === estimatedSnapshot.calories &&
      currentSnapshot.protein === estimatedSnapshot.protein &&
      currentSnapshot.carbs === estimatedSnapshot.carbs &&
      currentSnapshot.fat === estimatedSnapshot.fat;

    const matchesIngredients =
      currentIngredientsSignature === nutritionEstimateMeta.ingredientsSignature;

    setNutritionEstimateLocked(matchesEstimate && matchesIngredients);
  }, [
    nutritionEstimateMeta,
    currentIngredientsSignature,
    nutritionCalories,
    nutritionProtein,
    nutritionCarbs,
    nutritionFat,
  ]);

  // --- Insufficient cookies modal (cookbooks) ---
  const [insufficientModal, setInsufficientModal] = useState<{
    visible: boolean;
    remaining: number;
    context: "cookbook" | "nutrition_estimate";
  }>({ visible: false, remaining: 0, context: "cookbook" });
  const [freePremiumActionsRemaining, setFreePremiumActionsRemaining] = useState<number | null>(null);
  const [availableRewardsCount, setAvailableRewardsCount] = useState(0);

  const [featuredOffer, setFeaturedOffer] = useState<EconomyCatalogOffer | null>(null);

  const goToStore = (highlightOfferId?: string, autoBuy = false) => {
    try {
      router.push({
        pathname: "/economy/store",
        params: highlightOfferId
          ? autoBuy
            ? { highlight: highlightOfferId, autoBuy: "1" }
            : { highlight: highlightOfferId }
          : undefined,
      } as any);
    } catch {
      router.push("/economy/store" as any);
    }
  };

  const openInsufficientCookiesModal = async (
    remaining: number | null | undefined,
    context: "cookbook" | "nutrition_estimate" = "cookbook"
  ) => {
    const rem = typeof remaining === "number" ? remaining : 0;

    // Fetch the featured recovery offer so the modal can guide the user smoothly.
    if ((!featuredOffer || availableRewardsCount === 0) && backendUrl) {
      try {
        const catalog = await fetchEconomyCatalogBundle({ backendUrl, appEnv, auth });
        const featured = catalog.offers.find((offer) => String(offer.id).trim() === "cookies_15");
        if (featured) setFeaturedOffer(featured);
        setAvailableRewardsCount(
          Array.isArray(catalog.bonuses)
            ? catalog.bonuses.filter((bonus) => bonus?.status === "available").length
            : 0
        );
      } catch {
        // ignore
      }
    }

    setInsufficientModal({ visible: true, remaining: rem, context });
  };

  // --- Economy: fetch cookie balance and pre-check before cookbook creation ---
  const fetchCookieBalanceSafe = async (): Promise<number | null> => {
    try {
      const snapshot = await fetchEconomySnapshot({ backendUrl, appEnv, auth });
      if (!snapshot) return null;
      setFreePremiumActionsRemaining(snapshot.freePremiumActionsRemaining);
      await writeCachedEconomySnapshot(auth.currentUser?.uid, snapshot);
      if (shouldHidePremiumPricing(snapshot.freePremiumActionsRemaining)) return null;
      return snapshot.balance;
    } catch {
      return null;
    }
  };

  const ensureHasCookiesOrPrompt = async (required: number): Promise<boolean> => {
    const bal = await fetchCookieBalanceSafe();
    // If we can't pre-check, don't block.
    if (typeof bal !== "number") return true;
    if (bal >= required) return true;
    await openInsufficientCookiesModal(bal);
    return false;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snapshot = await fetchEconomySnapshot({ backendUrl, appEnv, auth });
        if (!snapshot || cancelled) return;
        setFreePremiumActionsRemaining(snapshot.freePremiumActionsRemaining);
        await writeCachedEconomySnapshot(auth.currentUser?.uid, snapshot);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backendUrl, appEnv]);

  // Helper to normalize and apply a recipe object to state for editing
  function normalizeAndApplyRecipe(raw: Recipe) {
    const allowedCosts = ["Cheap", "Medium", "Expensive"];
    const normalizedDifficulty: "Easy" | "Moderate" | "Challenging" =
      normalizeRecipeDifficulty(raw.difficulty);
    const normalizedCost: "Cheap" | "Medium" | "Expensive" =
      allowedCosts.includes(raw.cost) ? (raw.cost as any) : "Cheap";

    const recipe: Recipe = {
      ...raw,
      difficulty: normalizedDifficulty,
      cost: normalizedCost,
      nutritionInfo: normalizeRecipeNutritionInfo(
        (raw as any).nutritionInfo ?? (raw as any).nutrition
      ),
    };

    setEditingRecipe(recipe);
    setTitle(recipe.title || "");
    setCookingTime(String(recipe.cookingTime || ""));
    setDifficulty(normalizedDifficulty);
    setServings(String(recipe.servings || ""));
    setCost(normalizedCost);
    setIngredients(toFormattedListMultiline(recipe.ingredients || [], "bullet"));
    setSteps(toFormattedListMultiline(recipe.steps || [], "numbered"));
    setTags(recipe.tags || []);
    setImage(recipe.image || (recipe as any).imageUrl);
    setNutritionCalories(
      recipe.nutritionInfo?.perServing.calories !== null &&
        recipe.nutritionInfo?.perServing.calories !== undefined
        ? String(recipe.nutritionInfo.perServing.calories)
        : ""
    );
    setNutritionProtein(
      recipe.nutritionInfo?.perServing.protein !== null &&
        recipe.nutritionInfo?.perServing.protein !== undefined
        ? String(recipe.nutritionInfo.perServing.protein)
        : ""
    );
    setNutritionCarbs(
      recipe.nutritionInfo?.perServing.carbs !== null &&
        recipe.nutritionInfo?.perServing.carbs !== undefined
        ? String(recipe.nutritionInfo.perServing.carbs)
        : ""
    );
    setNutritionFat(
      recipe.nutritionInfo?.perServing.fat !== null &&
        recipe.nutritionInfo?.perServing.fat !== undefined
        ? String(recipe.nutritionInfo.perServing.fat)
        : ""
    );
    const estimateMeta = (recipe as any).nutritionEstimateMeta;
    if (
      estimateMeta &&
      typeof estimateMeta === "object" &&
      typeof estimateMeta.ingredientsSignature === "string" &&
      estimateMeta.perServing &&
      typeof estimateMeta.perServing === "object"
    ) {
      setNutritionEstimateMeta({
        ingredientsSignature: estimateMeta.ingredientsSignature,
        calories: typeof estimateMeta.perServing.calories === "string" ? estimateMeta.perServing.calories : "",
        protein: typeof estimateMeta.perServing.protein === "string" ? estimateMeta.perServing.protein : "",
        carbs: typeof estimateMeta.perServing.carbs === "string" ? estimateMeta.perServing.carbs : "",
        fat: typeof estimateMeta.perServing.fat === "string" ? estimateMeta.perServing.fat : "",
      });
    } else {
      setNutritionEstimateMeta(null);
    }
    setEstimatedMealLoggingRepresentation(recipe.mealLoggingRepresentation ?? null);

    // Normalize cookbooks to array of { id, name }
    let cookbookObjs: { id: string; name: string }[] = [];
    if (Array.isArray(recipe.cookbooks)) {
      cookbookObjs = recipe.cookbooks.map((cb: any) => {
        if (typeof cb === "string") {
          return { id: cb, name: "" };
        } else if (cb && typeof cb === "object" && cb.id && cb.name) {
          return { id: cb.id, name: cb.name };
        } else {
          return { id: "", name: "" };
        }
      });
    }
    setSelectedCookbooks(cookbookObjs.map(cb => cb.id));
  }

  function applyDraftRecipe(raw: Partial<Recipe> & { notes?: string }) {
    const allowedCosts = ["Cheap", "Medium", "Expensive"];

    setEditingRecipe(null);
    setTitle(typeof raw.title === "string" ? raw.title : "");
    setCookingTime(
      typeof raw.cookingTime === "number" && Number.isFinite(raw.cookingTime)
        ? String(raw.cookingTime)
        : ""
    );
    setDifficulty(
      normalizeRecipeDifficulty(raw.difficulty ?? "Moderate")
    );
    setServings(
      typeof raw.servings === "number" && Number.isFinite(raw.servings)
        ? String(raw.servings)
        : ""
    );
    setCost(
      allowedCosts.includes(String(raw.cost)) ? (raw.cost as any) : "Medium"
    );
    setIngredients(
      toFormattedListMultiline(Array.isArray(raw.ingredients) ? raw.ingredients : [], "bullet")
    );
    setSteps(
      toFormattedListMultiline(Array.isArray(raw.steps) ? raw.steps : [], "numbered")
    );
    setTags(Array.isArray(raw.tags) ? raw.tags.filter(Boolean) : []);
    setImage(raw.image || (raw as any).imageUrl);
    const nutritionInfo = normalizeRecipeNutritionInfo(
      (raw as any).nutritionInfo ?? (raw as any).nutrition
    );
    setNutritionCalories(
      nutritionInfo?.perServing.calories !== null &&
        nutritionInfo?.perServing.calories !== undefined
        ? String(nutritionInfo.perServing.calories)
        : ""
    );
    setNutritionProtein(
      nutritionInfo?.perServing.protein !== null &&
        nutritionInfo?.perServing.protein !== undefined
        ? String(nutritionInfo.perServing.protein)
        : ""
    );
    setNutritionCarbs(
      nutritionInfo?.perServing.carbs !== null &&
        nutritionInfo?.perServing.carbs !== undefined
        ? String(nutritionInfo.perServing.carbs)
        : ""
    );
    setNutritionFat(
      nutritionInfo?.perServing.fat !== null &&
        nutritionInfo?.perServing.fat !== undefined
        ? String(nutritionInfo.perServing.fat)
        : ""
    );
    setNutritionEstimateMeta(null);
    setEstimatedMealLoggingRepresentation(raw.mealLoggingRepresentation ?? null);
  }

  useEffect(() => {
    const loadForEdit = async () => {
      try {
        if (params.editId) {
          const stored = await AsyncStorage.getItem("recipes");
          const arr: Recipe[] = stored ? JSON.parse(stored) : [];
          const found = arr.find(r => r.id === params.editId);
          if (found) {
            normalizeAndApplyRecipe(found);
            return;
          }
        }
        if (params.edit) {
          const parsed: Recipe = JSON.parse(String(params.edit));
          let recipeToUse = parsed;
          try {
            const stored = await AsyncStorage.getItem("recipes");
            if (stored) {
              const arr: Recipe[] = JSON.parse(stored);
              const match = arr.find(r => r.id === parsed.id);
              if (match) {
                recipeToUse = match;
              }
            }
          } catch (e) {
            console.warn("[AddRecipe] Failed to re-read recipe from storage for edit param", e);
          }
          normalizeAndApplyRecipe(recipeToUse);
        }
        if (params.draftKey) {
          const rawDraft = await AsyncStorage.getItem(String(params.draftKey));
          if (rawDraft) {
            const parsedDraft = JSON.parse(rawDraft);
            applyDraftRecipe(parsedDraft);
            await AsyncStorage.removeItem(String(params.draftKey));
          }
        }
      } catch (err) {
        console.error("❌ Failed to initialize edit recipe", err);
      }
    };
    loadForEdit();
  }, [params.editId, params.edit, params.draftKey]);

  // Load cookbooks from AsyncStorage
  useEffect(() => {
    const loadCookbooks = async () => {
      try {
        const storedCookbooks = await AsyncStorage.getItem("cookbooks");
        if (storedCookbooks) {
          setCookbooks(JSON.parse(storedCookbooks));
        }
      } catch (err) {
        console.error("Error loading cookbooks:", err);
      }
    };
    loadCookbooks();
  }, []);

  // If params.cookbookId is present and not already selected, select it after cookbooks are loaded
  useEffect(() => {
    if (
      params.cookbookId &&
      cookbooks.length > 0 &&
      !selectedCookbooks.includes(params.cookbookId)
    ) {
      // Only add if exists in cookbooks
      if (cookbooks.some(cb => cb.id === params.cookbookId)) {
        setSelectedCookbooks(prev => [...prev, params.cookbookId!]);
      }
    }
  }, [params.cookbookId, cookbooks, selectedCookbooks]);

  // Load all unique tags from existing recipes
  useEffect(() => {
    const loadAllTags = async () => {
      try {
        const storedRecipes = await AsyncStorage.getItem("recipes");
        if (storedRecipes) {
          const recipes: Recipe[] = JSON.parse(storedRecipes);
          const uniqueTagsSet = new Set<string>();
          recipes.forEach((r) => (r.tags || []).forEach((t) => uniqueTagsSet.add(t)));
          setAllTags(Array.from(uniqueTagsSet));
        }
      } catch (err) {
        console.error("Error loading tags:", err);
      }
    };
    loadAllTags();
  }, []);

  // 🔹 Escolher imagem
  const pickImage = async () => {
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permissionResult.granted) {
      Alert.alert(t("recipes.permission_gallery_title"), t("recipes.permission_gallery_body"));
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });

    if (!result.canceled && result.assets.length > 0) {
      const selectedUri = result.assets[0].uri;
      const compressedUri = await compressImageIfNeeded(selectedUri);
      setImage(compressedUri);
    }
  };

  // Toggle cookbook selection
  const toggleCookbook = (id: string) => {
    setSelectedCookbooks((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  // Add new cookbook
  const addCookbook = async () => {
    const name = newCookbookName.trim();
    if (!name) {
      Alert.alert(t("common.validation"), t("recipes.cookbook_name_empty"));
      return;
    }
    // Check if cookbook with same name exists
    if (cookbooks.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      Alert.alert(t("common.validation"), t("recipes.cookbook_name_duplicate"));
      return;
    }
    const newCookbook: Cookbook = { id: `${Date.now()}`, name };
    const updatedCookbooks = [...cookbooks, newCookbook];
    setCookbooks(updatedCookbooks);
    setSelectedCookbooks((prev) => [...prev, newCookbook.id]);
    setNewCookbookName("");
    try {
      if (syncEngine) {
        await syncEngine.saveLocalCookbooksSnapshot(updatedCookbooks);

        // Also mark this cookbook as dirty for Firestore sync
        try {
          await syncEngine.markCookbookDirty({
            id: newCookbook.id,
            name: newCookbook.name,
          });
        } catch (err) {
          console.warn("[AddRecipe] failed to mark cookbook dirty for sync", err);
        }

        syncEngine.requestSync("manual");
      } else {
        console.warn("[AddRecipe] syncEngine not available; cookbook changes not persisted to local snapshot");
      }
    } catch (err) {
      console.error("Error saving new cookbook:", err);
    }
  };

  // Toggle tag selection
  const toggleTag = (tag: string) => {
    setTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  // Add new tag(s) (comma-separated, trims, filters, avoids duplicates)
  const addTag = () => {
    // Split by comma, trim, filter out empty
    const rawTags = newTag.split(",").map(t => t.trim()).filter(Boolean);
    if (rawTags.length === 0) {
      setNewTag("");
      return;
    }
    // Only add tags not already present
    const newUniqueTags = rawTags.filter(t => !tags.includes(t));
    if (newUniqueTags.length > 0) {
      setTags(prev => [...prev, ...newUniqueTags]);
      // Add to allTags any missing tags
      const allUniqueTagsToAdd = newUniqueTags.filter(t => !allTags.includes(t));
      if (allUniqueTagsToAdd.length > 0) {
        setAllTags(prev => [...prev, ...allUniqueTagsToAdd]);
      }
    }
    setNewTag("");
  };


  const ensureAuthUid = async (): Promise<{ uid: string; token: string } | null> => {
    try {
      if (auth.currentUser) {
        const token = await auth.currentUser.getIdToken();
        return { uid: auth.currentUser.uid, token };
      }
      // Sign in anonymously to obtain a UID/token for uploads when user isn't logged in
      const cred = await signInAnonymously(auth);
      const token = await cred.user.getIdToken();
      return { uid: cred.user.uid, token };
    } catch (e) {
      console.warn("[AddRecipe] ensureAuthUid failed", e);
      return null;
    }
  };

  const requestNutritionEstimateEconomy = async (
    mode: "preview" | "commit"
  ): Promise<boolean> => {
    try {
      if (!backendUrl) {
        console.warn("[AddRecipe] No backend URL configured; skipping economy consume for nutrition estimate");
        return true;
      }

      const authInfo = await ensureAuthUid();
      if (!authInfo?.token) {
        console.warn("[AddRecipe] Missing auth token for nutrition estimate consume; blocking estimate");
        Alert.alert(
          t("common.error", "Error"),
          t("economy.auth_required", "Please sign in again and try one more time.")
        );
        return false;
      }

      let deviceId: string | null = null;
      try {
        deviceId = await getDeviceId();
      } catch {
        deviceId = null;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authInfo.token}`,
        "x-app-env": appEnv,
      };
      if (deviceId) headers["x-device-id"] = deviceId;
      if (authInfo.uid) headers["x-user-id"] = authInfo.uid;

      const res = await fetch(`${backendUrl}/recipes/estimate-nutrition/charge`, {
        method: "POST",
        headers,
        body: JSON.stringify({ uid: authInfo.uid, preview: mode === "preview" }),
      });

      if (res.status === 404) {
        const ok = await ensureHasCookiesOrPrompt(2);
        return ok;
      }

      if (res.status === 402) {
        let remaining: number | null = null;
        try {
          const data = await res.json().catch(() => null);
          if (typeof (data as any)?.remaining === "number") remaining = (data as any).remaining;
          else if (typeof (data as any)?.balance === "number") remaining = (data as any).balance;
        } catch {
          // ignore
        }

        await openInsufficientCookiesModal(remaining, "nutrition_estimate");
        return false;
      }

      if (res.status === 401 || res.status === 403) {
        let msg: string | null = null;
        try {
          const data = await res.json().catch(() => null);
          if (typeof (data as any)?.message === "string") msg = (data as any).message;
          if (!msg && typeof (data as any)?.error === "string") msg = (data as any).error;
        } catch {
          // ignore
        }

        Alert.alert(
          t("common.error", "Error"),
          msg || t("economy.auth_required", "Please sign in again and try one more time.")
        );
        return false;
      }

      if (res.ok) {
        try {
          const data = await res.json().catch(() => null);
          const remaining =
            typeof (data as any)?.remaining === "number"
              ? (data as any).remaining
              : typeof (data as any)?.balance === "number"
                ? (data as any).balance
                : null;

          if (typeof remaining === "number") {
            await AsyncStorage.setItem("economy_cookie_balance", String(remaining));
          }
        } catch {
          // ignore
        }
        return true;
      }

      let message: string | null = null;
      try {
        const data = await res.json().catch(() => null);
        if (typeof (data as any)?.message === "string") message = (data as any).message;
        if (!message && typeof (data as any)?.error === "string") message = (data as any).error;
      } catch {
        // ignore
      }

      Alert.alert(
        t("common.error", "Error"),
        message || "We couldn't estimate the nutrition values right now."
      );
      return false;
    } catch (err) {
      console.warn("[AddRecipe] nutrition estimate consume exception; blocking estimate", err);
      Alert.alert(
        t("common.error", "Error"),
        t("economy.try_again", "Couldn't verify your Egg balance. Please try again.")
      );
      return false;
    }
  };

  const uploadRecipePhoto = async (localUri: string, uid?: string, recipeId?: string): Promise<string | null> => {
    try {
      const compressedUri = await compressImageIfNeeded(localUri);
      const authInfo = await ensureAuthUid();
      if (!authInfo) return null;

      const useUid = uid || authInfo.uid;
      const useRecipeId = recipeId || `${Date.now()}`;

      if (!backendUrl) {
        console.warn("[AddRecipe] No backend URL configured for uploadRecipePhoto");
        return null;
      }

      const apiUrl = `${backendUrl}/uploadRecipeImage`;
      const filename = `image.jpg`;
      const storagePath = `users/${useUid}/recipes/${useRecipeId}/${filename}`;

      const form = new FormData();
      form.append("path", storagePath as any);
      form.append("contentType", "image/jpeg" as any);
      form.append("file", { uri: compressedUri, name: filename, type: "image/jpeg" } as any);

      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authInfo.token}`,
          "x-app-env": appEnv,
        },
        body: form,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[AddRecipe] Backend upload failed", data);
        return null;
      }

      let url: string | null = null;
      if (data && data.downloadURL) url = data.downloadURL as string;
      else if (data && data.url) url = data.url as string;

      if (url) {
        const sep = url.includes("?") ? "&" : "?";
        url = `${url}${sep}cb=${Date.now()}`;
        return url;
      }
      return null;
    } catch (e) {
      console.warn("[AddRecipe] Backend upload exception", e);
      return null;
    }
  };

  // Compress image helper
  const MAX_IMAGE_DIMENSION = 1600;

  async function compressImageIfNeeded(uri: string): Promise<string> {
    try {
      if (!uri) return uri;

      const info = await (ImageManipulator as any).getInfoAsync(uri, { size: true } as any);
      const width = (info as any)?.width as number | undefined;
      const height = (info as any)?.height as number | undefined;

      const actions: ImageManipulator.Action[] = [];

      if (width && height) {
        const longest = Math.max(width, height);
        if (longest > MAX_IMAGE_DIMENSION) {
          const scale = MAX_IMAGE_DIMENSION / longest;
          actions.push({
            resize: {
              width: Math.round(width * scale),
              height: Math.round(height * scale),
            } as any,
          } as any);
        }
      }

      const result = await ImageManipulator.manipulateAsync(
        uri,
        actions,
        {
          compress: 0.7,
          format: ImageManipulator.SaveFormat.JPEG,
        }
      );

      return result?.uri || uri;
    } catch (e) {
      console.warn("[AddRecipe] compressImageIfNeeded failed", e);
      return uri;
    }
  }

  const saveRecipe = async () => {
    // avoid double taps
    if (saving) return;

    if (!title.trim()) {
      Alert.alert(t("common.validation"), t("recipes.validation_title_required"));
      return;
    }
    if (parseListMultiline(ingredients).length === 0) {
      Alert.alert(t("common.validation"), t("recipes.validation_ingredient_required"));
      return;
    }
    if (parseListMultiline(steps).length === 0) {
      Alert.alert(t("common.validation"), t("recipes.validation_step_required"));
      return;
    }

    try {
      setSaving(true);
      // Map selectedCookbooks (IDs) to cookbook objects: {id, name}
      let selectedCookbookObjs =
        cookbooks
          .filter(cb => selectedCookbooks.includes(cb.id))
          .map(cb => ({ id: cb.id, name: cb.name }));
      // If no cookbook matches, persist empty array (not undefined)
      if (!selectedCookbookObjs || selectedCookbookObjs.length === 0) {
        selectedCookbookObjs = [];
      }

      // Upload image if needed
      let finalImageUri: string | undefined = image;
      if (image && (image.startsWith("file:") || image.startsWith("content:"))) {
        const tempId = editingRecipe ? editingRecipe.id : `${Date.now()}`;
        const uploaded = await uploadRecipePhoto(image, auth.currentUser?.uid, tempId);
        if (uploaded) {
          console.log("[AddRecipe] Image uploaded =>", uploaded);
          finalImageUri = uploaded;
        } else {
          // If upload failed, keep the local URI so the image still shows on this device
          console.warn("[AddRecipe] Upload failed or skipped, keeping local image URI");
          finalImageUri = image;
        }
      }

      const nextNutritionInfo = buildNutritionInfoForSave(editingRecipe?.nutritionInfo, {
        calories: nutritionCalories,
        protein: nutritionProtein,
        carbs: nutritionCarbs,
        fat: nutritionFat,
      });
      const nextNutritionSnapshot = buildNutritionSnapshot({
        calories: nutritionCalories,
        protein: nutritionProtein,
        carbs: nutritionCarbs,
        fat: nutritionFat,
      });
      const canPersistEstimateMeta =
        !!nutritionEstimateMeta &&
        nutritionEstimateMeta.ingredientsSignature === currentIngredientsSignature &&
        nextNutritionSnapshot.calories === normalizeComparableNutritionValue(nutritionEstimateMeta.calories) &&
        nextNutritionSnapshot.protein === normalizeComparableNutritionValue(nutritionEstimateMeta.protein) &&
        nextNutritionSnapshot.carbs === normalizeComparableNutritionValue(nutritionEstimateMeta.carbs) &&
        nextNutritionSnapshot.fat === normalizeComparableNutritionValue(nutritionEstimateMeta.fat);

      // Build the complete recipe object with all fields
      const newRecipe: Recipe = {
        id: editingRecipe ? editingRecipe.id : `${Date.now()}`,
        title: title.trim(),
        cookingTime: parseInt(cookingTime) || 30,
        difficulty,
        servings: parseInt(servings) || nutritionEstimateMeta?.servingInfo?.servings || editingRecipe?.servingInfo?.servings || 1,
        servingInfo:
          nutritionEstimateMeta?.servingInfo ??
          editingRecipe?.servingInfo ??
          (parseInt(servings)
            ? {
                servings: parseInt(servings),
                source: "manual",
                updatedAt: new Date().toISOString(),
              }
            : null),
        cost,
        ingredients: parseListMultiline(ingredients),
        steps: parseListMultiline(steps),
        tags: [...tags],
        cookbooks: selectedCookbookObjs,
        createdAt: editingRecipe ? editingRecipe.createdAt : new Date().toISOString(),
        image: finalImageUri,
        imageUrl: finalImageUri,
        nutritionInfo: nextNutritionInfo,
        mealLoggingRepresentation: canPersistEstimateMeta ? estimatedMealLoggingRepresentation : null,
        nutritionEstimateMeta: canPersistEstimateMeta
          ? {
              ingredientsSignature: nutritionEstimateMeta.ingredientsSignature,
              perServing: {
                calories: normalizeComparableNutritionValue(nutritionEstimateMeta.calories),
                protein: normalizeComparableNutritionValue(nutritionEstimateMeta.protein),
                carbs: normalizeComparableNutritionValue(nutritionEstimateMeta.carbs),
                fat: normalizeComparableNutritionValue(nutritionEstimateMeta.fat),
              },
            }
          : null,
      };

      const stored = await AsyncStorage.getItem("recipes");
      let arr: Recipe[] = stored ? JSON.parse(stored) : [];

      if (editingRecipe) {
        // Replace the entire recipe object with the updated one (not partial)
        arr = arr.map((r: Recipe) => (r.id === editingRecipe.id ? { ...newRecipe } : r));
      } else {
        arr.unshift(newRecipe);
      }

      // Always persist updated recipes list locally for UI and legacy readers
      try {
        await AsyncStorage.setItem("recipes", JSON.stringify(arr));
      } catch (err) {
        console.warn("[AddRecipe] Failed to persist 'recipes' to AsyncStorage", err);
      }

      if (syncEngine) {
        try {
          await syncEngine.saveLocalRecipesSnapshot(arr);

          // Map UI difficulty/cost to Firestore-friendly values
          const difficultyForSync =
            difficulty === "Easy"
              ? "easy"
              : difficulty === "Moderate"
              ? "medium"
              : "hard";

          const costForSync =
            cost === "Cheap"
              ? "low"
              : cost === "Medium"
              ? "medium"
              : cost === "Expensive"
              ? "high"
              : null;

          const nowTs = Date.now();

          // Mark this recipe as dirty so RecipeSync can push to Firestore
          try {
            await syncEngine.markRecipeDirty({
              id: newRecipe.id,
              title: newRecipe.title,
              imageUrl: finalImageUri ?? null,
              cookingTimeMinutes: newRecipe.cookingTime || 30,
              servings: newRecipe.servings || 2,
              difficulty: difficultyForSync,
              ...(costForSync !== null ? { cost: costForSync } : {}),
              ingredients: [...newRecipe.ingredients],
              steps: [...newRecipe.steps],
              cookbookIds: newRecipe.cookbooks.map((cb) => cb.id),
              tags: [...newRecipe.tags],
              nutritionInfo: newRecipe.nutritionInfo ?? null,
              createdAt: nowTs,
              updatedAt: nowTs,
              isDeleted: false,
            });
          } catch (err) {
            console.warn("[AddRecipe] failed to mark recipe dirty for sync", err);
          }

          console.log("[AddRecipe] triggering manual sync after recipe save");
          // Request a full sync so Firestore is updated (queue-aware)
          syncEngine.requestSync("manual");
        } catch (syncErr: unknown) {
          console.warn("[AddRecipe] sync after saveRecipe failed", syncErr);
        }
      } else {
        console.warn(
          "[AddRecipe] syncEngine not available; recipe changes not persisted to local snapshot"
        );
      }
      // no-op: RecipeDetail now refetches on focus via useFocusEffect

      // 🔹 Fire analytics event for manual recipe creation/update
      try {
        if (backendUrl) {
          const currentUser = auth.currentUser;
          const userId = currentUser?.uid ?? null;
          let deviceId: string | null = null;
          try {
            deviceId = await getDeviceId();
          } catch (e) {
            console.warn("[AddRecipe] getDeviceId failed", e);
          }

          const eventType = editingRecipe ? "recipe_updated_manual" : "recipe_created_manual";

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-app-env": appEnv,
          };
          if (deviceId) headers["x-device-id"] = deviceId;
          if (userId) headers["x-user-id"] = userId;

          fetch(`${backendUrl}/analytics-event`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              eventType,
              userId,
              deviceId,
              metadata: {
                source: "manual_form",
                recipeId: newRecipe.id,
                title: newRecipe.title,
                hasImage: !!finalImageUri,
                ingredientsCount: newRecipe.ingredients.length,
                stepsCount: newRecipe.steps.length,
                tagsCount: newRecipe.tags.length,
                cookbooksCount: newRecipe.cookbooks.length,
                appEnv,
              },
            }),
          }).catch((err) => {
            console.warn("[AddRecipe] analytics-event fetch failed", err);
          });
        }
      } catch (e) {
        console.warn("[AddRecipe] analytics logging failed", e);
      }

      try {
        if (backendUrl) {
          const storedRecipes = await AsyncStorage.getItem("recipes");
          const parsedRecipes = storedRecipes ? JSON.parse(storedRecipes) : [];
          const activeRecipeCount = Array.isArray(parsedRecipes)
            ? parsedRecipes.filter((item: any) => !item?.isDeleted).length
            : 0;
          const rewardRes =
            (await claimRewardKeysSequentially(
              {
                backendUrl,
                appEnv,
                auth,
              },
              getRecipeRewardKeysForCount(activeRecipeCount)
            )) ||
            (await claimEconomyReward({
              backendUrl,
              appEnv,
              auth,
              rewardKey: "first_recipe_saved_v1",
            }));
          if (typeof rewardRes?.cookies === "number") {
            await writeCachedEconomySnapshot(auth.currentUser?.uid, {
              balance: rewardRes.cookies,
              freePremiumActionsRemaining:
                typeof rewardRes?.freePremiumActionsRemaining === "number"
                  ? rewardRes.freePremiumActionsRemaining
                  : freePremiumActionsRemaining,
            });
          }
        }
      } catch (rewardErr) {
        console.warn("[AddRecipe] reward claim failed", rewardErr);
      }

      router.back();
    } catch (err) {
      console.error("Error saving recipe:", err);
      Alert.alert(t("common.error_generic"), t("recipes.save_error"));
    } finally {
      setSaving(false);
    }
  };

  const estimateNutrition = async () => {
    if (!hasAtLeastOneIngredientLine || isEstimatingNutrition || nutritionEstimateLocked) return;

    let recipeForEstimate: SavedRecipe | null = null;
    try {
      const allowed = await requestNutritionEstimateEconomy("preview");
      if (!allowed) return;

      setIsEstimatingNutrition(true);

      await new Promise((resolve) => setTimeout(resolve, 350));

      recipeForEstimate = {
        id: editingRecipe?.id || "draft-recipe-estimate",
        title: title.trim() || "Recipe",
        servings: parseInt(servings, 10) > 0 ? Math.max(parseInt(servings, 10), 1) : null,
        ingredients: parseListMultiline(ingredients),
        nutritionInfo: null,
        nutrition: null,
        mealLoggingRepresentation: null,
      };

      let nutrition;
      let mealLoggingRepresentation = null;
      try {
        const resolved = await resolveRecipeNutritionEstimate(recipeForEstimate, i18n.language);
        nutrition = resolved.nutrition;
        mealLoggingRepresentation = null;
      } catch (error) {
        console.warn("[AddRecipe] resolveRecipeNutritionEstimate failed, using local fallback", error);
        nutrition = estimateRecipeNutrition(recipeForEstimate);
        mealLoggingRepresentation = null;
      }

      const committed = await requestNutritionEstimateEconomy("commit");
      if (!committed) return;

      const nextProtein = String(nutrition.proteinPerServing);
      const nextCarbs = String(nutrition.carbsPerServing);
      const nextFat = String(nutrition.fatPerServing);
      const nextCalories = String(nutrition.caloriesPerServing);

      setNutritionCalories(nextCalories);
      setNutritionProtein(nextProtein);
      setNutritionCarbs(nextCarbs);
      setNutritionFat(nextFat);
      if (nutrition.servings && nutrition.servings > 0) {
        setServings(String(nutrition.servings));
      }
      setNutritionEstimateMeta({
        ingredientsSignature: currentIngredientsSignature,
        calories: nextCalories,
        protein: nextProtein,
        carbs: nextCarbs,
        fat: nextFat,
        servingInfo: nutrition.servingInfo ?? null,
      });
      setEstimatedMealLoggingRepresentation(mealLoggingRepresentation);
      setNutritionEstimateLocked(true);
    } catch (err) {
      console.warn("[AddRecipe] Failed to estimate nutrition", err);
      if (recipeForEstimate) {
        try {
          const fallback = estimateRecipeNutrition(recipeForEstimate);
          const nextCalories = String(fallback.caloriesPerServing);
          const nextProtein = String(fallback.proteinPerServing);
          const nextCarbs = String(fallback.carbsPerServing);
          const nextFat = String(fallback.fatPerServing);
          setNutritionCalories(nextCalories);
          setNutritionProtein(nextProtein);
          setNutritionCarbs(nextCarbs);
          setNutritionFat(nextFat);
          setNutritionEstimateMeta({
            ingredientsSignature: currentIngredientsSignature,
            calories: nextCalories,
            protein: nextProtein,
            carbs: nextCarbs,
            fat: nextFat,
          });
          setNutritionEstimateLocked(true);
          return;
        } catch (fallbackError) {
          console.warn("[AddRecipe] Local fallback estimate failed", fallbackError);
        }
      }
      Alert.alert(t("common.error_generic"), t("recipes.nutrition_estimate_error"));
    } finally {
      setIsEstimatingNutrition(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={["left", "right", "bottom"]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: editingRecipe ? t("recipes.edit_recipe") : t("recipes.add_recipe"),
          headerTransparent: false,
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
          headerLeft: () => (
            <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
              <Ionicons name="arrow-back" size={26} color="#fff" />
            </TouchableOpacity>
          ),
          headerTitleStyle: { fontWeight: "600" },
        }}
      />
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <KeyboardAwareScrollView
          style={styles.container}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 30 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          enableOnAndroid={true}
          extraScrollHeight={80}
          keyboardOpeningTime={0}
        >
          {/* Foto */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.recipe_photo")}</Text>
          <TouchableOpacity onPress={pickImage} style={styles.imagePicker}>
            <Image
              source={image ? { uri: image } : defaultImage}
              style={styles.imagePreview}
            />
            <Text style={{ color: text, marginTop: 6 }}>
              {image ? t("recipes.tap_to_change_image") : t("recipes.tap_to_upload_image")}
            </Text>
          </TouchableOpacity>

          {/* Title */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.title")} *</Text>
          <TextInput
            style={[styles.input, { color: text, borderColor: border, backgroundColor: card }]}
            value={title}
            onChangeText={(text) => setTitle(sanitizeInput(text))}
            placeholder={t("recipes.title_placeholder")}
            placeholderTextColor="#888"
          />

          {/* Cooking Time */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.cooking_time")}</Text>
          <TextInput
            style={[styles.input, { color: text, borderColor: border, backgroundColor: card }]}
            value={cookingTime}
            onChangeText={(text) => setCookingTime(sanitizeInput(text))}
            placeholder="e.g. 30"
            placeholderTextColor="#888"
            keyboardType="numeric"
          />

          {/* Difficulty */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.difficulty")}</Text>
          <View style={styles.row}>
            {([
              { label: t("difficulty.easy"), value: "Easy" },
              { label: t("difficulty.moderate"), value: "Moderate" },
              { label: t("difficulty.challenging"), value: "Challenging" },
            ] as const).map(({ label, value }) => (
              <AppButton
                key={value}
                label={label}
                onPress={() => setDifficulty(value)}
                variant={difficulty === value ? "primary" : "secondary"}
                fullWidth={false}
                style={{
                  flex: 1,
                  marginHorizontal: 4,
                  ...(difficulty === value && bg !== "#fff" ? { backgroundColor: "#E27D60" } : {}),
                }}
              />
            ))}
          </View>

          {/* Servings */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.servings")}</Text>
          <TextInput
            style={[styles.input, { color: text, borderColor: border, backgroundColor: card }]}
            value={servings}
            onChangeText={(text) => {
              // Allow only numeric input, after sanitization
              const numeric = sanitizeInput(text).replace(/[^0-9]/g, "");
              setServings(numeric);
            }}
            placeholder="e.g. 4"
            placeholderTextColor="#888"
            keyboardType="numeric"
          />

          {/* Ingredients */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.ingredients", { defaultValue: "Ingredients" })} *</Text>
          <Text style={[styles.helperText, styles.sectionHintTight, { color: isDark ? "#c8ced8" : "#667085" }]}>
            {t("recipes.one_per_line", { defaultValue: "One per line" })}
          </Text>
          <AutoExpandingTextInput
            style={[
              styles.input,
              styles.expandingField,
              {
                textAlignVertical: "top",
                color: text,
                borderColor: border,
                backgroundColor: card,
              },
            ]}
            value={ingredients}
            onChangeText={(text) => setIngredients(normalizeListInput(text, "bullet"))}
            placeholder={t("recipes.ingredients_placeholder")}
            placeholderTextColor="#888"
            multiline
            minHeight={80}
            maxHeight={260}
          />

          {/* Preparation */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.preparation", { defaultValue: "Preparation" })} *</Text>
          <Text style={[styles.helperText, styles.sectionHintTight, { color: isDark ? "#c8ced8" : "#667085" }]}>
            {t("recipes.one_step_per_line", { defaultValue: "One step per line" })}
          </Text>
          <AutoExpandingTextInput
            style={[
              styles.input,
              styles.expandingField,
              {
                textAlignVertical: "top",
                color: text,
                borderColor: border,
                backgroundColor: card,
              },
            ]}
            value={steps}
            onChangeText={(text) => setSteps(normalizeListInput(text, "numbered"))}
            placeholder={t("recipes.preparation_placeholder")}
            placeholderTextColor="#888"
            multiline
            minHeight={120}
            maxHeight={320}
          />

          {/* Nutrition Info */}
          <View style={styles.sectionHeaderRow}>
            <Text style={[styles.label, styles.sectionHeaderLabel, { color: text }]}>
              {t("recipes.nutrition_info", { defaultValue: "Nutrition per serving" })}
            </Text>
            <TouchableOpacity
              disabled={!hasAtLeastOneIngredientLine || isEstimatingNutrition || nutritionEstimateLocked}
              onPress={estimateNutrition}
              activeOpacity={0.85}
              style={[
                styles.estimateButton,
                {
                  backgroundColor: isEstimatingNutrition
                    ? isDark
                      ? "#3b4352"
                      : "#d7dce5"
                    : hasAtLeastOneIngredientLine && !nutritionEstimateLocked
                    ? bg !== "#fff"
                      ? "#E27D60"
                      : "#293a53"
                    : isDark
                    ? "#3b4352"
                    : "#d7dce5",
                  borderColor: isEstimatingNutrition
                    ? isDark
                      ? "#3b4352"
                      : "#d7dce5"
                    : hasAtLeastOneIngredientLine && !nutritionEstimateLocked
                    ? bg !== "#fff"
                      ? "#E27D60"
                      : "#293a53"
                    : isDark
                    ? "#3b4352"
                    : "#d7dce5",
                  opacity: hasAtLeastOneIngredientLine && !nutritionEstimateLocked ? 1 : 0.7,
                },
              ]}
            >
              {isEstimatingNutrition ? (
                <View style={styles.estimateButtonLoadingContent}>
                  <ActivityIndicator size="small" color={isDark ? "#c1c8d3" : "#7b8798"} />
                  <Text
                    style={[
                      styles.estimateButtonText,
                      { color: isDark ? "#c1c8d3" : "#7b8798" },
                    ]}
                  >
                    {t("recipes.checking_ingredients", { defaultValue: "Checking ingredients" })}
                  </Text>
                </View>
              ) : (
                <>
                  <Text
                    style={[
                      styles.estimateButtonText,
                      {
                        color:
                          hasAtLeastOneIngredientLine && !nutritionEstimateLocked
                            ? "#fff"
                            : isDark
                            ? "#c1c8d3"
                            : "#7b8798",
                      },
                    ]}
                  >
                    {t("recipes.ai_estimate", { defaultValue: "AI Estimate" })}
                  </Text>
                  {shouldHidePremiumPricing(freePremiumActionsRemaining) ? null : (
                    <>
                      <EggIcon
                        size={14}
                        variant="mono"
                        tintColor={
                          hasAtLeastOneIngredientLine && !nutritionEstimateLocked
                            ? "#fff"
                            : isDark
                            ? "#c1c8d3"
                            : "#7b8798"
                        }
                      />
                      <Text
                        style={[
                          styles.estimateButtonCost,
                          {
                            color:
                              hasAtLeastOneIngredientLine && !nutritionEstimateLocked
                                ? "#fff"
                                : isDark
                                ? "#c1c8d3"
                                : "#7b8798",
                          },
                        ]}
                      >
                        1
                      </Text>
                    </>
                  )}
                </>
              )}
            </TouchableOpacity>
          </View>
          <Text style={[styles.helperText, styles.sectionHintTight, { color: isDark ? "#c8ced8" : "#667085" }]}>
            {t("recipes.nutrition_info_helper", {
              defaultValue: "Estimate these values automatically, or add them manually.",
            })}
          </Text>
          <AppCard>
            {isEstimatingNutrition ? (
              <Text
                style={[
                  styles.helperText,
                  styles.nutritionEstimateLoadingText,
                  { color: isDark ? "#c8ced8" : "#667085" },
                ]}
              >
                {t("recipes.nutrition_estimating_helper", {
                  defaultValue:
                    "We’re checking this recipe’s ingredients. If some aren’t in our nutrition catalog yet, we’ll use AI to estimate them for you.",
                })}
              </Text>
            ) : (
              <View style={styles.nutritionGrid}>
                {[
                  {
                    key: "calories",
                    label: t("recipes.nutrition_calories", { defaultValue: "Calories" }),
                    unit: "kcal",
                    value: nutritionCalories,
                    onChange: setNutritionCalories,
                  },
                  {
                    key: "protein",
                    label: t("recipes.nutrition_protein", { defaultValue: "Protein" }),
                    unit: "g",
                    value: nutritionProtein,
                    onChange: setNutritionProtein,
                  },
                  {
                    key: "carbs",
                    label: t("recipes.nutrition_carbs", { defaultValue: "Carbs" }),
                    unit: "g",
                    value: nutritionCarbs,
                    onChange: setNutritionCarbs,
                  },
                  {
                    key: "fat",
                    label: t("recipes.nutrition_fat", { defaultValue: "Fat" }),
                    unit: "g",
                    value: nutritionFat,
                    onChange: setNutritionFat,
                  },
                ].map((field) => (
                  <View key={field.key} style={styles.nutritionField}>
                    <Text style={[styles.nutritionFieldLabel, { color: text }]}>{field.label}</Text>
                    <View style={styles.nutritionFieldRow}>
                      <View
                        style={[
                          styles.nutritionValueBox,
                          {
                            borderColor: border,
                            backgroundColor: card,
                          },
                        ]}
                      >
                        <TextInput
                          style={[
                            styles.nutritionInput,
                            {
                              color: text,
                            },
                          ]}
                          value={field.value}
                          onChangeText={(value) => field.onChange(sanitizeNutritionDecimalInput(value))}
                          placeholder="0"
                          placeholderTextColor="#888"
                          keyboardType={Platform.OS === "ios" ? "decimal-pad" : "numeric"}
                        />
                      </View>
                      <Text style={[styles.nutritionUnit, { color: isDark ? "#c8ced8" : "#667085" }]}>
                        {field.unit}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </AppCard>

          {/* Cookbook Section */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.cookbooks")}</Text>
          <AppCard>
            {cookbooks.length === 0 ? (
              <Text style={{ color: text, fontStyle: "italic" }}>{t("recipes.no_cookbooks")}</Text>
            ) : (
              <>
                {cookbooks.map((cb) => (
                  <View
                    key={cb.id}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingVertical: 4,
                      borderBottomWidth: 1,
                      borderBottomColor: border,
                    }}
                  >
                    <Switch
                      value={selectedCookbooks.includes(cb.id)}
                      onValueChange={() => toggleCookbook(cb.id)}
                      thumbColor={
                        selectedCookbooks.includes(cb.id)
                          ? bg !== "#fff"
                            ? "#E27D60"
                            : "#293a53"
                          : undefined
                      }
                      trackColor={{
                        false: "#ccc",
                        true: bg !== "#fff" ? "#f2a48f" : "#a0b9d6",
                      }}
                    />
                    <Text style={{ marginLeft: 12, color: text, fontSize: 16 }}>{cb.name}</Text>
                  </View>
                ))}
              </>
            )}
            <View style={styles.inputButtonRow}>
              <TextInput
                style={[
                  styles.input,
                  styles.inputRowField,
                  {
                    color: text,
                    borderColor: border,
                    backgroundColor: card,
                  },
                ]}
                placeholder={t("recipes.add_cookbook")}
                placeholderTextColor="#888"
                value={newCookbookName}
                onChangeText={(text) => setNewCookbookName(sanitizeInput(text))}
              />
              <AppButton
                label={t("common.add")}
                onPress={addCookbook}
                variant="primary"
                fullWidth={false}
                style={StyleSheet.flatten([
                  styles.inputRowButton,
                  bg !== "#fff" ? { backgroundColor: "#E27D60" } : {},
                ])}
              />
            </View>
          </AppCard>

          {/* Tags Section */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.tags")}</Text>
          <AppCard>
            <View style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: 10 }}>
              {allTags.map((tag) => (
                <TagChip
                  key={tag}
                  label={tag}
                  selected={tags.includes(tag)}
                  onPress={() => toggleTag(tag)}
                  card={card}
                  border={border}
                  textColor={text}
                />
              ))}
            </View>
            <View style={styles.inputButtonRow}>
              <TextInput
                style={[
                  styles.input,
                  styles.inputRowField,
                  {
                    color: text,
                    borderColor: border,
                    backgroundColor: card,
                  },
                ]}
                placeholder={t("recipes.add_tag")}
                placeholderTextColor="#888"
                value={newTag}
                onChangeText={(text) => setNewTag(sanitizeInput(text))}
                onSubmitEditing={addTag}
                returnKeyType="done"
              />
              <AppButton
                label={t("common.add")}
                onPress={addTag}
                variant="primary"
                fullWidth={false}
                style={StyleSheet.flatten([
                  styles.inputRowButton,
                  bg !== "#fff" ? { backgroundColor: "#E27D60" } : {},
                ])}
              />
            </View>
          </AppCard>

          {/* Save/Update button */}
          <AppButton
            label={
              saving
                ? (t("common.saving") && !t("common.saving").includes("common.saving")
                  ? t("common.saving")
                  : "Saving...")
                : editingRecipe
                  ? t("recipes.update_recipe")
                  : t("recipes.save_recipe")
            }
            onPress={() => {
              if (!saving) {
                saveRecipe();
              }
            }}
            variant="primary"
            fullWidth
            disabled={saving}
            style={StyleSheet.flatten([
              { marginTop: 10, opacity: saving ? 0.7 : 1 },
              bg !== "#fff" ? { backgroundColor: "#E27D60" } : {},
            ])}
          />
        </KeyboardAwareScrollView>
      </TouchableWithoutFeedback>

      <InsufficientCookiesModal
        visible={insufficientModal.visible}
        isDark={isDark}
        title={t("economy.insufficient_title", "Not enough Eggs")}
        body={
          insufficientModal.context === "nutrition_estimate"
            ? `You need 1 Egg to estimate recipe nutrition values. Currently, you have ${insufficientModal.remaining} Eggs.`
            : `You need 1 Egg to create a new cookbook. Currently, you have ${insufficientModal.remaining} Eggs.`
        }
        featuredOffer={featuredOffer}
        availableRewardsCount={availableRewardsCount}
        onClose={() => setInsufficientModal((s) => ({ ...s, visible: false }))}
        onBuyOffer={() => {
          setInsufficientModal((s) => ({ ...s, visible: false }));
          goToStore("cookies_15", true);
        }}
        onOpenStore={() => {
          setInsufficientModal((s) => ({ ...s, visible: false }));
          goToStore("cookies_15");
        }}
        onOpenRewards={() => {
          setInsufficientModal((s) => ({ ...s, visible: false }));
          goToStore();
        }}
      />
    </SafeAreaView>
  );
}

const TagChip: React.FC<{
  label: string;
  selected: boolean;
  onPress: () => void;
  card: string;
  border: string;
  textColor: string;
}> = React.memo(({ label, selected, onPress, card, border, textColor }) => {
  // Use ThemeContext to get bg color for dark/light mode
  const { bg } = useThemeColors ? useThemeColors() : { bg: "#fff" };
  return (
    <TouchableOpacity
      onPress={onPress}
      delayPressIn={50}
      style={[
        styles.tagChip,
        {
          backgroundColor: selected
            ? bg !== "#fff"
              ? "#E27D60"
              : "#293a53"
            : card,
          borderColor: selected
            ? bg !== "#fff"
              ? "#E27D60"
              : "#293a53"
            : border,
        },
      ]}
    >
      <Text style={{ color: selected ? "#fff" : textColor }}>{label}</Text>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  label: { fontSize: 16, fontWeight: "500", marginTop: 15, marginBottom: 5 },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 15,
    marginBottom: 5,
  },
  sectionHeaderLabel: {
    marginTop: 0,
    marginBottom: 0,
    flex: 1,
  },
  helperText: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  sectionHintTight: {
    marginTop: -2,
    marginBottom: 4,
  },
  sectionFooterHint: {
    marginTop: 8,
    marginBottom: 0,
  },
  nutritionActionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginBottom: 12,
  },
  estimateButton: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 5,
    marginLeft: 12,
  },
  estimateButtonText: {
    fontSize: 13,
    fontWeight: "700",
  },
  estimateButtonCost: {
    fontSize: 13,
    fontWeight: "700",
  },
  estimateButtonLoadingContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  input: {
    borderWidth: 1,
    padding: 12,
    borderRadius: 10,
    fontSize: 16,
    marginBottom: 10,
    minHeight: 44,
  },
  expandingField: {
    marginBottom: 0,
  },
  row: { flexDirection: "row", marginBottom: 10 },
  nutritionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  nutritionField: {
    width: "46%",
    marginBottom: 14,
  },
  nutritionFieldLabel: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  nutritionFieldRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  nutritionValueBox: {
    borderWidth: 1,
    borderRadius: 14,
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: "center",
    width: 112,
  },
  nutritionInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
    paddingVertical: 0,
    minHeight: 24,
  },
  nutritionUnit: {
    fontSize: 14,
    fontWeight: "500",
    marginLeft: 8,
  },
  nutritionEstimateLoadingText: {
    marginTop: 0,
    marginBottom: 0,
  },
  imagePicker: { alignItems: "center", marginBottom: 16 },
  imagePreview: { width: 200, height: 200, borderRadius: 12, backgroundColor: "#eee" },
  tagChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    marginRight: 8,
    marginBottom: 8,
  },
  inputButtonRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    marginBottom: 0,
  },
  inputRowField: {
    flex: 1,
    marginRight: 6,
    minHeight: 44,
    height: 44,
    marginBottom: 0,
    paddingVertical: 0,
    // Ensure vertical centering of the text inside TextInput on Android
    textAlignVertical: Platform.OS === "android" ? "center" : "auto",
  },
  inputRowButton: {
    flexShrink: 0,
    paddingHorizontal: 18,
    height: 44,
    marginBottom: 0,
    justifyContent: "center",
    alignItems: "center",
    alignSelf: "center",
    paddingVertical: 0,
    // Nudge up slightly on Android to counter baseline differences
    marginTop: Platform.OS === "android" ? 0 : 0,
  },
  // --- Insufficient cookies modal styles (match History / AI Kitchen) ---
  modalBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#00000088",
  },
  modalCenter: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 18,
  },
  modalCard: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
  },
  modalTitleCookies: {
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 8,
  },
  modalBodyCookies: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  modalOfferCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 6,
    marginBottom: 14,
  },
  modalOfferLeft: { flex: 1, paddingRight: 12 },
  modalOfferRight: { justifyContent: "center", alignItems: "flex-end" },
  modalOfferTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modalOfferTopLeft: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
  },
  modalOfferTitle: { fontSize: 18, fontWeight: "900" },
  modalOfferPriceLine: { fontSize: 15, marginTop: 8, fontWeight: "600" },
  modalActionsRow: {
    flexDirection: "row",
    gap: 10,
  },
  modalActionBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modalActionText: {
    fontSize: 15,
    fontWeight: "900",
  },
  buyBtnCookies: {
    backgroundColor: "#E27D60",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 14,
    minWidth: 92,
    alignItems: "center",
    justifyContent: "center",
    elevation: 3,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  buyBtnTextCookies: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "900",
  },
  modalCloseBtn: {
    position: "absolute",
    top: 12,
    right: 12,
    zIndex: 10,
    padding: 6,
  },
  modalCloseText: {
    fontSize: 18,
    fontWeight: "900",
  },
  cookbookPricingNote: {
    fontSize: 13,
    marginTop: 6,
    marginLeft: 4,
    lineHeight: 18,
  },
});
// --- AutoExpandingTextInput component ---
import { TextInput as RNTextInput } from "react-native";

type AutoExpandingTextInputProps = React.ComponentProps<typeof RNTextInput> & {
  minHeight?: number;
  maxHeight?: number;
};

const AutoExpandingTextInput: React.FC<AutoExpandingTextInputProps> = ({
  minHeight = 60,
  maxHeight = 200,
  style,
  value,
  ...props
}) => {
  const [inputHeight, setInputHeight] = useState(minHeight);
  const inputRef = useRef<RNTextInput>(null);

  useEffect(() => {
    if (typeof value !== "string") {
      setInputHeight(minHeight);
      return;
    }

    const lineCount = Math.max(1, value.split("\n").length);
    const estimatedHeight = 24 + lineCount * 22;
    setInputHeight(Math.max(minHeight, Math.min(maxHeight, estimatedHeight)));
  }, [value, minHeight, maxHeight]);

  const handleContentSizeChange = (event: any) => {
    const newHeight = Math.max(
      minHeight,
      Math.min(maxHeight, event.nativeEvent.contentSize.height)
    );
    setInputHeight(newHeight);
  };

  return (
    <RNTextInput
      {...props}
      value={value}
      ref={inputRef}
      multiline
      style={[
        style,
        { minHeight, maxHeight, height: inputHeight }
      ]}
      onContentSizeChange={handleContentSizeChange}
    />
  );
};
