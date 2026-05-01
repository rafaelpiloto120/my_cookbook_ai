import React, { useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { signInAnonymously } from "firebase/auth";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";

import InsufficientCookiesModal from "./InsufficientCookiesModal";
import MyDayMealEditorModal from "./MyDayMealEditorModal";
import { useThemeColors } from "../context/ThemeContext";
import { auth } from "../firebaseConfig";
import { getApiBaseUrl } from "../lib/config/api";
import {
  fetchEconomyCatalogBundle,
  shouldHidePremiumPricing,
  type EconomyCatalogOffer,
} from "../lib/economy/client";
import { claimRewardKeysSequentially, getMealRewardKeysForCount } from "../lib/economy/rewards";
import { loadMeasurementSystemPreference, MeasurementSystem } from "../lib/myDay";
import {
  addPhotoMeal,
  addTextMeal,
  loadMyDayMeals,
  MyDayMealIngredient,
  removeMeal,
  resolveMealEstimate,
  resolveStructuredMealEstimate,
  updateMeal,
} from "../lib/myDayMeals";
import {
  buildRecipeMealLoggingRepresentation,
  estimateRecipeNutrition,
  isRecipeMealLoggingRepresentationUsable,
  loadSavedRecipes,
  logRecipeMeal,
  needsRecipeMealLoggingRepresentationEnrichment,
  parseRecipeIngredientLine,
  persistRecipeNutritionEstimate,
  resolveRecipeNutritionEstimate,
  SavedRecipe,
} from "../lib/myDayRecipes";
import { getRecipeCaloriesPerServing } from "../lib/recipes/nutrition";
import { normalizeRecipeDifficulty } from "../lib/recipes/difficulty";
import { useSyncEngine } from "../lib/sync/SyncEngine";
import { getDeviceId } from "../utils/deviceId";

type Mode = "photo" | "text" | "recipe";
type PremiumActionKey = "describe_meal" | "meal_photo_log";
type RecipePickerCalorieFilterOption = "none" | "low" | "medium" | "high";

type EditableTotals = {
  title: string;
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
};

type ReviewIngredient = {
  name: string;
  quantity: string;
  unit: string;
};

type PhotoAnalysisResponse = {
  isFood: boolean;
  confidence: number;
  title: string;
  ingredients: ReviewIngredient[];
  nutrition: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  };
};

type Props = {
  visible: boolean;
  targetDate?: Date;
  initialMode?: Mode | null;
  cookieBalance?: number | null;
  freePremiumActionsRemaining?: number | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
};

const API_BASE_URL = getApiBaseUrl() || "http://10.0.2.2:3000";
const REVIEW_DEFAULT_VISIBLE_COUNT = 6;
const RECIPE_PICKER_PAGE_SIZE = 20;
const MAX_MEAL_PHOTO_DIMENSION = 1400;
const GRAMS_PER_OUNCE = 28.349523125;
const ML_PER_FLUID_OUNCE = 29.5735295625;
const POUNDS_PER_KILOGRAM = 2.2046226218;
const FLUID_OUNCES_PER_LITER = 33.8140227018;

function parseNumber(value: string | number | null | undefined, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDisplayQuantity(value: number) {
  if (!Number.isFinite(value)) return "";
  const rounded =
    Math.abs(value) >= 10 ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100;
  return `${Number(rounded.toFixed(Math.abs(rounded) >= 10 ? 1 : 2))}`;
}

function nutrientUnitForDisplay(measurement: MeasurementSystem) {
  return measurement === "US" ? "oz" : "g";
}

function nutrientValueForDisplay(value: number, measurement: MeasurementSystem) {
  if (!Number.isFinite(value)) return "0";
  if (measurement !== "US") return `${Math.round(value)}`;
  return formatDisplayQuantity(value / GRAMS_PER_OUNCE);
}

function unitForDisplay(unit: string, measurement: MeasurementSystem) {
  const normalizedUnit = unit.trim().toLowerCase();
  if (measurement !== "US") return unit;
  if (normalizedUnit === "g") return "oz";
  if (normalizedUnit === "kg") return "lb";
  if (normalizedUnit === "ml" || normalizedUnit === "l") return "fl oz";
  return unit;
}

function normalizeReviewUnitLabel(unit: string) {
  const normalized = unit.trim().toLowerCase();
  if (normalized === "tbsp" || normalized === "tbsps") return "tbsp";
  if (normalized === "tsp" || normalized === "tsps") return "tsp";
  if (normalized === "cloves") return "clove";
  if (normalized === "slices") return "slice";
  if (normalized === "cups") return "cup";
  if (normalized === "tablespoons") return "tablespoon";
  if (normalized === "teaspoons") return "teaspoon";
  return unit;
}

function quantityForDisplay(quantity: string, unit: string, measurement: MeasurementSystem) {
  const parsed = Number(String(quantity).replace(",", "."));
  if (!Number.isFinite(parsed) || measurement !== "US") return quantity;

  const normalizedUnit = unit.trim().toLowerCase();
  if (normalizedUnit === "g") return formatDisplayQuantity(parsed / GRAMS_PER_OUNCE);
  if (normalizedUnit === "kg") return formatDisplayQuantity(parsed * POUNDS_PER_KILOGRAM);
  if (normalizedUnit === "ml") return formatDisplayQuantity(parsed / ML_PER_FLUID_OUNCE);
  if (normalizedUnit === "l") return formatDisplayQuantity(parsed * FLUID_OUNCES_PER_LITER);
  return quantity;
}

function quantityFromDisplay(quantity: string, storedUnit: string, measurement: MeasurementSystem) {
  const parsed = Number(String(quantity).replace(",", "."));
  if (!Number.isFinite(parsed) || measurement !== "US") return quantity;

  const normalizedUnit = storedUnit.trim().toLowerCase();
  if (normalizedUnit === "g") return formatDisplayQuantity(parsed * GRAMS_PER_OUNCE);
  if (normalizedUnit === "kg") return formatDisplayQuantity(parsed / POUNDS_PER_KILOGRAM);
  if (normalizedUnit === "ml") return formatDisplayQuantity(parsed * ML_PER_FLUID_OUNCE);
  if (normalizedUnit === "l") return formatDisplayQuantity(parsed / FLUID_OUNCES_PER_LITER);
  return quantity;
}

function sanitizePositiveDecimalInput(value: string) {
  const normalized = value.replace(",", ".");
  const cleaned = normalized.replace(/[^0-9.]/g, "");
  const [whole = "", ...rest] = cleaned.split(".");
  const decimals = rest.join("").slice(0, 2);
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  if (cleaned.includes(".")) return `${trimmedWhole || "0"}.${decimals}`;
  return trimmedWhole;
}

function sanitizeIngredientNameInput(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[^\p{L}\p{N}\s'.,()\/-]/gu, "")
    .replace(/\s+/g, " ")
    .trimStart()
    .slice(0, 60);
}

function sanitizeReviewIngredient(item: ReviewIngredient): ReviewIngredient | null {
  const name = sanitizeIngredientNameInput(String(item.name || "")).trim();
  const quantity = sanitizePositiveDecimalInput(String(item.quantity || ""));
  const parsedQuantity = Number(quantity);
  const allowedUnits = new Set(["g", "ml", "tbsp", "tsp", "un"]);
  const unit = allowedUnits.has(String(item.unit || "").trim().toLowerCase())
    ? String(item.unit || "").trim().toLowerCase()
    : "g";

  if (!name || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0) return null;

  return {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    quantity,
    unit,
  };
}

function sanitizeReviewIngredients(items: ReviewIngredient[]) {
  return items.map(sanitizeReviewIngredient).filter(Boolean) as ReviewIngredient[];
}

function quantityFactor(quantity: string, unit: string) {
  const raw = Number(quantity.replace(",", "."));
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const normalizedUnit = unit.trim().toLowerCase();
  if (normalizedUnit === "kg") return raw * 10;
  if (normalizedUnit === "g") return raw / 100;
  if (normalizedUnit === "ml") return raw / 100;
  if (normalizedUnit === "l") return raw * 10;
  return raw;
}

function recomputeTotals(base: EditableTotals, baseIngredients: ReviewIngredient[], ingredients: ReviewIngredient[]) {
  const totalFactor = ingredients.reduce((sum, item) => sum + quantityFactor(item.quantity, item.unit), 0);
  const baseFactor = baseIngredients.reduce((sum, item) => sum + quantityFactor(item.quantity, item.unit), 0);
  const multiplier = Math.max(totalFactor / Math.max(baseFactor, 1), 0.25);

  return {
    ...base,
    calories: String(Math.round(parseNumber(base.calories, 0) * multiplier)),
    protein: String(Math.round(parseNumber(base.protein, 0) * multiplier)),
    carbs: String(Math.round(parseNumber(base.carbs, 0) * multiplier)),
    fat: String(Math.round(parseNumber(base.fat, 0) * multiplier)),
  };
}

function getReviewUnitOptions(measurement: MeasurementSystem) {
  return measurement === "US"
    ? [
        { value: "g", label: "oz" },
        { value: "ml", label: "fl oz" },
        { value: "tbsp", label: "tbsp" },
        { value: "tsp", label: "tsp" },
        { value: "un", label: "un" },
      ]
    : [
        { value: "g", label: "g" },
        { value: "ml", label: "ml" },
        { value: "tbsp", label: "tbsp" },
        { value: "tsp", label: "tsp" },
        { value: "un", label: "un" },
      ];
}

function normalizeNewReviewIngredient(name: string, quantity: string, unit: string): ReviewIngredient | null {
  const trimmedName = sanitizeIngredientNameInput(name).trim();
  const normalizedQuantity = sanitizePositiveDecimalInput(quantity);
  const parsedQuantity = Number(normalizedQuantity);
  if (!trimmedName || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0) return null;
  return {
    name: trimmedName.charAt(0).toUpperCase() + trimmedName.slice(1),
    quantity: normalizedQuantity,
    unit,
  };
}

function areReviewIngredientsEqual(current: ReviewIngredient[], base: ReviewIngredient[]) {
  const normalizedCurrent = sanitizeReviewIngredients(current).map((item) => ({
    name: item.name.trim().toLowerCase(),
    quantity: sanitizePositiveDecimalInput(item.quantity),
    unit: item.unit.trim().toLowerCase(),
  }));
  const normalizedBase = sanitizeReviewIngredients(base).map((item) => ({
    name: item.name.trim().toLowerCase(),
    quantity: sanitizePositiveDecimalInput(item.quantity),
    unit: item.unit.trim().toLowerCase(),
  }));

  if (normalizedCurrent.length !== normalizedBase.length) return false;
  return normalizedCurrent.every((item, index) => {
    const candidate = normalizedBase[index];
    return candidate && candidate.name === item.name && candidate.quantity === item.quantity && candidate.unit === item.unit;
  });
}

function getVisibleIngredients(ingredients: ReviewIngredient[], showAll: boolean) {
  return (showAll ? ingredients : ingredients.slice(0, REVIEW_DEFAULT_VISIBLE_COUNT)).map((item, index) => ({
    item,
    index,
  }));
}

function recipeSortKey(recipe: SavedRecipe) {
  const numericId = Number(String(recipe.id || "").trim());
  if (Number.isFinite(numericId)) return numericId;
  return 0;
}

function sortRecipesForPicker(recipes: SavedRecipe[]) {
  return [...recipes].sort((a, b) => {
    const keyDiff = recipeSortKey(b) - recipeSortKey(a);
    if (keyDiff !== 0) return keyDiff;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

function getRecipePickerCalorieBucket(recipe: SavedRecipe): RecipePickerCalorieFilterOption {
  const calories = getRecipeCaloriesPerServing(recipe as any);
  if (calories === null || !Number.isFinite(calories)) return "none";
  if (calories < 300) return "low";
  if (calories <= 600) return "medium";
  return "high";
}

async function compressMealPhotoIfNeeded(uri: string): Promise<string> {
  try {
    if (!uri) return uri;
    const info = await (ImageManipulator as any).getInfoAsync(uri, { size: true } as any);
    const width = (info as any)?.width as number | undefined;
    const height = (info as any)?.height as number | undefined;
    const actions: ImageManipulator.Action[] = [];
    if (width && height) {
      const longest = Math.max(width, height);
      if (longest > MAX_MEAL_PHOTO_DIMENSION) {
        const scale = MAX_MEAL_PHOTO_DIMENSION / longest;
        actions.push({ resize: { width: Math.round(width * scale), height: Math.round(height * scale) } as any } as any);
      }
    }
    const result = await ImageManipulator.manipulateAsync(uri, actions, {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return result?.uri || uri;
  } catch (error) {
    console.warn("[MyDayAddMealFlow] compressMealPhotoIfNeeded failed", error);
    return uri;
  }
}

async function persistMealPhotoPreview(uri: string): Promise<string> {
  try {
    if (!uri || !FileSystem.documentDirectory) return uri;
    const directory = `${FileSystem.documentDirectory}my-day-meal-photos/`;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => undefined);
    const target = `${directory}meal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    await FileSystem.copyAsync({ from: uri, to: target });
    return target;
  } catch (error) {
    console.warn("[MyDayAddMealFlow] persistMealPhotoPreview failed", error);
    return uri;
  }
}

export default function MyDayAddMealFlow({
  visible,
  targetDate,
  initialMode,
  cookieBalance,
  freePremiumActionsRemaining,
  onClose,
  onSaved,
}: Props) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const syncEngine = useSyncEngine();
  const { bg, text, subText, border, card, primary, secondary, cta, isDark, modalBackdrop } = useThemeColors();
  const actionTone = isDark ? "#FFFFFF" : primary;
  const targetMealDate = targetDate ?? new Date();

  const [optionsVisible, setOptionsVisible] = useState(false);
  const [textLogVisible, setTextLogVisible] = useState(false);
  const [photoSourceVisible, setPhotoSourceVisible] = useState(false);
  const [photoReviewLoading, setPhotoReviewLoading] = useState(false);
  const [recipeLogVisible, setRecipeLogVisible] = useState(false);
  const [mealInput, setMealInput] = useState("");
  const [reviewMode, setReviewMode] = useState<Mode | null>(null);
  const [reviewDraft, setReviewDraft] = useState<EditableTotals | null>(null);
  const [reviewBase, setReviewBase] = useState<EditableTotals | null>(null);
  const [reviewIngredients, setReviewIngredients] = useState<ReviewIngredient[]>([]);
  const [reviewIngredientBase, setReviewIngredientBase] = useState<ReviewIngredient[]>([]);
  const [reviewShowAllIngredients, setReviewShowAllIngredients] = useState(false);
  const [newIngredientName, setNewIngredientName] = useState("");
  const [newIngredientQuantity, setNewIngredientQuantity] = useState("");
  const [newIngredientUnit, setNewIngredientUnit] = useState("g");
  const [unitDropdownOpen, setUnitDropdownOpen] = useState(false);
  const [nutritionMode, setNutritionMode] = useState<"auto" | "manual">("auto");
  const [textReviewLoading, setTextReviewLoading] = useState(false);
  const [photoReviewUri, setPhotoReviewUri] = useState<string | null>(null);
  const photoReviewUriRef = useRef<string | null>(null);
  const [savedRecipes, setSavedRecipes] = useState<SavedRecipe[]>([]);
  const [recipeSearchQuery, setRecipeSearchQuery] = useState("");
  const [recipeVisibleCount, setRecipeVisibleCount] = useState(RECIPE_PICKER_PAGE_SIZE);
  const [recipeLibraryLoading, setRecipeLibraryLoading] = useState(false);
  const [recipeSelectionLoading, setRecipeSelectionLoading] = useState(false);
  const [selectedRecipe, setSelectedRecipe] = useState<SavedRecipe | null>(null);
  const [reviewSaveInFlight, setReviewSaveInFlight] = useState(false);
  const reviewSaveInFlightRef = useRef(false);
  const [photoPickerInFlight, setPhotoPickerInFlight] = useState(false);
  const photoPickerInFlightRef = useRef(false);
  const [healthMeasurement, setHealthMeasurement] = useState<MeasurementSystem>("Metric");
  const [featuredOffer, setFeaturedOffer] = useState<EconomyCatalogOffer | null>(null);
  const [availableRewardsCount, setAvailableRewardsCount] = useState(0);
  const [insufficientModalVisible, setInsufficientModalVisible] = useState(false);
  const [insufficientCookiesRemaining, setInsufficientCookiesRemaining] = useState(0);

  const nutrientUnit = nutrientUnitForDisplay(healthMeasurement);
  const reviewUnitOptions = useMemo(() => getReviewUnitOptions(healthMeasurement), [healthMeasurement]);
  const sortedSavedRecipes = useMemo(() => sortRecipesForPicker(savedRecipes), [savedRecipes]);
  const filteredSavedRecipes = useMemo(() => {
    const normalizedQuery = recipeSearchQuery.trim().toLowerCase();
    return sortedSavedRecipes.filter((recipe) => {
      const matchesSearch = !normalizedQuery || String(recipe.title || "").toLowerCase().includes(normalizedQuery);
      const bucket = getRecipePickerCalorieBucket(recipe);
      return matchesSearch && (bucket || normalizeRecipeDifficulty(recipe.difficulty || ""));
    });
  }, [recipeSearchQuery, sortedSavedRecipes]);
  const visibleSavedRecipes = useMemo(
    () => filteredSavedRecipes.slice(0, recipeVisibleCount),
    [filteredSavedRecipes, recipeVisibleCount]
  );
  const visibleIngredients = useMemo(
    () => getVisibleIngredients(reviewIngredients, reviewShowAllIngredients),
    [reviewIngredients, reviewShowAllIngredients]
  );

  const resetReview = () => {
    setReviewMode(null);
    setReviewDraft(null);
    setReviewBase(null);
    setReviewIngredients([]);
    setReviewIngredientBase([]);
    setReviewShowAllIngredients(false);
    setNewIngredientName("");
    setNewIngredientQuantity("");
    setNewIngredientUnit("g");
    setUnitDropdownOpen(false);
    setNutritionMode("auto");
    setSelectedRecipe(null);
    photoReviewUriRef.current = null;
    setPhotoReviewUri(null);
  };

  const closeAll = () => {
    photoPickerInFlightRef.current = false;
    setPhotoPickerInFlight(false);
    setOptionsVisible(false);
    setTextLogVisible(false);
    setPhotoSourceVisible(false);
    setPhotoReviewLoading(false);
    setRecipeLogVisible(false);
    setMealInput("");
    resetReview();
    onClose();
  };

  const beginReviewSave = () => {
    if (reviewSaveInFlightRef.current) return false;
    reviewSaveInFlightRef.current = true;
    setReviewSaveInFlight(true);
    return true;
  };

  const endReviewSave = () => {
    reviewSaveInFlightRef.current = false;
    setReviewSaveInFlight(false);
  };

  const isNetworkLikeError = (error: unknown) => {
    const candidate = error as { code?: string; message?: string };
    const code = String(candidate?.code || "").toLowerCase();
    const message = String(candidate?.message || error || "").toLowerCase();
    return (
      code.includes("network") ||
      code.includes("timeout") ||
      message.includes("network request failed") ||
      message.includes("network") ||
      message.includes("internet") ||
      message.includes("offline") ||
      message.includes("timeout") ||
      message.includes("connection")
    );
  };

  const showConnectionRequiredAlert = () => {
    Alert.alert(
      t("common.error", "Error"),
      t("economy.connection_required", {
        defaultValue: "This action needs an internet connection. Please check your connection and try again.",
      })
    );
  };

  const ensureAuthUid = async (forceRefresh = false) => {
    try {
      if (auth.currentUser) {
        const token = await auth.currentUser.getIdToken(forceRefresh);
        return { authInfo: { uid: auth.currentUser.uid, token }, errorKind: null as "network" | "auth" | null };
      }
      const cred = await signInAnonymously(auth);
      const token = await cred.user.getIdToken(forceRefresh);
      return { authInfo: { uid: cred.user.uid, token }, errorKind: null as "network" | "auth" | null };
    } catch (e) {
      console.warn("[MyDayAddMealFlow] ensureAuthUid failed", e);
      return { authInfo: null, errorKind: isNetworkLikeError(e) ? "network" as const : "auth" as const };
    }
  };

  const openPremiumRecoveryPrompt = async (remaining: number | null | undefined) => {
    const rem = typeof remaining === "number" ? remaining : 0;
    if (!featuredOffer || availableRewardsCount === 0) {
      try {
        const catalog = await fetchEconomyCatalogBundle({
          backendUrl: API_BASE_URL,
          appEnv: process.env.EXPO_PUBLIC_APP_ENV ?? "local",
          auth,
        });
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
    setInsufficientCookiesRemaining(rem);
    setInsufficientModalVisible(true);
  };

  const requestPremiumAction = async (action: PremiumActionKey, mode: "preview" | "commit") => {
    try {
      if (!API_BASE_URL) return true;
      let deviceId: string | null = null;
      try {
        deviceId = await getDeviceId();
      } catch {
        deviceId = null;
      }

      const callPremiumAction = async (forceRefreshToken = false) => {
        const { authInfo, errorKind } = await ensureAuthUid(forceRefreshToken);
        if (!authInfo?.token) return { response: null, authFailed: true, authErrorKind: errorKind };
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authInfo.token}`,
        };
        if (deviceId) headers["x-device-id"] = deviceId;
        if (authInfo.uid) headers["x-user-id"] = authInfo.uid;
        const response = await fetch(`${API_BASE_URL}/economy/premium-action`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action, preview: mode === "preview" }),
        });
        return { response, authFailed: false, authErrorKind: null };
      };

      let { response, authFailed, authErrorKind } = await callPremiumAction(false);
      if (authFailed) ({ response, authFailed, authErrorKind } = await callPremiumAction(true));
      if (response?.status === 401 || response?.status === 403) {
        ({ response, authFailed, authErrorKind } = await callPremiumAction(true));
      }
      if (authFailed || !response) {
        if (authErrorKind === "network") {
          showConnectionRequiredAlert();
          return false;
        }
        Alert.alert(t("common.error", "Error"), t("economy.auth_required", "Please sign in again and try one more time."));
        return false;
      }
      if (response.status === 402) {
        const data = await response.json().catch(() => null);
        await openPremiumRecoveryPrompt(typeof data?.remaining === "number" ? data.remaining : data?.balance ?? null);
        return false;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        Alert.alert(t("common.error", "Error"), data?.message || data?.error || "We couldn't process this action right now.");
        return false;
      }
      const data = await response.json().catch(() => null);
      const remaining = typeof data?.remaining === "number" ? data.remaining : typeof data?.balance === "number" ? data.balance : null;
      if (typeof remaining === "number") await AsyncStorage.setItem("economy_cookie_balance", String(remaining));
      return true;
    } catch (error) {
      console.warn("[MyDayAddMealFlow] requestPremiumAction failed", error);
      if (isNetworkLikeError(error)) {
        showConnectionRequiredAlert();
        return false;
      }
      Alert.alert(t("common.error", "Error"), t("economy.try_again", "Couldn't verify your Egg balance. Please try again."));
      return false;
    }
  };

  const claimMealRewardsForCurrentCount = async () => {
    try {
      if (!API_BASE_URL) return;
      const meals = await loadMyDayMeals();
      const rewardKeys = getMealRewardKeysForCount(Array.isArray(meals) ? meals.length : 0);
      await claimRewardKeysSequentially(
        { backendUrl: API_BASE_URL, appEnv: process.env.EXPO_PUBLIC_APP_ENV ?? "local", auth },
        rewardKeys
      );
    } catch (err) {
      console.warn("[MyDayAddMealFlow] meal reward claim failed", err);
    }
  };

  function openTextLogger() {
    setMealInput("");
    resetReview();
    setOptionsVisible(false);
    setTextLogVisible(true);
  }

  async function openRecipeLogger() {
    resetReview();
    setRecipeSearchQuery("");
    setRecipeVisibleCount(RECIPE_PICKER_PAGE_SIZE);
    setOptionsVisible(false);
    setRecipeLogVisible(true);
    setRecipeLibraryLoading(true);
    try {
      setSavedRecipes(await loadSavedRecipes());
    } finally {
      setRecipeLibraryLoading(false);
    }
  }

  const openPhotoLogger = () => {
    setOptionsVisible(false);
    setPhotoSourceVisible(true);
  };

  useEffect(() => {
    if (!visible) return;
    void loadMeasurementSystemPreference().then(setHealthMeasurement);
    if (initialMode === "photo") {
      setPhotoSourceVisible(true);
    } else if (initialMode === "text") {
      openTextLogger();
    } else if (initialMode === "recipe") {
      void openRecipeLogger();
    } else {
      setOptionsVisible(true);
    }
    // Open/reset once when the parent starts this flow; the opener functions reset local modal state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialMode]);

  const analyzeMealPhoto = async (uri: string) => {
    const formData = new FormData();
    formData.append("language", i18n.language || "en");
    formData.append("image", { uri, name: "meal-photo.jpg", type: "image/jpeg" } as any);
    const response = await fetch(`${API_BASE_URL}/analyzeMealPhoto`, { method: "POST", body: formData, headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || t("my_day.photo_analyze_error_body", { defaultValue: "We couldn't analyze this meal photo right now." }));
    }
    return payload?.analysis as PhotoAnalysisResponse;
  };

  const pickMealPhotoFromSource = async (source: "camera" | "library") => {
    if (photoPickerInFlightRef.current) return;
    photoPickerInFlightRef.current = true;
    setPhotoPickerInFlight(true);
    try {
      console.log("[MyDayAddMealFlow] photo source selected", { source });
      setPhotoReviewLoading(false);
      resetReview();
      if (source === "library") {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          Alert.alert(
            t("my_day.photo_permission_title", { defaultValue: "Permission required" }),
            t("my_day.photo_permission_gallery_body", { defaultValue: "We need gallery access to choose a meal photo." })
          );
          closeAll();
          return;
        }
      } else {
        const currentPermission = await ImagePicker.getCameraPermissionsAsync();
        const permission = currentPermission.granted ? currentPermission : await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert(
            t("my_day.photo_permission_title", { defaultValue: "Permission required" }),
            t("my_day.photo_permission_camera_body", { defaultValue: "We need camera access to take a meal photo." })
          );
          setPhotoSourceVisible(true);
          return;
        }
      }

      const pickerOptions = {
        allowsEditing: false,
        quality: 0.8,
        mediaTypes: ["images"] as ImagePicker.MediaType[],
      };
      const result = source === "camera" ? await ImagePicker.launchCameraAsync(pickerOptions) : await ImagePicker.launchImageLibraryAsync(pickerOptions);
      console.log("[MyDayAddMealFlow] photo picker returned", {
        source,
        canceled: result.canceled,
        hasAsset: !!result.assets?.[0]?.uri,
      });
      if (result.canceled || !result.assets?.[0]?.uri) {
        setPhotoSourceVisible(true);
        return;
      }

      setPhotoSourceVisible(false);
      setPhotoReviewLoading(true);
      const allowed = await requestPremiumAction("meal_photo_log", "preview");
      if (!allowed) {
        setPhotoReviewLoading(false);
        setPhotoSourceVisible(true);
        return;
      }
      const compressedPhotoUri = await compressMealPhotoIfNeeded(result.assets[0].uri);
      const persistedPhotoUri = await persistMealPhotoPreview(compressedPhotoUri);
      const analysis = await analyzeMealPhoto(persistedPhotoUri);
      if (!analysis?.isFood || !Array.isArray(analysis.ingredients) || analysis.ingredients.length === 0) {
        Alert.alert(
          t("my_day.photo_not_food_title", { defaultValue: "This doesn’t look like a meal" }),
          t("my_day.photo_not_food_body", { defaultValue: "Try another photo with a clearer meal or plated food." })
        );
        setPhotoSourceVisible(true);
        return;
      }
      const safeIngredients = sanitizeReviewIngredients(analysis.ingredients);
      if (safeIngredients.length === 0) {
        Alert.alert(
          t("common.error_generic", { defaultValue: "Something went wrong" }),
          t("my_day.photo_identify_error_body", { defaultValue: "We couldn't identify the main ingredients in this meal photo." })
        );
        setPhotoSourceVisible(true);
        return;
      }
      const baseDraft = {
        title: analysis.title?.trim() || t("my_day.meal_fallback_title", { defaultValue: "Meal" }),
        calories: String(Math.max(0, Math.round(analysis.nutrition?.calories || 0))),
        protein: String(Math.max(0, Math.round(analysis.nutrition?.protein || 0))),
        carbs: String(Math.max(0, Math.round(analysis.nutrition?.carbs || 0))),
        fat: String(Math.max(0, Math.round(analysis.nutrition?.fat || 0))),
      };
      setReviewMode("photo");
      setReviewBase(baseDraft);
      setReviewDraft(baseDraft);
      setReviewIngredients(safeIngredients);
      setReviewIngredientBase(safeIngredients);
      photoReviewUriRef.current = persistedPhotoUri;
      setPhotoReviewUri(persistedPhotoUri);
    } catch (error: any) {
      console.warn("[MyDayAddMealFlow] meal photo analysis failed", error);
      Alert.alert(
        t("common.error_generic", { defaultValue: "Something went wrong" }),
        error?.message || t("my_day.photo_analyze_error_body", { defaultValue: "We couldn't analyze this meal photo right now." })
      );
      setPhotoSourceVisible(true);
    } finally {
      photoPickerInFlightRef.current = false;
      setPhotoPickerInFlight(false);
      setPhotoReviewLoading(false);
    }
  };

  const handleSaveTextMeal = async () => {
    const trimmed = mealInput.trim();
    if (!trimmed) return;
    setTextReviewLoading(true);
    try {
      const allowed = await requestPremiumAction("describe_meal", "preview");
      if (!allowed) return;
      const estimate = await resolveMealEstimate(trimmed, i18n.language);
      const baseDraft = {
        title: estimate.title,
        calories: String(estimate.calories),
        protein: String(estimate.protein),
        carbs: String(estimate.carbs),
        fat: String(estimate.fat),
      };
      setReviewMode("text");
      setReviewBase(baseDraft);
      setReviewDraft(baseDraft);
      setReviewIngredients(estimate.ingredients);
      setReviewIngredientBase(estimate.ingredients);
      setTextLogVisible(false);
    } finally {
      setTextReviewLoading(false);
    }
  };

  const handleSelectRecipe = async (recipe: SavedRecipe) => {
    try {
      setRecipeSelectionLoading(true);
      const savedNutrition = estimateRecipeNutrition(recipe);
      const shouldRefreshLoggingRepresentation = recipe.nutritionInfo
        ? needsRecipeMealLoggingRepresentationEnrichment(recipe.mealLoggingRepresentation)
        : !isRecipeMealLoggingRepresentationUsable(recipe.mealLoggingRepresentation);
      const resolved = recipe.nutritionInfo
        ? shouldRefreshLoggingRepresentation
          ? await resolveRecipeNutritionEstimate(recipe, i18n.language, { forceRepresentationRefresh: true })
          : {
              nutrition: savedNutrition,
              ingredients: recipe.mealLoggingRepresentation?.ingredients ?? [],
              mealLoggingRepresentation: recipe.mealLoggingRepresentation!,
              usedAiFallback: false,
            }
        : await resolveRecipeNutritionEstimate(recipe, i18n.language);
      const mealLoggingRepresentation = shouldRefreshLoggingRepresentation
        ? resolved.mealLoggingRepresentation ?? buildRecipeMealLoggingRepresentation(recipe, 8)
        : recipe.mealLoggingRepresentation;
      if (!recipe.nutritionInfo || shouldRefreshLoggingRepresentation) {
        await persistRecipeNutritionEstimate(
          recipe.id,
          recipe.nutritionInfo ? savedNutrition : resolved.nutrition,
          mealLoggingRepresentation
        );
      }
      const nutrition = recipe.nutritionInfo ? savedNutrition : resolved.nutrition;
      const baseDraft = {
        title: recipe.title,
        calories: String(nutrition.caloriesPerServing),
        protein: String(nutrition.proteinPerServing),
        carbs: String(nutrition.carbsPerServing),
        fat: String(nutrition.fatPerServing),
      };
      const ingredients =
        (mealLoggingRepresentation?.ingredients || resolved.ingredients).length > 0
          ? (mealLoggingRepresentation?.ingredients || resolved.ingredients).slice(0, 8).map((item) => ({
              name: item.name,
              quantity: String(item.quantity || "1"),
              unit: String(item.unit || "serving"),
            }))
          : (recipe.ingredients && recipe.ingredients.length > 0 ? recipe.ingredients : [recipe.title])
              .slice(0, 8)
              .map((name) => parseRecipeIngredientLine(name));
      setSelectedRecipe(recipe);
      setReviewMode("recipe");
      setReviewBase(baseDraft);
      setReviewDraft(baseDraft);
      setReviewIngredients(ingredients);
      setReviewIngredientBase(ingredients);
    } catch (error) {
      console.warn("[MyDayAddMealFlow] Failed to prepare recipe meal", error);
      Alert.alert(
        t("common.error_generic", { defaultValue: "Something went wrong" }),
        t("my_day.recipe_prepare_error_body", { defaultValue: "We couldn't prepare this recipe right now." })
      );
      setSelectedRecipe(null);
    } finally {
      setRecipeSelectionLoading(false);
    }
  };

  const finishSaved = async () => {
    await onSaved();
    closeAll();
  };

  const handleConfirmReview = async () => {
    if (!reviewDraft || !reviewMode) return;
    const safeIngredients = sanitizeReviewIngredients(reviewIngredients);
    if (safeIngredients.length === 0) return;
    if (!beginReviewSave()) return;
    try {
      const ingredientsChanged = !areReviewIngredientsEqual(safeIngredients, reviewIngredientBase);
      const refreshedEstimate = ingredientsChanged
        ? await resolveStructuredMealEstimate(
            safeIngredients.map((item) => `${item.quantity} ${item.unit} ${item.name}`.trim()).join(", "),
            safeIngredients as MyDayMealIngredient[],
            safeIngredients.map((item) => item.name),
            i18n.language
          )
        : null;

      if (reviewMode === "text") {
        const saved = await addTextMeal(mealInput.trim() || reviewDraft.title, targetMealDate);
        const syncedMeal = {
          ...saved,
          title: reviewDraft.title.trim() || saved.title,
          calories: refreshedEstimate ? refreshedEstimate.calories : parseNumber(reviewDraft.calories, saved.calories),
          protein: refreshedEstimate ? refreshedEstimate.protein : parseNumber(reviewDraft.protein, saved.protein),
          carbs: refreshedEstimate ? refreshedEstimate.carbs : parseNumber(reviewDraft.carbs, saved.carbs),
          fat: refreshedEstimate ? refreshedEstimate.fat : parseNumber(reviewDraft.fat, saved.fat),
          ingredients: safeIngredients as MyDayMealIngredient[],
        };
        await updateMeal(saved.id, syncedMeal);
        const committed = await requestPremiumAction("describe_meal", "commit");
        if (!committed) {
          await removeMeal(saved.id);
          await (syncEngine as any)?.markMyDayMealDeleted?.(saved.id);
          return;
        }
        await (syncEngine as any)?.markMyDayMealDirty?.(syncedMeal);
      } else if (reviewMode === "photo") {
        const saved = await addPhotoMeal(
          {
            title: reviewDraft.title.trim() || "Meal",
            calories: refreshedEstimate ? refreshedEstimate.calories : parseNumber(reviewDraft.calories, 0),
            protein: refreshedEstimate ? refreshedEstimate.protein : parseNumber(reviewDraft.protein, 0),
            carbs: refreshedEstimate ? refreshedEstimate.carbs : parseNumber(reviewDraft.carbs, 0),
            fat: refreshedEstimate ? refreshedEstimate.fat : parseNumber(reviewDraft.fat, 0),
            photoUri: photoReviewUriRef.current ?? photoReviewUri ?? undefined,
            ingredients: safeIngredients as MyDayMealIngredient[],
          },
          targetMealDate
        );
        const committed = await requestPremiumAction("meal_photo_log", "commit");
        if (!committed) {
          await removeMeal(saved.id);
          await (syncEngine as any)?.markMyDayMealDeleted?.(saved.id);
          return;
        }
        await (syncEngine as any)?.markMyDayMealDirty?.(saved);
      } else if (selectedRecipe) {
        const perServingNutrition = {
          caloriesPerServing: Math.round(refreshedEstimate ? refreshedEstimate.calories : parseNumber(reviewDraft.calories, 0)),
          proteinPerServing: Math.round(refreshedEstimate ? refreshedEstimate.protein : parseNumber(reviewDraft.protein, 0)),
          carbsPerServing: Math.round(refreshedEstimate ? refreshedEstimate.carbs : parseNumber(reviewDraft.carbs, 0)),
          fatPerServing: Math.round(refreshedEstimate ? refreshedEstimate.fat : parseNumber(reviewDraft.fat, 0)),
          servings: selectedRecipe.servings && selectedRecipe.servings > 0 ? selectedRecipe.servings : 1,
        };
        const savedMeal = await logRecipeMeal(
          {
            ...selectedRecipe,
            title: reviewDraft.title,
            nutrition: perServingNutrition,
            ingredients: safeIngredients.map((item) => `${item.quantity}${item.unit ? ` ${item.unit}` : ""} ${item.name}`.trim()),
          },
          1,
          {
            nutritionOverride: perServingNutrition,
            ingredientsOverride: safeIngredients.map((item) => ({ ...item })),
            persistRecipeEstimate: !ingredientsChanged,
            date: targetMealDate,
          }
        );
        await (syncEngine as any)?.markMyDayMealDirty?.(savedMeal);
      }
      await claimMealRewardsForCurrentCount();
      await finishSaved();
    } finally {
      endReviewSave();
    }
  };

  const updateIngredientDisplayQuantity = (index: number, value: string) => {
    const existing = reviewIngredients[index];
    if (!existing) return;
    const next = [...reviewIngredients];
    next[index] = {
      ...existing,
      quantity: sanitizePositiveDecimalInput(quantityFromDisplay(value, existing.unit, healthMeasurement)),
    };
    setReviewIngredients(next);
    if (reviewBase && nutritionMode === "auto") setReviewDraft(recomputeTotals(reviewBase, reviewIngredientBase, next));
  };

  const removeIngredient = (index: number) => {
    const next = reviewIngredients.filter((_, candidateIndex) => candidateIndex !== index);
    setReviewIngredients(next);
    if (reviewBase && nutritionMode === "auto") setReviewDraft(recomputeTotals(reviewBase, reviewIngredientBase, next));
  };

  const addIngredient = () => {
    const ingredient = normalizeNewReviewIngredient(newIngredientName, newIngredientQuantity, newIngredientUnit);
    if (!ingredient) return;
    const next = [...reviewIngredients, ingredient];
    setReviewIngredients(next);
    if (reviewBase && nutritionMode === "auto") setReviewDraft(recomputeTotals(reviewBase, reviewIngredientBase, next));
    setNewIngredientName("");
    setNewIngredientQuantity("");
    setUnitDropdownOpen(false);
  };

  const reviewVisible = !!reviewMode && !!reviewDraft;

  return (
    <>
      <Modal visible={visible && optionsVisible} transparent animationType="fade" onRequestClose={closeAll}>
        <Pressable style={[styles.modalOverlay, { backgroundColor: modalBackdrop }]} onPress={closeAll}>
          <View style={[styles.optionSheet, { backgroundColor: card, borderColor: border }]} onStartShouldSetResponder={() => true}>
            {[
              { key: "log_photo", icon: "photo-camera", action: openPhotoLogger },
              { key: "describe_meal", icon: "chat-bubble-outline", action: openTextLogger },
              { key: "from_recipe", icon: "menu-book", action: () => void openRecipeLogger() },
            ].map((option) => (
              <TouchableOpacity key={option.key} activeOpacity={0.85} style={[styles.optionRow, { borderBottomColor: border }]} onPress={option.action}>
                <MaterialIcons name={option.icon as any} size={20} color={actionTone} />
                <Text style={[styles.optionLabel, { color: actionTone }]}>{t(`my_day.${option.key}`)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>

      <Modal visible={visible && textLogVisible} transparent animationType="slide" onRequestClose={closeAll}>
        <Pressable style={[styles.modalOverlay, { backgroundColor: modalBackdrop }]} onPress={closeAll}>
          <View style={[styles.modalCard, { backgroundColor: card, borderColor: border }]} onStartShouldSetResponder={() => true}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: text }]}>{t("my_day.describe_meal", { defaultValue: "Describe meal" })}</Text>
              <TouchableOpacity activeOpacity={0.8} onPress={closeAll}>
                <MaterialIcons name="close" size={22} color={subText} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.modalHelp, { color: subText }]}>
              {t("my_day.describe_help", { defaultValue: "Example: 50g of bread, 1 yogurt with berries, 2 eggs, chicken rice bowl." })}
            </Text>
            <TextInput
              value={mealInput}
              onChangeText={setMealInput}
              placeholder={t("my_day.describe_placeholder", { defaultValue: "Type what you ate" })}
              placeholderTextColor={subText}
              multiline
              autoFocus
              style={[styles.modalInput, { color: text, borderColor: border, backgroundColor: bg }]}
            />
            {textReviewLoading ? (
              <Text style={[styles.modalHelp, styles.loadingHelperText, { color: subText }]}>
                {t("my_day.describe_loading_help", {
                  defaultValue: "We’re checking your ingredients. If some aren’t in our nutrition catalog yet, we’ll use AI to estimate them for you.",
                })}
              </Text>
            ) : null}
            <View style={styles.modalActions}>
              <TouchableOpacity activeOpacity={0.85} style={[styles.secondaryButton, { borderColor: border, backgroundColor: bg }]} onPress={closeAll}>
                <Text style={[styles.secondaryButtonText, { color: text }]}>{t("common.cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={textReviewLoading}
                style={[styles.primaryButton, { backgroundColor: cta, opacity: textReviewLoading ? 0.7 : 1 }]}
                onPress={handleSaveTextMeal}
              >
                {textReviewLoading ? (
                  <View style={styles.loadingButtonContent}>
                    <ActivityIndicator size="small" color="#fff" />
                    <Text style={styles.primaryButtonText}>{t("my_day.describe_loading_cta", { defaultValue: "Checking ingredients" })}</Text>
                  </View>
                ) : (
                  <Text style={styles.primaryButtonText}>{t("common.next", { defaultValue: "Next" })}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={visible && photoSourceVisible} transparent animationType="fade" onRequestClose={closeAll}>
        <Pressable style={[styles.modalOverlay, { backgroundColor: modalBackdrop }]} onPress={closeAll}>
          <View style={[styles.photoSourceCard, { backgroundColor: card, borderColor: border }]} onStartShouldSetResponder={() => true}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: text }]}>{t("my_day.log_photo", { defaultValue: "Log with photo" })}</Text>
              <TouchableOpacity activeOpacity={0.8} onPress={closeAll}>
                <MaterialIcons name="close" size={22} color={subText} />
              </TouchableOpacity>
            </View>
            <View style={styles.photoSourceActions}>
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={photoPickerInFlight}
                style={[styles.photoSourceButton, { borderColor: border, backgroundColor: bg, opacity: photoPickerInFlight ? 0.65 : 1 }]}
                onPress={() => void pickMealPhotoFromSource("library")}
              >
                <MaterialIcons name="photo-library" size={18} color={actionTone} />
                <Text style={[styles.photoSourceButtonText, { color: text }]}>{t("my_day.choose_photo", { defaultValue: "Choose from library" })}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={photoPickerInFlight}
                style={[styles.photoSourceButton, { borderColor: border, backgroundColor: bg, opacity: photoPickerInFlight ? 0.65 : 1 }]}
                onPress={() => void pickMealPhotoFromSource("camera")}
              >
                <MaterialIcons name="photo-camera" size={18} color={actionTone} />
                <Text style={[styles.photoSourceButtonText, { color: text }]}>{t("my_day.take_photo", { defaultValue: "Take photo" })}</Text>
              </TouchableOpacity>
            </View>
            {shouldHidePremiumPricing(freePremiumActionsRemaining) ? null : (
              <Text style={[styles.modalCostHint, styles.photoSourceCostHint, { color: subText }]}>
                {t("economy.log_photo_cost_hint", {
                  defaultValue: "If we’re able to successfully add a meal, this uses 1 Egg. You currently have {{count}} Eggs.",
                  count: cookieBalance ?? 0,
                })}
              </Text>
            )}
          </View>
        </Pressable>
      </Modal>

      <Modal visible={visible && photoReviewLoading} transparent animationType="fade" onRequestClose={() => setPhotoReviewLoading(false)}>
        <Pressable style={[styles.modalOverlay, { backgroundColor: modalBackdrop }]}>
          <View style={[styles.modalCard, { backgroundColor: card, borderColor: border }]} onStartShouldSetResponder={() => true}>
            <View style={styles.recipeListLoading}>
              <ActivityIndicator size="small" color={cta} />
              <Text style={[styles.modalHelp, { color: subText, marginTop: 12, textAlign: "center" }]}>
                {t("my_day.photo_review_loading", {
                  defaultValue: "We’re checking if this is a food photo and identifying the main ingredients.",
                })}
              </Text>
            </View>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={visible && recipeLogVisible && !reviewVisible} transparent animationType="slide" onRequestClose={closeAll}>
        <Pressable style={[styles.modalOverlay, { backgroundColor: modalBackdrop }]} onPress={closeAll}>
          <View style={[styles.modalCard, { backgroundColor: card, borderColor: border }]} onStartShouldSetResponder={() => true}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: text }]}>{t("my_day.from_recipe", { defaultValue: "From recipe" })}</Text>
              <TouchableOpacity activeOpacity={0.8} onPress={closeAll}>
                <MaterialIcons name="close" size={22} color={subText} />
              </TouchableOpacity>
            </View>
            {!recipeLibraryLoading && savedRecipes.length === 0 ? (
              <View style={[styles.emptyState, { backgroundColor: `${secondary}15` }]}>
                <Text style={[styles.emptyTitle, { color: text }]}>{t("my_day.no_recipes_title", { defaultValue: "No saved recipes yet" })}</Text>
                <Text style={[styles.emptyBody, { color: subText }]}>
                  {t("my_day.no_recipes_body", { defaultValue: "Save recipes in My Recipes first, then you can log them into My Day." })}
                </Text>
              </View>
            ) : (
              <>
                <Text style={[styles.modalHelp, { color: subText }]}>
                  {t("my_day.recipe_help", { defaultValue: "Choose a saved recipe to review quantities and nutrition before saving." })}
                </Text>
                <TextInput
                  value={recipeSearchQuery}
                  onChangeText={(value) => {
                    setRecipeSearchQuery(value);
                    setRecipeVisibleCount(RECIPE_PICKER_PAGE_SIZE);
                  }}
                  placeholder={t("my_day.search_recipes", { defaultValue: "Search recipes" })}
                  placeholderTextColor={subText}
                  style={[styles.recipeSearchInput, { color: text, borderColor: border, backgroundColor: bg }]}
                />
                {recipeLibraryLoading || recipeSelectionLoading ? (
                  <View style={styles.recipeListLoading}>
                    <ActivityIndicator size="small" color={cta} />
                    <Text style={[styles.modalHelp, { color: subText, marginTop: 10, textAlign: "center" }]}>
                      {recipeLibraryLoading
                        ? t("my_day.recipe_library_loading", { defaultValue: "Loading your recipes" })
                        : t("my_day.recipe_loading_review", { defaultValue: "Preparing this recipe for review" })}
                    </Text>
                  </View>
                ) : filteredSavedRecipes.length === 0 ? (
                  <View style={[styles.emptyState, { backgroundColor: `${secondary}15` }]}>
                    <Text style={[styles.emptyTitle, { color: text }]}>{t("my_day.no_recipe_matches_title", { defaultValue: "No matching recipes" })}</Text>
                    <Text style={[styles.emptyBody, { color: subText }]}>
                      {t("my_day.no_recipe_matches_body", { defaultValue: "Try another title or clear your search and filters." })}
                    </Text>
                  </View>
                ) : (
                  <FlatList
                    data={visibleSavedRecipes}
                    keyExtractor={(recipe) => recipe.id}
                    style={styles.recipeList}
                    contentContainerStyle={{ paddingBottom: 8 }}
                    keyboardShouldPersistTaps="handled"
                    onEndReachedThreshold={0.35}
                    onEndReached={() => {
                      if (recipeVisibleCount < filteredSavedRecipes.length) {
                        setRecipeVisibleCount((prev) => Math.min(prev + RECIPE_PICKER_PAGE_SIZE, filteredSavedRecipes.length));
                      }
                    }}
                    renderItem={({ item: recipe }) => {
                      const estimate = estimateRecipeNutrition(recipe);
                      const hasSavedNutrition = Boolean(recipe.nutritionInfo);
                      return (
                        <TouchableOpacity activeOpacity={0.85} style={[styles.recipeRow, { borderColor: border }]} onPress={() => void handleSelectRecipe(recipe)}>
                          <View style={styles.recipeRowContent}>
                            <Text style={[styles.recipeTitle, { color: text }]} numberOfLines={2}>{recipe.title}</Text>
                            {hasSavedNutrition ? (
                              <View style={styles.recipeMacroRow}>
                                <View style={styles.recipeMacroSimple}>
                                  <MaterialIcons name="local-fire-department" size={13} color={cta} style={styles.mealMacroIcon} />
                                  <Text style={[styles.mealMacroSimpleLabel, { color: subText }]}>Kcal</Text>
                                  <Text style={[styles.mealMacroSimpleValue, { color: text }]}>
                                    {Math.round(estimate.caloriesPerServing)}
                                  </Text>
                                </View>
                                <View style={styles.recipeMacroSimple}>
                                  <Text style={[styles.mealMacroSimpleLabel, { color: subText }]}>
                                    {t("my_day.protein")}
                                  </Text>
                                  <Text style={[styles.mealMacroSimpleValue, { color: text }]}>
                                    {nutrientValueForDisplay(estimate.proteinPerServing, healthMeasurement)}
                                    <Text style={[styles.mealMacroSimpleUnit, { color: subText }]}> {nutrientUnit}</Text>
                                  </Text>
                                </View>
                                <View style={styles.recipeMacroSimple}>
                                  <Text style={[styles.mealMacroSimpleLabel, { color: subText }]}>
                                    {t("my_day.carbs")}
                                  </Text>
                                  <Text style={[styles.mealMacroSimpleValue, { color: text }]}>
                                    {nutrientValueForDisplay(estimate.carbsPerServing, healthMeasurement)}
                                    <Text style={[styles.mealMacroSimpleUnit, { color: subText }]}> {nutrientUnit}</Text>
                                  </Text>
                                </View>
                                <View style={styles.recipeMacroSimple}>
                                  <Text style={[styles.mealMacroSimpleLabel, { color: subText }]}>
                                    {t("my_day.fat")}
                                  </Text>
                                  <Text style={[styles.mealMacroSimpleValue, { color: text }]}>
                                    {nutrientValueForDisplay(estimate.fatPerServing, healthMeasurement)}
                                    <Text style={[styles.mealMacroSimpleUnit, { color: subText }]}> {nutrientUnit}</Text>
                                  </Text>
                                </View>
                              </View>
                            ) : (
                              <Text style={[styles.recipeMeta, { color: subText }]}>
                                {t("my_day.recipe_needs_estimate_clear", { defaultValue: "Nutrients will be calculated after selection" })}
                              </Text>
                            )}
                          </View>
                          <MaterialIcons name="chevron-right" size={20} color={subText} />
                        </TouchableOpacity>
                      );
                    }}
                  />
                )}
              </>
            )}
          </View>
        </Pressable>
      </Modal>

      <MyDayMealEditorModal
        visible={visible && reviewVisible}
        onClose={closeAll}
        modalBackdrop={modalBackdrop}
        card={card}
        border={border}
        bg={bg}
        text={text}
        subText={subText}
        cta={cta}
        headingLabel={t("my_day.review_before_save", { defaultValue: "Review before saving" })}
        titleLabel={t("recipes.title", { defaultValue: "Title" })}
        titleValue={reviewDraft?.title ?? ""}
        onChangeTitle={(value) => setReviewDraft((prev) => (prev ? { ...prev, title: value } : prev))}
        mealDetailsStepLabel={t("my_day.meal_details", { defaultValue: "Meal details" })}
        nutritionStepLabel={t("my_day.meal_nutrition", { defaultValue: "Meal nutrition" })}
        quantitiesLabel={t("my_day.quantities", { defaultValue: "Quantities" })}
        visibleIngredients={visibleIngredients.map(({ item, index }) => ({
          index,
          key: `${item.name}-${index}`,
          name: item.name,
          quantity: quantityForDisplay(item.quantity, item.unit, healthMeasurement),
          unitLabel: normalizeReviewUnitLabel(unitForDisplay(item.unit, healthMeasurement)),
        }))}
        allIngredientsCount={reviewIngredients.length}
        onChangeIngredientQuantity={updateIngredientDisplayQuantity}
        onRemoveIngredient={removeIngredient}
        emptyIngredientsText={t("my_day.review_need_ingredient", { defaultValue: "Add at least one ingredient before saving." })}
        showAllIngredients={reviewShowAllIngredients}
        showIngredientsToggle={reviewIngredients.length > REVIEW_DEFAULT_VISIBLE_COUNT}
        onToggleShowAllIngredients={() => setReviewShowAllIngredients((prev) => !prev)}
        showAllIngredientsText={t("my_day.review_show_all", { defaultValue: "Show all {{count}} ingredients", count: reviewIngredients.length })}
        showFewerIngredientsText={t("my_day.review_show_less", { defaultValue: "Show fewer ingredients" })}
        addIngredientPlaceholder={t("my_day.add_ingredient", { defaultValue: "Add ingredient" })}
        newIngredientName={newIngredientName}
        onChangeNewIngredientName={(value) => setNewIngredientName(sanitizeIngredientNameInput(value))}
        newIngredientQuantity={newIngredientQuantity}
        onChangeNewIngredientQuantity={(value) => setNewIngredientQuantity(sanitizePositiveDecimalInput(value))}
        newIngredientUnitLabel={normalizeReviewUnitLabel(unitForDisplay(newIngredientUnit, healthMeasurement))}
        unitDropdownOpen={unitDropdownOpen}
        onToggleUnitDropdown={() => setUnitDropdownOpen((prev) => !prev)}
        unitOptions={reviewUnitOptions}
        selectedUnitValue={newIngredientUnit}
        onSelectUnit={(value) => {
          setNewIngredientUnit(value);
          setUnitDropdownOpen(false);
        }}
        onAddIngredient={addIngredient}
        nutritionLabel={t("my_day.meal_nutrition", { defaultValue: "Meal nutrition" })}
        nutritionHintAuto={t("my_day.meal_nutrition_hint_auto", {
          defaultValue: "Nutrition is being calculated automatically from the ingredient list.",
        })}
        nutritionHintManual={t("my_day.meal_nutrition_hint_manual", {
          defaultValue: "Manual mode lets you override the nutrition values for this meal.",
        })}
        nutritionMode={nutritionMode}
        onChangeNutritionMode={(mode) => {
          setNutritionMode(mode);
          if (mode === "auto" && reviewBase) setReviewDraft(recomputeTotals(reviewBase, reviewIngredientBase, reviewIngredients));
        }}
        nutritionFields={[
          {
            key: "calories",
            label: t("profile.health_calories", { defaultValue: "Calories" }),
            value: reviewDraft ? `${Math.round(parseNumber(reviewDraft.calories, 0))}` : "0",
            unit: "kcal",
            onChange: (value) => setReviewDraft((prev) => (prev ? { ...prev, calories: sanitizePositiveDecimalInput(value) } : prev)),
          },
          {
            key: "protein",
            label: t("my_day.protein"),
            value: reviewDraft ? (nutritionMode === "manual" ? reviewDraft.protein : `${nutrientValueForDisplay(parseNumber(reviewDraft.protein, 0), healthMeasurement)}`) : "0",
            unit: nutrientUnit,
            onChange: (value) => setReviewDraft((prev) => (prev ? { ...prev, protein: sanitizePositiveDecimalInput(value) } : prev)),
          },
          {
            key: "carbs",
            label: t("my_day.carbs"),
            value: reviewDraft ? (nutritionMode === "manual" ? reviewDraft.carbs : `${nutrientValueForDisplay(parseNumber(reviewDraft.carbs, 0), healthMeasurement)}`) : "0",
            unit: nutrientUnit,
            onChange: (value) => setReviewDraft((prev) => (prev ? { ...prev, carbs: sanitizePositiveDecimalInput(value) } : prev)),
          },
          {
            key: "fat",
            label: t("my_day.fat"),
            value: reviewDraft ? (nutritionMode === "manual" ? reviewDraft.fat : `${nutrientValueForDisplay(parseNumber(reviewDraft.fat, 0), healthMeasurement)}`) : "0",
            unit: nutrientUnit,
            onChange: (value) => setReviewDraft((prev) => (prev ? { ...prev, fat: sanitizePositiveDecimalInput(value) } : prev)),
          },
        ]}
        autoLabel={t("profile.health_plan_auto", { defaultValue: "Automatic" })}
        manualLabel={t("profile.health_plan_manual", { defaultValue: "Manual" })}
        cancelLabel={t("common.cancel")}
        backLabel={t("common.back", { defaultValue: "Back" })}
        nextLabel={t("common.next", { defaultValue: "Next" })}
        saveLabel={reviewSaveInFlight ? t("common.saving", { defaultValue: "Saving..." }) : t("common.save")}
        onSave={handleConfirmReview}
        saveDisabled={reviewIngredients.length === 0 || reviewSaveInFlight}
      />

      <InsufficientCookiesModal
        visible={insufficientModalVisible}
        isDark={isDark}
        title={t("economy.insufficient_title", "Not enough Eggs")}
        body={`You need 1 Egg to log a meal. Currently, you have ${insufficientCookiesRemaining} Eggs.`}
        featuredOffer={featuredOffer}
        availableRewardsCount={availableRewardsCount}
        onClose={() => setInsufficientModalVisible(false)}
        onBuyOffer={() => {
          setInsufficientModalVisible(false);
          router.push({ pathname: "/economy/store", params: { highlight: "cookies_15", autoBuy: "1" } } as any);
        }}
        onOpenStore={() => {
          setInsufficientModalVisible(false);
          router.push({ pathname: "/economy/store", params: { highlight: "cookies_15" } } as any);
        }}
        onOpenRewards={() => {
          setInsufficientModalVisible(false);
          router.push("/economy/store" as any);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  modalCard: {
    width: "92%",
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    maxHeight: "88%",
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "800",
  },
  modalHelp: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
  },
  modalCostHint: {
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
  },
  photoSourceCostHint: {
    marginTop: 14,
  },
  loadingHelperText: {
    marginTop: 10,
  },
  modalInput: {
    minHeight: 100,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    textAlignVertical: "top",
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 14,
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: "700",
  },
  primaryButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  loadingButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  optionSheet: {
    width: "90%",
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: "600",
  },
  photoSourceCard: {
    width: "88%",
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
  },
  photoSourceActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  photoSourceButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  photoSourceButtonText: {
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
  },
  recipeSearchInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 10,
  },
  recipeList: {
    maxHeight: 420,
  },
  recipeListLoading: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 18,
  },
  recipeRow: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  recipeRowContent: {
    flex: 1,
  },
  recipeTitle: {
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 4,
  },
  recipeMeta: {
    fontSize: 12,
    lineHeight: 16,
  },
  recipeMacroRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  recipeMacroSimple: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  mealMacroIcon: {
    marginRight: -1,
    marginTop: 1,
  },
  mealMacroSimpleLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  mealMacroSimpleValue: {
    fontSize: 12,
    fontWeight: "700",
  },
  mealMacroSimpleUnit: {
    fontSize: 11,
    fontWeight: "600",
  },
  emptyState: {
    borderRadius: 12,
    padding: 12,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 6,
  },
  emptyBody: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 2,
  },
});
