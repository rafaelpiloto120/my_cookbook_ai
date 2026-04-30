import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { Canvas, Path as SkiaPath, Skia } from "@shopify/react-native-skia";

import AppCard from "../../components/AppCard";
import HealthGoalsEditorModal from "../../components/HealthGoalsEditorModal";
import MyDayAddMealFlow from "../../components/MyDayAddMealFlow";
import MyDayMealEditorModal from "../../components/MyDayMealEditorModal";
import { useAuth } from "../../context/AuthContext";
import { useThemeColors } from "../../context/ThemeContext";
import { auth } from "../../firebaseConfig";
import {
  deriveSuggestedPlan,
  formatWeightFromKg,
  hasMyDaySetup,
  loadMyDayProfile,
  loadMeasurementSystemPreference,
  MeasurementSystem as MyDayMeasurementSystem,
  MyDayPlan,
  MyDayProfile,
  parseHeightToCm,
  parseWeightToKg,
  saveMyDayProfile,
} from "../../lib/myDay";
import {
  addWeightLog,
  getWeightDayKey,
  latestWeightLog,
  loadWeightLogs,
  MyDayWeightLog,
} from "../../lib/myDayWeight";
import {
  getDayKey,
  getMealsForDay,
  loadMyDayMeals,
  MyDayMeal,
  MyDayMealIngredient,
  removeMeal,
  resolveStructuredMealEstimate,
  splitMealTextIntoIngredients,
  updateMeal,
} from "../../lib/myDayMeals";
import {
  loadSavedRecipes,
  SavedRecipe,
} from "../../lib/myDayRecipes";
import { getApiBaseUrl } from "../../lib/config/api";
import {
  claimEconomyReward,
  fetchEconomySnapshot,
} from "../../lib/economy/client";
import { useSyncEngine } from "../../lib/sync/SyncEngine";

type MacroKey = "protein" | "carbs" | "fat";
type MacroRow = {
  key: MacroKey;
  consumed: number;
  target: number;
  color: string;
};

type TodayInsight = {
  key: string;
  text: string;
  icon: string;
  tone: "positive" | "caution" | "warning" | "neutral";
};

type WeekTrendEntry = {
  key: string;
  value: number;
  label: string;
  status: "logged" | "missed" | "future" | "today-empty";
};

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

type ReviewUnitOption = {
  value: string;
  label: string;
};

const REVIEW_DEFAULT_VISIBLE_COUNT = 6;
const LOW_IMPACT_REVIEW_INGREDIENT_PATTERNS = [
  /\bgarlic\b/i,
  /\balho\b/i,
  /\bclove\b/i,
  /\bcloves\b/i,
  /\bcravinho\b/i,
  /\bcravinhos\b/i,
  /\bshallot\b/i,
  /\bchalota\b/i,
  /\bparsley\b/i,
  /\bsalsa\b/i,
  /\bcilantro\b/i,
  /\bcoentros?\b/i,
  /\bmint\b/i,
  /\bhortel[aã]\b/i,
  /\bmenthe\b/i,
  /\bminze\b/i,
  /\bbasil\b/i,
  /\bmanjeric[aã]o\b/i,
  /\boregano\b/i,
  /\bor[eé]g[aã]os?\b/i,
  /\bthyme\b/i,
  /\btomilho\b/i,
  /\brosemary\b/i,
  /\balecrim\b/i,
  /\bchives?\b/i,
  /\bcebolinho\b/i,
  /\bpaprika\b/i,
  /\bcumin\b/i,
  /\bcominhos?\b/i,
  /\bcinnamon\b/i,
  /\bcanela\b/i,
  /\bnutmeg\b/i,
  /\bnoz-moscada\b/i,
  /\bpepper\b/i,
  /\bpimenta\b/i,
  /\bsalt\b/i,
  /\bsal\b/i,
  /\bbay leaf\b/i,
  /\blouro\b/i,
  /\bfolha de louro\b/i,
  /\bdente de alho\b/i,
  /\bknoblauch\b/i,
  /\bguindilla\b/i,
  /\bchili\b/i,
  /\bpiri-?piri\b/i,
  /\blemon zest\b/i,
  /\braspa de lim[aã]o\b/i,
];

const GRAMS_PER_OUNCE = 28.349523125;
const ML_PER_FLUID_OUNCE = 29.5735295625;
const POUNDS_PER_KILOGRAM = 2.2046226218;
const FLUID_OUNCES_PER_LITER = 33.8140227018;
const API_BASE_URL = getApiBaseUrl() || "http://10.0.2.2:3000";

function clampPercent(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function hexToRgba(color: string, alpha: number) {
  if (!color.startsWith("#")) return color;
  const normalized = color.slice(1);
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized.slice(0, 6);

  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);

  if ([r, g, b].some((value) => Number.isNaN(value))) return color;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function MiniBars({
  entries,
  tint,
  goal,
  goalColor,
  missedGoalColor,
  futureGoalColor,
  labelColor,
}: {
  entries: WeekTrendEntry[];
  tint: string;
  goal: number;
  goalColor: string;
  missedGoalColor: string;
  futureGoalColor: string;
  labelColor: string;
}) {
  const maxValue = Math.max(...entries.map((entry) => entry.value), 1);
  const hasGoal = goal > 0;
  const chartMax = Math.max(maxValue, goal, 1);
  const goalHeight = hasGoal ? (goal / chartMax) * 100 : 0;

  return (
    <View style={styles.trendBars}>
      {entries.map((entry) => {
        const actualHeight = hasGoal ? (entry.value / chartMax) * 100 : 0;
        const entryGoalColor =
          entry.status === "future"
            ? futureGoalColor
            : entry.status === "missed"
              ? missedGoalColor
              : goalColor;

        return (
          <View key={entry.key} style={styles.trendBarColumn}>
            <View style={styles.trendBarTrack}>
              <View
                style={[
                  styles.trendGoalBar,
                  {
                    backgroundColor: entryGoalColor,
                    height: `${goalHeight}%`,
                    opacity: entry.status === "future" ? 0.55 : 1,
                  },
                ]}
              />
              {entry.value > 0 ? (
                <View
                  style={[
                    styles.trendBarFill,
                    {
                      backgroundColor: tint,
                      height: `${Math.max(actualHeight, 8)}%`,
                    },
                  ]}
                />
              ) : entry.status === "missed" ? (
                <Text style={[styles.trendBarStatusDash, { color: labelColor }]}>—</Text>
              ) : null}
            </View>
            <Text style={[styles.trendBarLabel, { color: labelColor }]}>{entry.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

function getMondayWeekStart(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  return start;
}

function formatWeekTrendLabel(date: Date, locale: string) {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" })
    .format(date)
    .replace(".", "")
    .slice(0, 3);
  const day = new Intl.DateTimeFormat(locale, { day: "numeric" }).format(date);
  const normalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${normalizedWeekday}, ${day}`;
}

function parseNumber(value: string, fallback = 0) {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDisplayQuantity(value: number) {
  if (!Number.isFinite(value)) return "";
  const rounded =
    Math.abs(value) >= 10 ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100;
  return `${Number(rounded.toFixed(Math.abs(rounded) >= 10 ? 1 : 2))}`;
}

function nutrientUnitForDisplay(measurement: MyDayMeasurementSystem) {
  return measurement === "US" ? "oz" : "g";
}

function nutrientValueForDisplay(value: number, measurement: MyDayMeasurementSystem) {
  if (!Number.isFinite(value)) return "0";
  if (measurement !== "US") return `${Math.round(value)}`;
  return formatDisplayQuantity(value / GRAMS_PER_OUNCE);
}

function unitForDisplay(unit: string, measurement: MyDayMeasurementSystem) {
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

function quantityForDisplay(quantity: string, unit: string, measurement: MyDayMeasurementSystem) {
  const parsed = Number(String(quantity).replace(",", "."));
  if (!Number.isFinite(parsed) || measurement !== "US") return quantity;

  const normalizedUnit = unit.trim().toLowerCase();
  if (normalizedUnit === "g") return formatDisplayQuantity(parsed / GRAMS_PER_OUNCE);
  if (normalizedUnit === "kg") return formatDisplayQuantity(parsed * POUNDS_PER_KILOGRAM);
  if (normalizedUnit === "ml") return formatDisplayQuantity(parsed / ML_PER_FLUID_OUNCE);
  if (normalizedUnit === "l") return formatDisplayQuantity(parsed * FLUID_OUNCES_PER_LITER);
  return quantity;
}

function quantityFromDisplay(quantity: string, storedUnit: string, measurement: MyDayMeasurementSystem) {
  const parsed = Number(String(quantity).replace(",", "."));
  if (!Number.isFinite(parsed) || measurement !== "US") return quantity;

  const normalizedUnit = storedUnit.trim().toLowerCase();
  if (normalizedUnit === "g") return formatDisplayQuantity(parsed * GRAMS_PER_OUNCE);
  if (normalizedUnit === "kg") return formatDisplayQuantity(parsed / POUNDS_PER_KILOGRAM);
  if (normalizedUnit === "ml") return formatDisplayQuantity(parsed * ML_PER_FLUID_OUNCE);
  if (normalizedUnit === "l") return formatDisplayQuantity(parsed / FLUID_OUNCES_PER_LITER);
  return quantity;
}

function chartPointLabelWidth(value: number | string) {
  return Math.max(36, Math.min(56, String(value).length * 9 + 8));
}

function splitIngredients(input: string) {
  return splitMealTextIntoIngredients(input);
}

function scaleIngredients(ingredients: ReviewIngredient[], multiplier: number) {
  return ingredients.map((item) => ({
    ...item,
    quantity: String(
      Number(((parseNumber(item.quantity, 1) || 1) * Math.max(multiplier, 0.1)).toFixed(2))
    ),
  }));
}

function isLowImpactReviewIngredient(item: ReviewIngredient) {
  const name = item.name
    .trim()
    .toLowerCase()
    .replace(
      /^\s*(?:\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?|\d+\/\d+|\d+\s+\d+\/\d+|½|¼|¾|⅓|⅔)\s*/i,
      ""
    )
    .replace(
      /^\s*(kg|g|mg|ml|l|lb|oz|tbsp|tbsps|tsp|tsps|tablespoons?|teaspoons?|cups?|clove|cloves|gousse|gousses|diente|dientes|dente|dentes|folha|folhas|slice|slices|fatia|fatias|unit|units|un|und|serving|servings)\b\s*/i,
      ""
    )
    .replace(/^\s*(de|da|do|das|dos)\s+/i, "")
    .trim();
  const unit = item.unit.trim().toLowerCase();
  const quantity = Number(String(item.quantity).replace(",", "."));
  const matchesPattern = LOW_IMPACT_REVIEW_INGREDIENT_PATTERNS.some((pattern) => pattern.test(name));

  if (!matchesPattern) return false;
  if (!Number.isFinite(quantity) || quantity <= 0) return true;
  if (unit === "g" || unit === "ml") return quantity <= 30;
  if (unit === "kg" || unit === "l") return quantity <= 0.05;
  return true;
}

function prioritizeReviewIngredients(ingredients: ReviewIngredient[]) {
  return ingredients
    .map((item, index) => ({ item, index, lowImpact: isLowImpactReviewIngredient(item) }))
    .sort((a, b) => {
      if (a.lowImpact !== b.lowImpact) return a.lowImpact ? 1 : -1;
      return a.index - b.index;
    });
}

function getCollapsedReviewIngredients(ingredients: ReviewIngredient[]) {
  return prioritizeReviewIngredients(ingredients).slice(0, REVIEW_DEFAULT_VISIBLE_COUNT);
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

function recomputeTotals(
  base: EditableTotals,
  baseIngredients: ReviewIngredient[],
  ingredients: ReviewIngredient[]
): EditableTotals {
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

function getReviewUnitOptions(measurement: MyDayMeasurementSystem): ReviewUnitOption[] {
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

function areReviewIngredientsEqual(current: ReviewIngredient[], base: ReviewIngredient[]) {
  const normalizedCurrent = sanitizeReviewIngredients(current).map((item) => ({
    name: item.name.toLowerCase(),
    quantity: item.quantity,
    unit: item.unit,
  }));
  const normalizedBase = sanitizeReviewIngredients(base).map((item) => ({
    name: item.name.toLowerCase(),
    quantity: item.quantity,
    unit: item.unit,
  }));
  return JSON.stringify(normalizedCurrent) === JSON.stringify(normalizedBase);
}

export default function MyDayScreen() {
  const params = useLocalSearchParams<{ openHealthGoals?: string }>();
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const { bg, text, subText, border, card, primary, secondary, cta, isDark, modalBackdrop } = useThemeColors();
  const { width: viewportWidth } = useWindowDimensions();
  const interactiveIconColor = isDark ? "#fff" : primary;
  const router = useRouter();
  const syncEngine = useSyncEngine();

  const [profile, setProfile] = useState<MyDayProfile | null>(null);
  const [meals, setMeals] = useState<MyDayMeal[]>([]);
  const [allMeals, setAllMeals] = useState<MyDayMeal[]>([]);
  const [mealTitleLineCounts, setMealTitleLineCounts] = useState<Record<string, number>>({});
  const [addMealFlowVisible, setAddMealFlowVisible] = useState(false);
  const [savedRecipes, setSavedRecipes] = useState<SavedRecipe[]>([]);
  const [editMealVisible, setEditMealVisible] = useState(false);
  const [editingMealId, setEditingMealId] = useState<string | null>(null);
  const [editingMealSource, setEditingMealSource] = useState<"photo" | "text" | "recipe" | "manual" | null>(null);
  const [editingServings, setEditingServings] = useState("1");
  const [mealDraft, setMealDraft] = useState<EditableTotals | null>(null);
  const [mealDraftBase, setMealDraftBase] = useState<EditableTotals | null>(null);
  const [mealEditIngredients, setMealEditIngredients] = useState<ReviewIngredient[]>([]);
  const [mealEditIngredientBase, setMealEditIngredientBase] = useState<ReviewIngredient[]>([]);
  const [mealEditNutritionMode, setMealEditNutritionMode] = useState<"auto" | "manual">("auto");
  const [mealEditShowAllIngredients, setMealEditShowAllIngredients] = useState(false);
  const [mealEditNewIngredientName, setMealEditNewIngredientName] = useState("");
  const [mealEditNewIngredientQuantity, setMealEditNewIngredientQuantity] = useState("");
  const [mealEditNewIngredientUnit, setMealEditNewIngredientUnit] = useState("g");
  const [mealEditUnitDropdownOpen, setMealEditUnitDropdownOpen] = useState(false);
  const [mealEditSaveInFlight, setMealEditSaveInFlight] = useState(false);
  const mealEditSaveInFlightRef = useRef(false);
  const [firstUsePromptVisible, setFirstUsePromptVisible] = useState(false);
  const [firstUsePromptDismissedThisSession, setFirstUsePromptDismissedThisSession] = useState(false);
  const [healthGoalsVisible, setHealthGoalsVisible] = useState(false);
  const [healthDraft, setHealthDraft] = useState<MyDayProfile | null>(null);
  const [healthMeasurement, setHealthMeasurement] = useState<MyDayMeasurementSystem>("Metric");
  const [healthPlanMode, setHealthPlanMode] = useState<"auto" | "manual">("auto");
  const [weightLogs, setWeightLogs] = useState<MyDayWeightLog[]>([]);
  const [weightModalVisible, setWeightModalVisible] = useState(false);
  const [weightInput, setWeightInput] = useState("");
  const [selectedWeightDay, setSelectedWeightDay] = useState("");
  const [weightCalendarVisible, setWeightCalendarVisible] = useState(false);
  const [cookieBalance, setCookieBalance] = useState<number | null>(null);
  const [freePremiumActionsRemaining, setFreePremiumActionsRemaining] = useState<number | null>(null);
  const [weightCalendarMonth, setWeightCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  useEffect(() => {
    setProfile(null);
    setMeals([]);
    setAllMeals([]);
    setSavedRecipes([]);
    setWeightLogs([]);
    setCookieBalance(null);
    setFreePremiumActionsRemaining(null);
    setFirstUsePromptVisible(false);
    setWeightModalVisible(false);
    setWeightCalendarVisible(false);
    setEditMealVisible(false);
  }, [user?.uid]);

  const locale = useMemo(() => {
    if (i18n.language === "pt") return "pt-PT";
    return i18n.language || "en";
  }, [i18n.language]);
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";

  const todayLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
      }).format(new Date()),
    [locale]
  );

  const visibleMealEditIngredients = useMemo(
    () =>
      mealEditShowAllIngredients
        ? mealEditIngredients.map((item, index) => ({ item, index }))
        : getCollapsedReviewIngredients(mealEditIngredients).map(({ item, index }) => ({ item, index })),
    [mealEditIngredients, mealEditShowAllIngredients]
  );
  const reviewUnitOptions = useMemo(
    () => getReviewUnitOptions(healthMeasurement),
    [healthMeasurement]
  );
  const savedRecipeById = useMemo(() => {
    const map = new Map<string, SavedRecipe>();
    savedRecipes.forEach((recipe) => {
      if (recipe.id) map.set(recipe.id, recipe);
    });
    return map;
  }, [savedRecipes]);
  const refreshDay = useCallback(async () => {
    const [nextProfile, allMeals, recipes, nextWeightLogs, measurementSystem] = await Promise.all([
      loadMyDayProfile(),
      loadMyDayMeals(),
      loadSavedRecipes(),
      loadWeightLogs(),
      loadMeasurementSystemPreference(),
    ]);
    setProfile(nextProfile);
    setMeals(getMealsForDay(allMeals, getDayKey(new Date())));
    setAllMeals(allMeals);
    setSavedRecipes(recipes);
    setWeightLogs(nextWeightLogs);
    setHealthMeasurement(measurementSystem);
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      (async () => {
        const [nextProfile, allMeals, recipes, initialWeightLogs, measurementSystem, economySnapshot] = await Promise.all([
          loadMyDayProfile(),
          loadMyDayMeals(),
          loadSavedRecipes(),
          loadWeightLogs(),
          loadMeasurementSystemPreference(),
          fetchEconomySnapshot({
            backendUrl: API_BASE_URL,
            appEnv,
            auth,
          }).catch(() => null),
        ]);
        let nextWeightLogs = initialWeightLogs;
        if (nextWeightLogs.length === 0 && nextProfile.currentWeight) {
          const parsedProfileWeight = Number(nextProfile.currentWeight.replace(",", "."));
          if (Number.isFinite(parsedProfileWeight) && parsedProfileWeight > 0) {
            const createdWeightLog = await addWeightLog(
              parsedProfileWeight,
              new Date(),
              measurementSystem
            );
            if (typeof (syncEngine as any)?.markMyDayWeightDirty === "function") {
              await (syncEngine as any).markMyDayWeightDirty({
                id: createdWeightLog.id,
                createdAt: createdWeightLog.createdAt,
                dayKey: createdWeightLog.dayKey,
                weight: String(createdWeightLog.value),
                normalizedWeightKg:
                  Number.isFinite(createdWeightLog.valueKg) ? Number(createdWeightLog.valueKg) : null,
              });
            }
            nextWeightLogs = await loadWeightLogs();
          }
        }
        if (!cancelled) {
          setProfile(nextProfile);
          setMeals(getMealsForDay(allMeals, getDayKey(new Date())));
          setAllMeals(allMeals);
          setSavedRecipes(recipes);
          setWeightLogs(nextWeightLogs);
          setHealthMeasurement(measurementSystem);
          setCookieBalance(economySnapshot?.balance ?? null);
          setFreePremiumActionsRemaining(economySnapshot?.freePremiumActionsRemaining ?? null);
          setFirstUsePromptVisible(
            !hasMyDaySetup(nextProfile) && !firstUsePromptDismissedThisSession
          );
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [appEnv, firstUsePromptDismissedThisSession, syncEngine])
  );

  const actionTone = isDark ? "#FFFFFF" : primary;
  const insightToneColors: Record<TodayInsight["tone"], string> = {
    positive: "#2E7D32",
    caution: "#B7791F",
    warning: "#B94A48",
    neutral: subText,
  };

  const caloriesConsumed = meals.reduce((sum, meal) => sum + meal.calories, 0);
  const hasSetup = hasMyDaySetup(profile);
  const caloriesTarget = profile?.plan?.calories ?? 2100;
  const nutrientUnit = nutrientUnitForDisplay(healthMeasurement);
  const remaining = caloriesTarget - caloriesConsumed;
  const calorieProgress = clampPercent(caloriesConsumed / Math.max(caloriesTarget, 1));
  const proteinConsumed = meals.reduce((sum, meal) => sum + meal.protein, 0);
  const carbsConsumed = meals.reduce((sum, meal) => sum + meal.carbs, 0);
  const fatConsumed = meals.reduce((sum, meal) => sum + meal.fat, 0);

  const macros: MacroRow[] = [
    { key: "protein", consumed: proteinConsumed, target: profile?.plan?.protein ?? 130, color: cta },
    { key: "carbs", consumed: carbsConsumed, target: profile?.plan?.carbs ?? 210, color: primary },
    { key: "fat", consumed: fatConsumed, target: profile?.plan?.fat ?? 70, color: secondary },
  ];

  const weekTrendEntries = useMemo(() => {
    const weekStart = getMondayWeekStart(new Date());
    const todayKey = getDayKey(new Date());
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + index);
      const dayKey = getDayKey(date);
      const value = allMeals
        .filter((meal) => meal.dayKey === dayKey)
        .reduce((sum, meal) => sum + meal.calories, 0);
      const status: WeekTrendEntry["status"] =
        value > 0
          ? "logged"
          : dayKey > todayKey
            ? "future"
            : dayKey < todayKey
              ? "missed"
              : "today-empty";
      return {
        key: dayKey,
        value,
        label: formatWeekTrendLabel(date, locale),
        status,
      };
    });
  }, [allMeals, locale]);
  const loggedWeekTrendEntries = weekTrendEntries.filter((entry) => entry.value > 0);
  const insights: TodayInsight[] = (() => {
    if (!hasSetup) {
      return [
        {
          key: "setup",
          icon: "track-changes",
          tone: "neutral",
          text: t("my_day.insight_setup_goals", {
            defaultValue: "Set up Health & Goals to unlock personalized meal insights.",
          }),
        },
      ];
    }

    if (meals.length === 0) {
      return [
        {
          key: "empty",
          icon: "sentiment-very-satisfied",
          tone: "neutral",
          text: t("my_day.insight_log_first_meal", {
            defaultValue: "Log your first meal today to start tracking calories and macros.",
          }),
        },
      ];
    }

    const nextInsights: TodayInsight[] = [];
    const remainingCalories = Math.round(remaining);
    const calorieCloseThreshold = Math.round(caloriesTarget * 0.15);
    const calorieLowThreshold = Math.round(caloriesTarget * 0.35);

    if (remainingCalories < 0) {
      nextInsights.push({
        key: "calories-over",
        icon: "warning-amber",
        tone: "warning",
        text: t("my_day.insight_calories_over_goal", {
          defaultValue: "You are {{count}} kcal over your goal today. Keeping the next meal lighter can help balance the day.",
          count: Math.abs(remainingCalories),
        }),
      });
    } else if (remainingCalories <= calorieCloseThreshold) {
      nextInsights.push({
        key: "calories-close",
        icon: "track-changes",
        tone: "caution",
        text: t("my_day.insight_calories_close_goal", {
          defaultValue: "You are close to your calorie goal, with {{count}} kcal remaining.",
          count: remainingCalories,
        }),
      });
    } else if (caloriesConsumed <= calorieLowThreshold) {
      nextInsights.push({
        key: "calories-room",
        icon: "sentiment-very-satisfied",
        tone: "positive",
        text: t("my_day.insight_calories_room", {
          defaultValue: "You still have {{count}} kcal available today, so there is room for a balanced meal.",
          count: remainingCalories,
        }),
      });
    } else {
      nextInsights.push({
        key: "calories-on-track",
        icon: "sentiment-very-satisfied",
        tone: "positive",
        text: t("my_day.insight_calories_on_track", {
          defaultValue: "Your calories are on track today. Keep logging meals to keep the picture accurate.",
        }),
      });
    }

    const macroOver = macros
      .filter((macro) => macro.target > 0 && macro.consumed > macro.target * 1.1)
      .sort((a, b) => b.consumed / b.target - a.consumed / a.target)[0];
    const proteinLow = macros.find((macro) => macro.key === "protein" && macro.target > 0 && macro.consumed < macro.target * 0.7);

    if (macroOver) {
      nextInsights.push({
        key: `macro-over-${macroOver.key}`,
        icon: "warning-amber",
        tone: "warning",
        text: t("my_day.insight_macro_over", {
          defaultValue: "{{macro}} is running high today, so a lighter next meal may fit your plan better.",
          macro: t(`my_day.${macroOver.key}`),
        }),
      });
    } else if (proteinLow) {
      nextInsights.push({
        key: "protein-low",
        icon: "error-outline",
        tone: "caution",
        text: t("my_day.insight_protein_low", {
          defaultValue: "You are below your protein goal today. A protein-rich next meal can help.",
        }),
      });
    } else {
      nextInsights.push({
        key: "macros-on-track",
        icon: "sentiment-very-satisfied",
        tone: "positive",
        text: t("my_day.insight_macros_on_track", {
          defaultValue: "Your macros are looking balanced against today’s goals.",
        }),
      });
    }

    return nextInsights.slice(0, 2);
  })();
  const averageCalories =
    loggedWeekTrendEntries.length > 0
      ? Math.round(loggedWeekTrendEntries.reduce((sum, entry) => sum + entry.value, 0) / loggedWeekTrendEntries.length)
      : 0;
  const targetMetDays = hasSetup
    ? loggedWeekTrendEntries.filter((entry) => entry.value <= caloriesTarget).length
    : 0;

  const weightUnit = healthMeasurement === "US" ? "lb" : "kg";
  const latestWeight = latestWeightLog(weightLogs);
  const weekWeightLogs = useMemo(() => {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - 6);
    startDate.setHours(0, 0, 0, 0);
    return weightLogs.filter((log) => new Date(log.createdAt) >= startDate);
  }, [weightLogs]);
  const weightGraphLogs = weekWeightLogs.length > 0 ? weekWeightLogs : weightLogs;
  const displayedGoalWeight =
    profile?.targetWeightKg != null
      ? formatWeightFromKg(profile.targetWeightKg, healthMeasurement)
      : profile?.targetWeight || "";
  const displayedStartWeight =
    profile?.currentWeightKg != null
      ? formatWeightFromKg(profile.currentWeightKg, healthMeasurement)
      : profile?.currentWeight || "";
  const weightGoalValue = Number(displayedGoalWeight || 0);
  const weightStartValue = displayedStartWeight ? parseNumber(displayedStartWeight, 0) : latestWeight?.value ?? 0;
  const weightPlanUpdatedAt = profile?.updatedAt ? new Date(profile.updatedAt) : null;
  const weightRemainingToGoal =
    latestWeight && Number.isFinite(weightGoalValue) && weightGoalValue > 0
      ? Math.abs(latestWeight.value - weightGoalValue)
      : null;
  const weightProgressRatio = useMemo(() => {
    if (!latestWeight || !Number.isFinite(weightGoalValue) || weightGoalValue <= 0) return 0;
    if (!Number.isFinite(weightStartValue) || weightStartValue <= 0) return 0;
    if (profile?.goalType === "maintain") return 1;
    const totalDistance = Math.abs(weightStartValue - weightGoalValue);
    if (totalDistance <= 0.01) return 1;
    const covered = totalDistance - Math.abs(latestWeight.value - weightGoalValue);
    return clampPercent(covered / totalDistance);
  }, [latestWeight, profile?.goalType, weightGoalValue, weightStartValue]);
  const weightProgressText = useMemo(() => {
    if (!latestWeight) {
      return t("my_day.weight_empty_body", {
        defaultValue: "Add your weight to track progress over time.",
      });
    }
    if (!Number.isFinite(weightGoalValue) || weightGoalValue <= 0) {
      return t("my_day.weight_goal_missing_body", {
        defaultValue: "Add a target weight",
      });
    }
    if (profile?.goalType === "maintain") {
      return t("my_day.weight_progress_maintain", {
        defaultValue: "Tracking how steady you stay around your current weight.",
      });
    }
    if ((weightRemainingToGoal ?? 0) <= 0.2) {
      return t("my_day.weight_progress_close", {
        defaultValue: "You are very close to your goal.",
      });
    }
    return t("my_day.weight_progress_remaining", {
      count: weightRemainingToGoal?.toFixed(1) ?? "0",
      unit: weightUnit,
    } as any);
  }, [latestWeight, profile?.goalType, t, weightGoalValue, weightRemainingToGoal, weightUnit]);
  const weightChartMin =
    weightGraphLogs.length > 0
      ? Math.min(
          ...weightGraphLogs.map((log) => log.value),
          Number.isFinite(weightGoalValue) ? weightGoalValue : Infinity
        )
      : 0;
  const weightChartMax =
    weightGraphLogs.length > 0
      ? Math.max(
          ...weightGraphLogs.map((log) => log.value),
          Number.isFinite(weightGoalValue) ? weightGoalValue : -Infinity
        )
      : 1;
  const weightChartRange = Math.max(weightChartMax - weightChartMin, 0.5);
  const weightChartTopPadding = 24;
  const weightChartHeight = 128;
  const weightChartBottomInset = 30;
  const weightChartXAxisBottomOffset = 20;
  const weightChartXAxisY =
    weightChartTopPadding + weightChartHeight + weightChartBottomInset - weightChartXAxisBottomOffset;
  const weightPointStart = 10;
  const weightChartViewportWidth = Math.max(viewportWidth - 108, 220);
  const weightPointGap =
    weightGraphLogs.length > 1
      ? Math.max(42, (weightChartViewportWidth - weightPointStart * 2 - 24) / (weightGraphLogs.length - 1))
      : 0;
  const weightChartWidth = weightChartViewportWidth;
  const weightActualPoints = weightGraphLogs.map((log, index) => ({
    ...log,
    x: weightGraphLogs.length === 1 ? weightChartViewportWidth / 2 : weightPointStart + index * weightPointGap,
    y:
      weightChartTopPadding +
      weightChartHeight -
      ((log.value - weightChartMin) / weightChartRange) * weightChartHeight,
  }));
  const weightGoalLineY =
    Number.isFinite(weightGoalValue)
      ? weightChartTopPadding +
        weightChartHeight -
        ((weightGoalValue - weightChartMin) / weightChartRange) * weightChartHeight
      : null;
  const weightAxisEntries = useMemo(() => {
    const raw = [
      { value: weightChartMax, goal: false },
      { value: weightChartMin + weightChartRange / 2, goal: false },
      { value: weightChartMin, goal: false },
      ...(Number.isFinite(weightGoalValue) ? [{ value: weightGoalValue, goal: true }] : []),
    ];
    const deduped: { value: number; goal: boolean }[] = [];
    raw
      .sort((a, b) => b.value - a.value)
      .forEach((entry) => {
        const existing = deduped.find((item) => Math.abs(item.value - entry.value) < 0.15);
        if (existing) {
          if (entry.goal) existing.goal = true;
          return;
        }
        deduped.push({ ...entry });
      });
    return deduped;
  }, [weightChartMax, weightChartMin, weightChartRange, weightGoalValue]);
  const weightTrendPath = useMemo(() => {
    if (weightActualPoints.length === 0) return "";
    if (weightActualPoints.length === 1) {
      const point = weightActualPoints[0];
      return `M ${point.x} ${point.y}`;
    }
    let path = `M ${weightActualPoints[0].x} ${weightActualPoints[0].y}`;
    for (let i = 0; i < weightActualPoints.length - 1; i += 1) {
      const current = weightActualPoints[i];
      const next = weightActualPoints[i + 1];
      const controlX = (current.x + next.x) / 2;
      path += ` C ${controlX} ${current.y}, ${controlX} ${next.y}, ${next.x} ${next.y}`;
    }
    return path;
  }, [weightActualPoints]);
  const weightAreaPath = useMemo(() => {
    if (!weightTrendPath || weightActualPoints.length === 0) return "";
    const lastPoint = weightActualPoints[weightActualPoints.length - 1];
    const firstPoint = weightActualPoints[0];
    return `${weightTrendPath} L ${lastPoint.x} ${weightChartXAxisY} L ${firstPoint.x} ${weightChartXAxisY} Z`;
  }, [weightActualPoints, weightChartXAxisY, weightTrendPath]);
  const weightTrendSkPath = useMemo(
    () => (weightTrendPath ? Skia.Path.MakeFromSVGString(weightTrendPath) : null),
    [weightTrendPath]
  );
  const weightAreaSkPath = useMemo(
    () => (weightAreaPath ? Skia.Path.MakeFromSVGString(weightAreaPath) : null),
    [weightAreaPath]
  );
  const weightChartFillColor = useMemo(() => hexToRgba(cta, 0.14), [cta]);
  const weightGoalLineColor = useMemo(() => hexToRgba(cta, 0.6), [cta]);

  const sanitizeWeightInput = (value: string) => {
    const normalized = value.replace(",", ".");
    const cleaned = normalized.replace(/[^0-9.]/g, "");
    const [whole = "", ...decimals] = cleaned.split(".");
    const trimmedDecimals = decimals.join("").slice(0, 2);
    return cleaned.includes(".") ? `${whole}.${trimmedDecimals}` : whole;
  };

  const displayedWeightDay = selectedWeightDay || getWeightDayKey(new Date());
  const [weightYear, weightMonth] = displayedWeightDay.split("-").map(Number);
  const weightMonthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
    weightCalendarMonth
  );
  const weightMonthStartWeekday = new Date(
    weightCalendarMonth.getFullYear(),
    weightCalendarMonth.getMonth(),
    1
  ).getDay();
  const weightDaysInMonth = new Date(
    weightCalendarMonth.getFullYear(),
    weightCalendarMonth.getMonth() + 1,
    0
  ).getDate();
  const weightCalendarCells = [
    ...Array.from({ length: weightMonthStartWeekday }).map(() => null),
    ...Array.from({ length: weightDaysInMonth }).map((_, index) => index + 1),
  ];

  const openWeightLogger = () => {
    setWeightInput("");
    setSelectedWeightDay("");
    const now = new Date();
    setWeightCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setWeightModalVisible(true);
  };

  const openHealthGoals = async () => {
    const [nextProfile, measurementSystem] = await Promise.all([
      loadMyDayProfile(),
      loadMeasurementSystemPreference(),
    ]);
    setHealthMeasurement(measurementSystem);
    setHealthDraft(nextProfile);
    setHealthPlanMode(nextProfile.isCustomizedPlan ? "manual" : "auto");
    setHealthGoalsVisible(true);
  };

  React.useEffect(() => {
    if (params.openHealthGoals === "1") {
      openHealthGoals();
      router.replace("/my-day" as any);
    }
  }, [openHealthGoals, params.openHealthGoals, router]);

  const openMealEditor = (meal: any) => {
    const safeMultiplier =
      Number.isFinite(Number(meal.servingMultiplier)) && Number(meal.servingMultiplier) > 0
        ? Number(meal.servingMultiplier)
        : 1;
    const baseDraft = {
      title: meal.title,
      calories: String(Math.round(meal.calories / safeMultiplier)),
      protein: String(Math.round(meal.protein / safeMultiplier)),
      carbs: String(Math.round(meal.carbs / safeMultiplier)),
      fat: String(Math.round(meal.fat / safeMultiplier)),
    };
    const fallbackIngredients = splitIngredients(meal.rawInput || meal.title).map((name) => ({
      name,
      quantity: "100",
      unit: "g",
    }));
    const nextIngredients =
      Array.isArray(meal.ingredients) && meal.ingredients.length > 0 ? meal.ingredients : fallbackIngredients;
    const normalizedBaseIngredients = nextIngredients.map((item: MyDayMealIngredient) => ({
      ...item,
      quantity: String(Number((parseNumber(item.quantity, 1) / safeMultiplier).toFixed(2))),
    }));
    setEditingMealId(meal.id);
    setEditingMealSource(meal.source);
    setEditingServings(String(safeMultiplier));
    setMealEditNutritionMode(meal.source === "manual" ? "manual" : "auto");
    setMealDraftBase(baseDraft);
    setMealEditIngredientBase(normalizedBaseIngredients);
    setMealEditIngredients(scaleIngredients(normalizedBaseIngredients, safeMultiplier));
    setMealEditShowAllIngredients(false);
    setMealEditNewIngredientName("");
    setMealEditNewIngredientQuantity("");
    setMealEditNewIngredientUnit("g");
    setMealEditUnitDropdownOpen(false);
    setMealDraft({
      title: meal.title,
      calories: String(meal.calories),
      protein: String(meal.protein),
      carbs: String(meal.carbs),
      fat: String(meal.fat),
    });
    setEditMealVisible(true);
  };

  const handleMealEditServingsChange = (value: string) => {
    setEditingServings(value);
    const multiplier = Number(value.replace(",", "."));
    const safeMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
    if (mealDraftBase) {
      if (mealEditNutritionMode === "auto") {
        setMealDraft({
          title: mealDraft?.title || mealDraftBase.title,
          calories: String(Math.round(parseNumber(mealDraftBase.calories, 0) * safeMultiplier)),
          protein: String(Math.round(parseNumber(mealDraftBase.protein, 0) * safeMultiplier)),
          carbs: String(Math.round(parseNumber(mealDraftBase.carbs, 0) * safeMultiplier)),
          fat: String(Math.round(parseNumber(mealDraftBase.fat, 0) * safeMultiplier)),
        });
      }
      setMealEditIngredients(scaleIngredients(mealEditIngredientBase, safeMultiplier));
    }
  };

  const handleMealEditNutritionModeChange = (mode: "auto" | "manual") => {
    setMealEditNutritionMode(mode);
    if (mode === "auto" && mealDraftBase && mealDraft) {
      const recomputed = recomputeTotals(mealDraftBase, mealEditIngredientBase, mealEditIngredients);
      setMealDraft({
        title: mealDraft.title,
        calories: recomputed.calories,
        protein: recomputed.protein,
        carbs: recomputed.carbs,
        fat: recomputed.fat,
      });
    }
  };

  const handleDeleteMeal = (mealId: string) => {
    Alert.alert(
      t("my_day.delete_meal_title", { defaultValue: "Delete meal" }),
      t("my_day.delete_meal_body", { defaultValue: "Remove this meal from today?" }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"),
          style: "destructive",
          onPress: async () => {
            await removeMeal(mealId);
            if (typeof (syncEngine as any)?.markMyDayMealDeleted === "function") {
              await (syncEngine as any).markMyDayMealDeleted(mealId);
            }
            await refreshDay();
          },
        },
      ]
    );
  };

  const updateIngredientQuantity = (
    setIngredients: React.Dispatch<React.SetStateAction<ReviewIngredient[]>>,
    base: EditableTotals | null,
    baseIngredients: ReviewIngredient[],
    setDraft: React.Dispatch<React.SetStateAction<EditableTotals | null>>,
    index: number,
    value: string,
    field: "quantity" | "unit"
  ) => {
    setIngredients((prev) => {
      const next = prev.map((item, idx) => (idx === index ? { ...item, [field]: value } : item));
      if (base) {
        setDraft(recomputeTotals(base, baseIngredients, next));
      }
      return next;
    });
  };

  const updateIngredientDisplayQuantity = (
    ingredients: ReviewIngredient[],
    setIngredients: React.Dispatch<React.SetStateAction<ReviewIngredient[]>>,
    base: EditableTotals | null,
    baseIngredients: ReviewIngredient[],
    setDraft: React.Dispatch<React.SetStateAction<EditableTotals | null>>,
    index: number,
    value: string
  ) => {
    const storedUnit = ingredients[index]?.unit ?? "";
    updateIngredientQuantity(
      setIngredients,
      base,
      baseIngredients,
      setDraft,
      index,
      quantityFromDisplay(sanitizePositiveDecimalInput(value), storedUnit, healthMeasurement),
      "quantity"
    );
  };

  const removeReviewIngredient = (
    setIngredients: React.Dispatch<React.SetStateAction<ReviewIngredient[]>>,
    base: EditableTotals | null,
    baseIngredients: ReviewIngredient[],
    setDraft: React.Dispatch<React.SetStateAction<EditableTotals | null>>,
    index: number
  ) => {
    setIngredients((prev) => {
      const next = prev.filter((_, idx) => idx !== index);
      if (base) {
        setDraft(recomputeTotals(base, baseIngredients, next));
      }
      return next;
    });
  };

  const addReviewIngredient = (
    ingredient: ReviewIngredient | null,
    setIngredients: React.Dispatch<React.SetStateAction<ReviewIngredient[]>>,
    base: EditableTotals | null,
    baseIngredients: ReviewIngredient[],
    setDraft: React.Dispatch<React.SetStateAction<EditableTotals | null>>
  ) => {
    if (!ingredient) return;
    setIngredients((prev) => {
      const next = [...prev, ingredient];
      if (base) {
        setDraft(recomputeTotals(base, baseIngredients, next));
      }
      return next;
    });
  };

  const beginMealEditSave = () => {
    if (mealEditSaveInFlightRef.current) return false;
    mealEditSaveInFlightRef.current = true;
    setMealEditSaveInFlight(true);
    return true;
  };

  const endMealEditSave = () => {
    mealEditSaveInFlightRef.current = false;
    setMealEditSaveInFlight(false);
  };

  const handleSaveMealEdit = async () => {
    if (!editingMealId || !mealDraft || !beginMealEditSave()) return;
    try {
      const safeIngredients = sanitizeReviewIngredients(mealEditIngredients);
      if (safeIngredients.length === 0) return;
      const ingredientsChanged = !areReviewIngredientsEqual(safeIngredients, mealEditIngredientBase);
      const refreshedEstimate =
        mealEditNutritionMode === "auto" && ingredientsChanged
          ? await resolveStructuredMealEstimate(
              safeIngredients.map((item) => `${item.quantity} ${item.unit} ${item.name}`.trim()).join(", "),
              safeIngredients as MyDayMealIngredient[],
              safeIngredients.map((item) => item.name),
              i18n.language
            )
          : null;
      const updatedMeal = {
        title: mealDraft.title.trim() || "Meal",
        calories: refreshedEstimate ? Math.round(refreshedEstimate.calories) : parseNumber(mealDraft.calories, 0),
        protein: refreshedEstimate ? Math.round(refreshedEstimate.protein) : parseNumber(mealDraft.protein, 0),
        carbs: refreshedEstimate ? Math.round(refreshedEstimate.carbs) : parseNumber(mealDraft.carbs, 0),
        fat: refreshedEstimate ? Math.round(refreshedEstimate.fat) : parseNumber(mealDraft.fat, 0),
        ingredients: safeIngredients as MyDayMealIngredient[],
      };
      const existingMeal = meals.find((meal) => meal.id === editingMealId) ?? null;
      await updateMeal(editingMealId, updatedMeal);
      if (existingMeal && typeof (syncEngine as any)?.markMyDayMealDirty === "function") {
        await (syncEngine as any).markMyDayMealDirty({
          ...existingMeal,
          ...updatedMeal,
        });
      }
      await refreshDay();
      setEditMealVisible(false);
      setEditingMealId(null);
      setEditingMealSource(null);
      setEditingServings("1");
      setMealDraft(null);
      setMealDraftBase(null);
      setMealEditIngredients([]);
      setMealEditIngredientBase([]);
      setMealEditNutritionMode("auto");
      setMealEditShowAllIngredients(false);
      setMealEditNewIngredientName("");
      setMealEditNewIngredientQuantity("");
      setMealEditNewIngredientUnit("g");
      setMealEditUnitDropdownOpen(false);
    } finally {
      endMealEditSave();
    }
  };

  const updateHealthDraft = <K extends keyof MyDayProfile>(key: K, value: MyDayProfile[K]) => {
    setHealthDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: value };
      if (healthPlanMode === "auto") {
        const plan = deriveSuggestedPlan(next, healthMeasurement);
        return { ...next, plan: plan ?? next.plan, isCustomizedPlan: false };
      }
      return next;
    });
  };

  const updateHealthPlan = (key: keyof MyDayPlan, value: string) => {
    setHealthPlanMode("manual");
    setHealthDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        isCustomizedPlan: true,
        plan: {
          calories: prev.plan?.calories ?? 0,
          protein: prev.plan?.protein ?? 0,
          carbs: prev.plan?.carbs ?? 0,
          fat: prev.plan?.fat ?? 0,
          [key]: parseNumber(value, 0),
        },
      };
    });
  };

  const saveHealthGoalsFromMyDay = async () => {
    if (!healthDraft) return;
    const currentWeight = Number(healthDraft.currentWeight.replace(",", "."));
    const parsedTargetWeight = Number(healthDraft.targetWeight.replace(",", "."));
    const normalizedTargetWeight =
      healthDraft.goalType === "maintain"
        ? healthDraft.currentWeight
        : healthDraft.goalType === "lose" && Number.isFinite(currentWeight) && currentWeight > 0
          ? Number.isFinite(parsedTargetWeight) && parsedTargetWeight > 0 && parsedTargetWeight < currentWeight
            ? healthDraft.targetWeight
            : String(Number((currentWeight - 1).toFixed(2)))
          : healthDraft.goalType === "gain" && Number.isFinite(currentWeight) && currentWeight > 0
            ? Number.isFinite(parsedTargetWeight) && parsedTargetWeight > currentWeight
              ? healthDraft.targetWeight
              : String(Number((currentWeight + 1).toFixed(2)))
            : healthDraft.targetWeight;
    const autoPlan = deriveSuggestedPlan(healthDraft, healthMeasurement);
    const nextProfile: MyDayProfile = {
      ...healthDraft,
      heightCm: parseHeightToCm(healthDraft.height, healthMeasurement),
      targetWeight: normalizedTargetWeight,
      currentWeightKg: parseWeightToKg(healthDraft.currentWeight, healthMeasurement),
      targetWeightKg: parseWeightToKg(normalizedTargetWeight, healthMeasurement),
      plan: healthPlanMode === "auto" ? autoPlan ?? healthDraft.plan : healthDraft.plan,
      isCustomizedPlan: healthPlanMode === "manual",
      updatedAt: new Date().toISOString(),
    };
    await saveMyDayProfile(nextProfile, healthMeasurement);
    if (typeof (syncEngine as any)?.markMyDayProfileDirty === "function") {
      await (syncEngine as any).markMyDayProfileDirty(nextProfile);
    }
    if (Number.isFinite(currentWeight) && currentWeight > 0) {
      const createdWeightLog = await addWeightLog(currentWeight, new Date(), healthMeasurement);
      if (typeof (syncEngine as any)?.markMyDayWeightDirty === "function") {
        await (syncEngine as any).markMyDayWeightDirty({
          id: createdWeightLog.id,
          createdAt: createdWeightLog.createdAt,
          dayKey: createdWeightLog.dayKey,
          weight: String(createdWeightLog.value),
          normalizedWeightKg:
            Number.isFinite(createdWeightLog.valueKg) ? Number(createdWeightLog.valueKg) : null,
        });
      }
    }
    try {
      if (API_BASE_URL) {
        await claimEconomyReward({
          backendUrl: API_BASE_URL,
          appEnv: process.env.EXPO_PUBLIC_APP_ENV ?? "local",
          auth,
          rewardKey: "profile_health_goals_v1",
        });
      }
    } catch (rewardErr) {
      console.warn("[MyDay] health goals reward claim failed", rewardErr);
    }
    setProfile(nextProfile);
    setHealthDraft(nextProfile);
    setHealthGoalsVisible(false);
    await refreshDay();
  };

  const handleSaveWeightFromMyDay = async () => {
    const parsed = Number(weightInput.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const [year, month, day] = selectedWeightDay.split("-").map(Number);
    const targetDate = year && month && day ? new Date(year, month - 1, day) : new Date();
    const createdWeightLog = await addWeightLog(parsed, targetDate, healthMeasurement);
    if (typeof (syncEngine as any)?.markMyDayWeightDirty === "function") {
      await (syncEngine as any).markMyDayWeightDirty({
        id: createdWeightLog.id,
        createdAt: createdWeightLog.createdAt,
        dayKey: createdWeightLog.dayKey,
        weight: String(createdWeightLog.value),
        normalizedWeightKg:
          Number.isFinite(createdWeightLog.valueKg) ? Number(createdWeightLog.valueKg) : null,
      });
    }
    await refreshDay();
    setWeightInput("");
    setSelectedWeightDay("");
    setWeightModalVisible(false);
  };

  return (
    <View style={[styles.screen, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          title: t("app_titles.my_day"),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
          headerLeft: () => null,
        }}
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.headerTitleWrap}>
            <Text style={[styles.kicker, { color: subText }]}>{t("my_day.today_label")}</Text>
            <Text style={[styles.title, { color: text }]}>{todayLabel}</Text>
          </View>
          <View style={styles.headerChips}>
            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.headerHistoryChip, { backgroundColor: card, borderColor: border }]}
              onPress={openHealthGoals}
            >
              <MaterialIcons name="flag-circle" size={15} color={interactiveIconColor} />
              <Text style={[styles.headerHistoryText, { color: text }]}>
                {t("my_day.goals", { defaultValue: "Goals" })}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <AppCard style={styles.summaryCard}>
          <View style={styles.summaryTopRow}>
            <View style={styles.summaryPrimary}>
              <Text style={[styles.summaryLabel, { color: subText }]}>
                {t("my_day.todays_calories", { defaultValue: "Today's calories" })}
              </Text>
              <Text style={[styles.summaryNumber, { color: text }]}>{caloriesConsumed} kcal</Text>
            </View>
            <View style={styles.summaryTarget}>
              <Text style={[styles.summaryLabel, { color: subText }]}>
                {t("my_day.calorie_goal_label", { defaultValue: "Goal" })}
              </Text>
              {hasSetup ? (
                <Text style={[styles.summaryTargetNumber, { color: text }]}>
                  {caloriesTarget} kcal
                </Text>
              ) : (
                <TouchableOpacity activeOpacity={0.85} onPress={openHealthGoals}>
                  <Text style={[styles.summaryTargetMissing, { color: cta }]}>
                    {t("my_day.no_target_title", { defaultValue: "No personalized target yet" })}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
          <View style={[styles.progressTrack, { backgroundColor: `${primary}20` }]}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.max((hasSetup ? calorieProgress : 0.62) * 100, 4)}%`,
                  backgroundColor: cta,
                },
              ]}
            />
          </View>
          <View style={styles.summaryMetaRow}>
            {hasSetup ? (
              <Text
                style={[
                  styles.remainingText,
                  { color: remaining >= 0 ? cta : "#B94A48" },
                ]}
              >
                {remaining >= 0
                  ? t("my_day.calories_remaining", { count: remaining })
                  : t("my_day.calories_over", { count: Math.abs(remaining) })}
              </Text>
            ) : (
              <TouchableOpacity activeOpacity={0.85} onPress={openHealthGoals}>
                <Text style={[styles.remainingText, { color: cta }]}>
                  {t("my_day.setup_prompt", {
                    defaultValue: "Set up Health & Goals to personalize calories and macros",
                  })}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.macrosInline}>
            {macros.map((macro) => {
              const progress = clampPercent(macro.consumed / Math.max(macro.target, 1));
              return (
                <View key={macro.key} style={styles.macroCompact}>
                  <View style={styles.macroCompactHeader}>
                    <Text numberOfLines={1} style={[styles.macroCompactLabel, { color: text }]}>
                      {t(`my_day.${macro.key}`)}
                    </Text>
                    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={[styles.macroCompactAmount, { color: subText }]}>
                      {hasSetup
                        ? `${nutrientValueForDisplay(macro.consumed, healthMeasurement)} / ${nutrientValueForDisplay(
                            macro.target,
                            healthMeasurement
                          )}${nutrientUnit}`
                        : `${nutrientValueForDisplay(macro.consumed, healthMeasurement)}${nutrientUnit}`}
                    </Text>
                  </View>
                  <View style={[styles.macroTrack, { backgroundColor: `${macro.color}22` }]}>
                    <View
                      style={[
                        styles.macroFill,
                        {
                          backgroundColor: macro.color,
                          width: `${Math.max((hasSetup ? progress : 0.5) * 100, 8)}%`,
                        },
                      ]}
                    />
                  </View>
                </View>
              );
            })}
          </View>
        </AppCard>

        <AppCard>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: text }]}>{t("my_day.todays_meals")}</Text>
            <TouchableOpacity activeOpacity={0.8} onPress={() => router.push("/my-day/history")}>
              <Text style={[styles.linkText, { color: cta }]}>
                {t("my_day.trends_history_title", { defaultValue: "History" })}
              </Text>
            </TouchableOpacity>
          </View>

          {meals.length === 0 ? (
            <View style={[styles.emptyState, { backgroundColor: `${secondary}15` }]}>
              <Text style={[styles.emptyTitle, { color: text }]}>
                {t("my_day.empty_title", { defaultValue: "Nothing logged yet" })}
              </Text>
              <Text style={[styles.emptyBody, { color: subText }]}>
                {t("my_day.empty_body", {
                  defaultValue: "Start with a quick meal description or a saved recipe.",
                })}
              </Text>
            </View>
          ) : (
            meals.slice(0, 4).map((meal) => {
              const recipeImage =
                meal.source === "recipe" && meal.recipeId
                  ? savedRecipeById.get(meal.recipeId)?.image
                  : null;
              const sourceImage = meal.source === "photo" && meal.photoUri ? meal.photoUri : recipeImage;
              const sourceIcon =
                meal.source === "photo"
                  ? "photo-camera"
                  : meal.source === "recipe"
                    ? "menu-book"
                    : "chat-bubble-outline";

              return (
                <TouchableOpacity
                  key={meal.id}
                  activeOpacity={0.85}
                  onPress={() => openMealEditor(meal)}
                  style={[styles.mealRow, { borderBottomColor: border }]}
                >
                  <View style={styles.mealRowInner}>
                    <View style={[styles.mealSourceSquare, { backgroundColor: `${secondary}18`, borderColor: border }]}>
                      {sourceImage ? (
                        <Image source={{ uri: sourceImage }} style={styles.mealSourceImage} />
                      ) : (
                        <MaterialIcons name={sourceIcon as any} size={25} color={cta} />
                      )}
                    </View>
                    <View
                      style={[
                        styles.mealCardContent,
                        (mealTitleLineCounts[meal.id] ?? 1) <= 1 ? styles.mealCardContentCompact : null,
                      ]}
                    >
                      <View style={styles.mealTopRow}>
                        <View style={styles.mealInfo}>
                          <Text
                            numberOfLines={2}
                            ellipsizeMode="tail"
                            onTextLayout={(event) => {
                              const lineCount = Math.min(event.nativeEvent.lines.length, 2);
                              setMealTitleLineCounts((prev) =>
                                prev[meal.id] === lineCount ? prev : { ...prev, [meal.id]: lineCount }
                              );
                            }}
                            style={[styles.mealTitle, { color: text }]}
                          >
                            {meal.title}
                          </Text>
                        </View>
                        <View style={styles.mealActions}>
                          <TouchableOpacity activeOpacity={0.8} onPress={() => openMealEditor(meal)} style={styles.mealActionButton}>
                            <MaterialIcons name="edit" size={17} color={interactiveIconColor} />
                          </TouchableOpacity>
                          <TouchableOpacity activeOpacity={0.8} onPress={() => handleDeleteMeal(meal.id)} style={styles.mealActionButton}>
                            <MaterialIcons name="delete-outline" size={18} color={subText} />
                          </TouchableOpacity>
                        </View>
                      </View>
                      <View style={styles.mealMacroRow}>
                        {[
                          {
                            key: "kcal",
                            label: "Kcal",
                            value: meal.calories,
                            icon: "local-fire-department" as const,
                          },
                          {
                            key: "protein",
                            label: t("my_day.protein"),
                            value: meal.protein,
                            icon: null,
                          },
                          {
                            key: "carbs",
                            label: t("my_day.carbs"),
                            value: meal.carbs,
                            icon: null,
                          },
                          {
                            key: "fat",
                            label: t("my_day.fat"),
                            value: meal.fat,
                            icon: null,
                          },
                        ].map((macro) => {
                          return (
                            <View key={`${meal.id}-${macro.key}`} style={styles.mealMacroSimple}>
                              {macro.icon ? (
                                <MaterialIcons name={macro.icon} size={13} color={cta} style={styles.mealMacroIcon} />
                              ) : null}
                              <Text style={[styles.mealMacroSimpleLabel, { color: subText }]}>
                                {macro.label}
                              </Text>
                              <Text style={[styles.mealMacroSimpleValue, { color: text }]}>
                                {macro.key === "kcal"
                                  ? Math.round(macro.value)
                                  : nutrientValueForDisplay(macro.value, healthMeasurement)}
                                {macro.key === "kcal" ? null : (
                                  <Text style={[styles.mealMacroSimpleUnit, { color: subText }]}>
                                    {" "}
                                    {nutrientUnit}
                                  </Text>
                                )}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </AppCard>

        <AppCard>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: text }]}>{t("my_day.insights")}</Text>
          </View>
          {insights.map((insight) => {
            const toneColor = insightToneColors[insight.tone];
            return (
              <View key={insight.key} style={styles.insightRow}>
                <MaterialIcons name={insight.icon as any} size={19} color={toneColor} />
                <Text style={[styles.insightText, { color: text }]}>{insight.text}</Text>
              </View>
            );
          })}
        </AppCard>

        <AppCard>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: text }]}>
              {t("my_day.weekly_trends", { defaultValue: "Weekly trends" })}
            </Text>
            <TouchableOpacity activeOpacity={0.8} onPress={() => router.push("/my-day/trends")}>
              <Text style={[styles.linkText, { color: cta }]}>
                {t("my_day.view_details", { defaultValue: "View details" })}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.trendStatsRow}>
            <View style={styles.trendStatBlock}>
              <Text style={[styles.trendStatLabel, styles.trendAverageLabel, { color: subText }]}>
                {t("my_day.average_daily_intake", { defaultValue: "Average daily intake" })}
              </Text>
              <Text style={[styles.trendStatValue, styles.trendStatValueLarge, { color: text }]}>{averageCalories} kcal</Text>
            </View>
            <View style={[styles.trendStatBlock, styles.trendStatBlockRight]}>
              <Text style={[styles.trendStatLabel, styles.trendAverageLabel, { color: subText }]}>
                {t("my_day.goal_days_met", { defaultValue: "Days within goal" })}
              </Text>
              <Text style={[styles.trendStatValue, { color: text }]}>
                {hasSetup ? `${targetMetDays}/${weekTrendEntries.length}` : "—"}
              </Text>
            </View>
          </View>
          <MiniBars
            entries={weekTrendEntries}
            tint={cta}
            goal={hasSetup ? caloriesTarget : 0}
            goalColor={isDark ? "#5A606A" : "#D7DBE0"}
            missedGoalColor={isDark ? "#444A53" : "#C5CAD1"}
            futureGoalColor={isDark ? "#5A606A" : "#E2E5E9"}
            labelColor={subText}
          />
        </AppCard>

        <AppCard>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: text }]}>
              {t("my_day.weight_chart_title", { defaultValue: "Weight" })}
            </Text>
            <TouchableOpacity activeOpacity={0.8} onPress={() => router.push("/my-day/weight")}>
              <Text style={[styles.linkText, { color: cta }]}>
                {t("my_day.view_details", { defaultValue: "View details" })}
              </Text>
            </TouchableOpacity>
          </View>
          {weightLogs.length === 0 ? (
            <View style={[styles.emptyState, { backgroundColor: `${secondary}15` }]}>
              <Text style={[styles.emptyTitle, { color: text }]}>
                {t("my_day.weight_empty_title", { defaultValue: "No weight logged yet" })}
              </Text>
              <Text style={[styles.emptyBody, { color: subText }]}>
                {t("my_day.weight_empty_body", {
                  defaultValue: "Add your weight to track progress over time.",
                })}
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.weightProgressHeader}>
                <View style={styles.weightProgressPrimary}>
                  <Text style={[styles.weightSummaryLabel, { color: subText }]}>
                    {t("profile.health_current_weight", { defaultValue: "Current weight" })}
                  </Text>
                  <Text style={[styles.weightHeroValue, { color: text }]}>
                    {latestWeight ? `${latestWeight.value} ${weightUnit}` : "—"}
                  </Text>
                </View>
                <View style={styles.weightProgressGoal}>
                  <Text style={[styles.weightSummaryLabel, { color: subText }]}>
                    {t("profile.health_target_weight", { defaultValue: "Goal weight" })}
                  </Text>
                  <Text style={[styles.weightGoalValue, { color: text }]}>
                    {displayedGoalWeight ? `${displayedGoalWeight} ${weightUnit}` : "—"}
                  </Text>
                </View>
              </View>
              <View style={[styles.weightProgressTrack, { backgroundColor: `${primary}1F` }]}>
                <View
                  style={[
                    styles.weightProgressFill,
                    {
                      width: `${Math.max(weightProgressRatio * 100, latestWeight ? 12 : 0)}%`,
                      backgroundColor: cta,
                    },
                  ]}
                />
              </View>
              <View style={styles.weightProgressMetaRow}>
                {weightStartValue > 0 ? (
                  <Text style={[styles.weightProgressMeta, { color: subText }]}>
                    {t("my_day.weight_progress_start", {
                      defaultValue: "Started at {{value}} {{unit}}",
                      value: weightStartValue.toFixed(1),
                      unit: weightUnit,
                    })}
                  </Text>
                ) : null}
            {Number.isFinite(weightGoalValue) && weightGoalValue > 0 ? (
              <Text style={[styles.weightProgressMeta, { color: cta }]}>{String(weightProgressText)}</Text>
            ) : (
              <TouchableOpacity activeOpacity={0.85} onPress={openHealthGoals}>
                <Text style={[styles.weightProgressMeta, { color: cta }]}>{String(weightProgressText)}</Text>
              </TouchableOpacity>
            )}
          </View>
              {weightPlanUpdatedAt ? (
                <Text style={[styles.weightProgressUpdatedAt, { color: subText }]}>
                  {t("my_day.weight_progress_updated_at", {
                    defaultValue: "Last updated on {{date}}",
                    date: new Intl.DateTimeFormat(locale, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    }).format(weightPlanUpdatedAt),
                  })}
                </Text>
              ) : null}
              <View style={styles.myDayWeightChartSection}>
                <View style={styles.myDayWeightChartFrame}>
                  <View style={[styles.myDayWeightYAxis, { height: weightChartTopPadding + weightChartHeight }]}>
                    {weightAxisEntries.map((entry, index) => {
                      const top =
                        weightChartTopPadding +
                        weightChartHeight -
                        ((entry.value - weightChartMin) / weightChartRange) * weightChartHeight -
                        9;
                      return (
                        <View key={`${entry.value}-${index}`} style={[styles.myDayWeightAxisEntry, { top }]}>
                          {entry.goal ? (
                            <MaterialIcons name="flag-circle" size={12} color={cta} style={{ marginRight: 4 }} />
                          ) : null}
                          <Text
                            style={[
                              styles.myDayWeightAxisLabel,
                              { color: entry.goal ? cta : subText, fontWeight: entry.goal ? "800" : "600" },
                            ]}
                          >
                            {entry.value.toFixed(1)}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.myDayWeightChartScroll}>
                    <View
                      style={[
                        styles.myDayWeightChartCanvas,
                        { width: weightChartWidth, height: weightChartHeight + weightChartTopPadding + 30 },
                      ]}
                    >
                      {[0, 0.5, 1].map((ratio) => (
                        <View
                          key={`my-day-grid-${ratio}`}
                          style={[
                            styles.myDayWeightGridLine,
                            {
                              top: weightChartTopPadding + weightChartHeight - weightChartHeight * ratio,
                              borderColor: `${border}88`,
                            },
                          ]}
                        />
                      ))}
                      {weightGoalLineY !== null ? (
                        <View
                          style={[
                            styles.myDayWeightGoalGuide,
                            { top: weightGoalLineY, borderColor: weightGoalLineColor },
                          ]}
                        />
                      ) : null}
                      <Canvas
                        style={[
                          styles.myDayWeightCanvasOverlay,
                          { width: weightChartWidth, height: weightChartHeight + weightChartTopPadding + 30 },
                        ]}
                      >
                        {weightAreaSkPath ? <SkiaPath path={weightAreaSkPath} color={weightChartFillColor} /> : null}
                        {weightTrendSkPath ? (
                          <SkiaPath
                            path={weightTrendSkPath}
                            color={cta}
                            style="stroke"
                            strokeWidth={3.5}
                            strokeCap="round"
                            strokeJoin="round"
                          />
                        ) : null}
                      </Canvas>
                      {weightActualPoints.map((point) => {
                        const pointLabelWidth = chartPointLabelWidth(point.value);
                        return (
                        <View
                          key={point.id}
                          style={[
                            styles.myDayWeightPointWrap,
                            {
                              width: pointLabelWidth,
                              left: Math.min(
                                weightChartWidth - pointLabelWidth,
                                Math.max(0, point.x - pointLabelWidth / 2)
                              ),
                              top: point.y - 26,
                            },
                          ]}
                        >
                          <Text style={[styles.myDayWeightPointLabel, { color: text }]}>{point.value}</Text>
                          <View
                            style={[
                              styles.myDayWeightPoint,
                              {
                                backgroundColor: bg,
                                borderColor: primary,
                              },
                            ]}
                          />
                        </View>
                        );
                      })}
                      <View style={[styles.myDayWeightXAxis, { borderColor: border }]} />
                      {weightActualPoints.map((point, index) => {
                        const showLabel =
                          index === 0 ||
                          index === weightActualPoints.length - 1 ||
                          index === Math.floor((weightActualPoints.length - 1) / 2);
                        if (!showLabel) return null;
                        return (
                          <Text
                            key={`my-day-date-${point.id}`}
                            style={[
                              styles.myDayWeightDateLabel,
                              { color: subText, left: Math.max(0, point.x - 22) },
                            ]}
                          >
                            {new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(
                              new Date(point.createdAt)
                            )}
                          </Text>
                        );
                      })}
                    </View>
                  </ScrollView>
                </View>
              </View>
            </>
          )}
        </AppCard>
      </ScrollView>

      <View pointerEvents="box-none" style={styles.floatingActionsWrap}>
        <View style={styles.floatingActions}>
          <TouchableOpacity
            activeOpacity={0.88}
            style={[styles.floatingWeightButton, { backgroundColor: cta }]}
            onPress={openWeightLogger}
          >
            <MaterialIcons name="monitor-weight" size={16} color="#fff" />
            <Text style={styles.floatingWeightText}>
              {t("my_day.log_weight", { defaultValue: "Weight" })}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.9}
            style={[styles.floatingAddMealButton, { backgroundColor: cta }]}
            onPress={() => setAddMealFlowVisible(true)}
          >
            <MaterialIcons name="add" size={20} color="#fff" />
            <Text style={styles.floatingActionText}>
              {t("my_day.add_meal_cta", { defaultValue: "Add meal" })}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <MyDayAddMealFlow
        visible={addMealFlowVisible}
        targetDate={new Date()}
        cookieBalance={cookieBalance}
        freePremiumActionsRemaining={freePremiumActionsRemaining}
        onClose={() => setAddMealFlowVisible(false)}
        onSaved={refreshDay}
      />

      <MyDayMealEditorModal
        visible={editMealVisible && !!mealDraft}
        onClose={() => setEditMealVisible(false)}
        modalBackdrop={modalBackdrop}
        card={card}
        border={border}
        bg={bg}
        text={text}
        subText={subText}
        cta={cta}
        headingLabel={t("my_day.edit_meal_title", { defaultValue: "Edit meal" })}
        titleLabel={t("recipes.title", { defaultValue: "Title" })}
        titleValue={mealDraft?.title ?? ""}
        onChangeTitle={(value) => setMealDraft((prev) => (prev ? { ...prev, title: value } : prev))}
        mealDetailsStepLabel={t("my_day.meal_details", { defaultValue: "Meal details" })}
        nutritionStepLabel={t("my_day.meal_nutrition", { defaultValue: "Meal nutrition" })}
        quantitiesLabel={t("my_day.quantities", { defaultValue: "Quantities" })}
        visibleIngredients={visibleMealEditIngredients.map(({ item, index }) => ({
          index,
          key: `${item.name}-${index}`,
          name: item.name,
          quantity: quantityForDisplay(item.quantity, item.unit, healthMeasurement),
          unitLabel: normalizeReviewUnitLabel(unitForDisplay(item.unit, healthMeasurement)),
        }))}
        allIngredientsCount={mealEditIngredients.length}
        onChangeIngredientQuantity={(index, value) =>
          updateIngredientDisplayQuantity(
            mealEditIngredients,
            setMealEditIngredients,
            mealEditNutritionMode === "auto" ? mealDraftBase : null,
            mealEditIngredientBase,
            setMealDraft,
            index,
            value
          )
        }
        onRemoveIngredient={(index) =>
          removeReviewIngredient(
            setMealEditIngredients,
            mealEditNutritionMode === "auto" ? mealDraftBase : null,
            mealEditIngredientBase,
            setMealDraft,
            index
          )
        }
        emptyIngredientsText={t("my_day.review_need_ingredient", {
          defaultValue: "Add at least one ingredient before saving.",
        })}
        showAllIngredients={mealEditShowAllIngredients}
        showIngredientsToggle={mealEditIngredients.length > REVIEW_DEFAULT_VISIBLE_COUNT}
        onToggleShowAllIngredients={() => setMealEditShowAllIngredients((prev) => !prev)}
        showAllIngredientsText={t("my_day.review_show_all", {
          defaultValue: "Show all {{count}} ingredients",
          count: mealEditIngredients.length,
        })}
        showFewerIngredientsText={t("my_day.review_show_less", { defaultValue: "Show fewer ingredients" })}
        addIngredientPlaceholder={t("my_day.add_ingredient", { defaultValue: "Add ingredient" })}
        newIngredientName={mealEditNewIngredientName}
        onChangeNewIngredientName={(value) => setMealEditNewIngredientName(sanitizeIngredientNameInput(value))}
        newIngredientQuantity={mealEditNewIngredientQuantity}
        onChangeNewIngredientQuantity={(value) => setMealEditNewIngredientQuantity(sanitizePositiveDecimalInput(value))}
        newIngredientUnitLabel={normalizeReviewUnitLabel(unitForDisplay(mealEditNewIngredientUnit, healthMeasurement))}
        unitDropdownOpen={mealEditUnitDropdownOpen}
        onToggleUnitDropdown={() => setMealEditUnitDropdownOpen((prev) => !prev)}
        unitOptions={reviewUnitOptions}
        selectedUnitValue={mealEditNewIngredientUnit}
        onSelectUnit={(value) => {
          setMealEditNewIngredientUnit(value);
          setMealEditUnitDropdownOpen(false);
        }}
        onAddIngredient={() => {
          addReviewIngredient(
            normalizeNewReviewIngredient(
              mealEditNewIngredientName,
              quantityFromDisplay(mealEditNewIngredientQuantity, mealEditNewIngredientUnit, healthMeasurement),
              mealEditNewIngredientUnit
            ),
            setMealEditIngredients,
            mealEditNutritionMode === "auto" ? mealDraftBase : null,
            mealEditIngredientBase,
            setMealDraft
          );
          setMealEditNewIngredientName("");
          setMealEditNewIngredientQuantity("");
          setMealEditUnitDropdownOpen(false);
        }}
        nutritionLabel={t("my_day.meal_nutrition", { defaultValue: "Meal nutrition" })}
        nutritionHintAuto={t("my_day.meal_nutrition_hint_auto", {
          defaultValue: "Nutrition is being calculated automatically from the ingredient list.",
        })}
        nutritionHintManual={t("my_day.meal_nutrition_hint_manual", {
          defaultValue: "Manual mode lets you override the nutrition values for this meal.",
        })}
        nutritionMode={mealEditNutritionMode}
        onChangeNutritionMode={handleMealEditNutritionModeChange}
        nutritionFields={[
          {
            key: "calories",
            label: t("profile.health_calories", { defaultValue: "Calories" }),
            value: mealDraft ? `${Math.round(parseNumber(mealDraft.calories, 0))}` : "0",
            unit: "kcal",
            onChange: (value) =>
              setMealDraft((prev) => (prev ? { ...prev, calories: sanitizePositiveDecimalInput(value) } : prev)),
          },
          {
            key: "protein",
            label: t("my_day.protein"),
            value: mealDraft
              ? mealEditNutritionMode === "manual"
                ? mealDraft.protein
                : `${nutrientValueForDisplay(parseNumber(mealDraft.protein, 0), healthMeasurement)}`
              : "0",
            unit: nutrientUnit,
            onChange: (value) =>
              setMealDraft((prev) => (prev ? { ...prev, protein: sanitizePositiveDecimalInput(value) } : prev)),
          },
          {
            key: "carbs",
            label: t("my_day.carbs"),
            value: mealDraft
              ? mealEditNutritionMode === "manual"
                ? mealDraft.carbs
                : `${nutrientValueForDisplay(parseNumber(mealDraft.carbs, 0), healthMeasurement)}`
              : "0",
            unit: nutrientUnit,
            onChange: (value) =>
              setMealDraft((prev) => (prev ? { ...prev, carbs: sanitizePositiveDecimalInput(value) } : prev)),
          },
          {
            key: "fat",
            label: t("my_day.fat"),
            value: mealDraft
              ? mealEditNutritionMode === "manual"
                ? mealDraft.fat
                : `${nutrientValueForDisplay(parseNumber(mealDraft.fat, 0), healthMeasurement)}`
              : "0",
            unit: nutrientUnit,
            onChange: (value) =>
              setMealDraft((prev) => (prev ? { ...prev, fat: sanitizePositiveDecimalInput(value) } : prev)),
          },
        ]}
        autoLabel={t("profile.health_plan_auto", { defaultValue: "Automatic" })}
        manualLabel={t("profile.health_plan_manual", { defaultValue: "Manual" })}
        cancelLabel={t("common.cancel")}
        backLabel={t("common.back", { defaultValue: "Back" })}
        nextLabel={t("common.next", { defaultValue: "Next" })}
        saveLabel={
          mealEditSaveInFlight
            ? t("common.saving", { defaultValue: "Saving..." })
            : t("common.save", { defaultValue: "Save" })
        }
        onSave={handleSaveMealEdit}
        saveDisabled={mealEditIngredients.length === 0 || mealEditSaveInFlight}
      />

      <Modal
        visible={firstUsePromptVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setFirstUsePromptVisible(false)}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: modalBackdrop }]}
          onPress={() => {
            setFirstUsePromptDismissedThisSession(true);
            setFirstUsePromptVisible(false);
          }}
        >
          <View
            style={[styles.firstUseCard, { backgroundColor: card, borderColor: border }]}
            onStartShouldSetResponder={() => true}
          >
            <Text style={[styles.firstUseTitle, { color: text }]}>
              {t("my_day.first_use_title", { defaultValue: "Set up My Day" })}
            </Text>
            <Text style={[styles.firstUseBody, { color: subText }]}>
              {t("my_day.first_use_body", {
                defaultValue: "Add your health goals in Profile to unlock calorie targets, macro targets, and better insights.",
              })}
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                activeOpacity={0.85}
                style={[styles.secondaryButton, { borderColor: border, backgroundColor: bg }]}
                onPress={() => {
                  setFirstUsePromptDismissedThisSession(true);
                  setFirstUsePromptVisible(false);
                }}
              >
                <Text style={[styles.secondaryButtonText, { color: text }]}>
                  {t("common.later", { defaultValue: "Later" })}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.85}
                style={[styles.primaryButton, { backgroundColor: cta }]}
                onPress={() => {
                  setFirstUsePromptDismissedThisSession(true);
                  setFirstUsePromptVisible(false);
                  openHealthGoals();
                }}
              >
                <Text style={styles.primaryButtonText}>
                  {t("my_day.setup_now", { defaultValue: "Set up now" })}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      <Modal
        visible={weightModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setWeightModalVisible(false)}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: modalBackdrop }]}
          onPress={() => setWeightModalVisible(false)}
        >
          <KeyboardAvoidingView
            style={styles.weightModalKeyboard}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 20}
          >
            <View
              style={[styles.weightModalCard, { backgroundColor: card, borderColor: border }]}
              onStartShouldSetResponder={() => true}
            >
              <View style={styles.weightModalHeader}>
                <Text style={[styles.firstUseTitle, { color: text, marginBottom: 0 }]}>
                  {t("my_day.log_weight", { defaultValue: "Log weight" })}
                </Text>
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => setWeightModalVisible(false)}
                  hitSlop={10}
                >
                  <MaterialIcons name="close" size={22} color={subText} />
                </TouchableOpacity>
              </View>
              <Text style={[styles.modalHelp, { color: subText }]}>
                {t("my_day.weight_modal_hint", {
                  defaultValue: "Add your weight and pick the date you want to track.",
                })}
              </Text>

              <Text style={[styles.weightFieldLabel, { color: subText }]}>
                {t("my_day.weight_value", { defaultValue: "Weight" })}
              </Text>
              <View style={styles.weightValueRow}>
                <TextInput
                  value={weightInput}
                  onChangeText={(value) => setWeightInput(sanitizeWeightInput(value))}
                  keyboardType="decimal-pad"
                  placeholder={healthMeasurement === "US" ? "165" : "72"}
                  placeholderTextColor={subText}
                  style={[
                    styles.modalInputSmall,
                    styles.weightValueInput,
                    { color: text, borderColor: border, backgroundColor: bg },
                  ]}
                />
                <Text style={[styles.weightUnitText, { color: text }]}>{weightUnit}</Text>
              </View>

              <Text style={[styles.weightFieldLabel, { color: subText }]}>
                {t("my_day.date", { defaultValue: "Date" })}
              </Text>
              <TouchableOpacity
                activeOpacity={0.85}
                style={[styles.weightDateButton, { borderColor: border, backgroundColor: bg }]}
                onPress={() => {
                  const [year, month] = displayedWeightDay.split("-").map(Number);
                  setWeightCalendarMonth(new Date(year, month - 1, 1));
                  setWeightCalendarVisible(true);
                }}
              >
                <Text style={[styles.weightDateText, { color: text }]}>{displayedWeightDay}</Text>
                <MaterialIcons name="calendar-today" size={18} color={subText} />
              </TouchableOpacity>

              <View style={styles.modalActions}>
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[styles.secondaryButton, { borderColor: border, backgroundColor: bg }]}
                  onPress={() => setWeightModalVisible(false)}
                >
                  <Text style={[styles.secondaryButtonText, { color: text }]}>
                    {t("common.cancel", { defaultValue: "Cancel" })}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[
                    styles.primaryButton,
                    { backgroundColor: cta, opacity: Number(weightInput.replace(",", ".")) > 0 ? 1 : 0.55 },
                  ]}
                  disabled={!(Number(weightInput.replace(",", ".")) > 0)}
                  onPress={handleSaveWeightFromMyDay}
                >
                  <Text style={styles.primaryButtonText}>{t("common.save", { defaultValue: "Save" })}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      <Modal
        visible={weightCalendarVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setWeightCalendarVisible(false)}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: modalBackdrop }]}
          onPress={() => setWeightCalendarVisible(false)}
        >
          <View
            style={[styles.calendarModalCard, { backgroundColor: card, borderColor: border }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.calendarHeaderRow}>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() =>
                  setWeightCalendarMonth(
                    new Date(weightCalendarMonth.getFullYear(), weightCalendarMonth.getMonth() - 1, 1)
                  )
                }
              >
                <MaterialIcons name="chevron-left" size={24} color={primary} />
              </TouchableOpacity>
              <Text style={[styles.calendarTitleText, { color: text }]}>{weightMonthLabel}</Text>
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={
                  weightCalendarMonth.getFullYear() >= new Date().getFullYear() &&
                  weightCalendarMonth.getMonth() >= new Date().getMonth()
                }
                onPress={() =>
                  setWeightCalendarMonth(
                    new Date(weightCalendarMonth.getFullYear(), weightCalendarMonth.getMonth() + 1, 1)
                  )
                }
              >
                <MaterialIcons
                  name="chevron-right"
                  size={24}
                  color={
                    weightCalendarMonth.getFullYear() >= new Date().getFullYear() &&
                    weightCalendarMonth.getMonth() >= new Date().getMonth()
                      ? subText
                      : primary
                  }
                />
              </TouchableOpacity>
            </View>
            <View style={styles.calendarWeekRow}>
              {["S", "M", "T", "W", "T", "F", "S"].map((label, index) => (
                <Text key={`${label}-${index}`} style={[styles.calendarWeekday, { color: subText }]}>
                  {label}
                </Text>
              ))}
            </View>
            <View style={styles.calendarGrid}>
              {weightCalendarCells.map((day, index) => {
                const value =
                  day == null
                    ? null
                    : `${weightCalendarMonth.getFullYear()}-${`${weightCalendarMonth.getMonth() + 1}`.padStart(
                        2,
                        "0"
                      )}-${`${day}`.padStart(2, "0")}`;
                const todayKey = getWeightDayKey(new Date());
                const isSelected = value === displayedWeightDay;
                const isFuture = !!value && value > todayKey;
                return (
                  <TouchableOpacity
                    key={`${value ?? "empty"}-${index}`}
                    activeOpacity={0.85}
                    disabled={day == null || isFuture}
                    style={[
                      styles.calendarCell,
                      isSelected && { backgroundColor: cta },
                      day == null && { opacity: 0 },
                      isFuture && { opacity: 0.35 },
                    ]}
                    onPress={() => {
                      if (!value || isFuture) return;
                      setSelectedWeightDay(value);
                      setWeightCalendarVisible(false);
                    }}
                  >
                    <Text style={{ color: isSelected ? "#fff" : text, fontWeight: "600" }}>{day ?? ""}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </Pressable>
      </Modal>

      <HealthGoalsEditorModal
        visible={healthGoalsVisible}
        draft={healthDraft}
        measurement={healthMeasurement}
        planMode={healthPlanMode}
        onClose={() => setHealthGoalsVisible(false)}
        onSave={saveHealthGoalsFromMyDay}
        onUpdateField={updateHealthDraft}
        onUpdatePlan={updateHealthPlan}
        onPlanModeChange={(nextMode) => {
          setHealthPlanMode(nextMode);
          if (nextMode === "auto") {
            setHealthDraft((prev) => {
              if (!prev) return prev;
              const nextPlan = deriveSuggestedPlan(prev, healthMeasurement);
              return { ...prev, plan: nextPlan ?? prev.plan, isCustomizedPlan: false };
            });
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    padding: 14,
    paddingBottom: 106,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    gap: 12,
  },
  headerChips: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerTitleWrap: {
    flex: 1,
  },
  kicker: {
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 2,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
  },
  headerHistoryChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  headerHistoryText: {
    fontSize: 12,
    fontWeight: "700",
  },
  summaryCard: {
    marginBottom: 12,
    paddingBottom: 12,
  },
  summaryTopRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  summaryPrimary: {
    flex: 1,
  },
  summaryNumber: {
    fontSize: 30,
    fontWeight: "800",
    lineHeight: 32,
  },
  summaryLabel: {
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 16,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  summaryTarget: {
    alignItems: "flex-end",
    flexShrink: 1,
    maxWidth: "48%",
  },
  summaryTargetNumber: {
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 22,
  },
  summaryTargetMissing: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 17,
    textAlign: "right",
  },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
  },
  summaryMetaRow: {
    alignItems: "flex-end",
    marginBottom: 2,
  },
  remainingText: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
    textAlign: "right",
  },
  weightProgressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-end",
    marginBottom: 10,
  },
  weightProgressPrimary: {
    flex: 1,
  },
  weightProgressGoal: {
    alignItems: "flex-end",
  },
  weightSummaryLabel: {
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  weightHeroValue: {
    fontSize: 28,
    fontWeight: "800",
    lineHeight: 30,
  },
  weightGoalValue: {
    fontSize: 18,
    fontWeight: "800",
  },
  weightProgressTrack: {
    height: 12,
    borderRadius: 999,
    overflow: "hidden",
    marginBottom: 10,
  },
  weightProgressFill: {
    height: "100%",
    borderRadius: 999,
  },
  weightProgressMetaRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  weightProgressMeta: {
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 16,
    flexShrink: 1,
  },
  weightProgressUpdatedAt: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
    marginBottom: 10,
  },
  myDayWeightChartSection: {
    marginTop: 4,
  },
  myDayWeightChartFrame: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 4,
  },
  myDayWeightYAxis: {
    width: 40,
    position: "relative",
    height: 152,
  },
  myDayWeightAxisLabel: {
    fontSize: 10,
    fontWeight: "600",
  },
  myDayWeightAxisEntry: {
    position: "absolute",
    left: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  myDayWeightChartScroll: {
    paddingRight: 8,
  },
  myDayWeightChartCanvas: {
    position: "relative",
    marginBottom: 8,
  },
  myDayWeightCanvasOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
  },
  myDayWeightGridLine: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  myDayWeightGoalGuide: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopWidth: 1.5,
    borderStyle: "dashed",
  },
  myDayWeightPointWrap: {
    position: "absolute",
    width: 56,
    alignItems: "center",
  },
  myDayWeightPointLabel: {
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 4,
  },
  myDayWeightPoint: {
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 2,
  },
  myDayWeightXAxis: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  myDayWeightDateLabel: {
    position: "absolute",
    bottom: 0,
    fontSize: 10,
    fontWeight: "600",
  },
  macrosInline: {
    flexDirection: "row",
    gap: 16,
    marginTop: 12,
  },
  macroCompact: {
    flex: 1,
    minWidth: 0,
  },
  macroCompactHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 4,
    marginBottom: 6,
  },
  macroCompactLabel: {
    fontSize: 12,
    fontWeight: "700",
    flexShrink: 0,
  },
  macroCompactAmount: {
    fontSize: 10,
    flexShrink: 1,
    textAlign: "right",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  sectionMeta: {
    fontSize: 12,
    fontWeight: "600",
  },
  macroTrack: {
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
  },
  macroFill: {
    height: "100%",
    borderRadius: 999,
  },
  mealRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  mealRowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  mealCardContent: {
    flex: 1,
    position: "relative",
    gap: 8,
  },
  mealCardContentCompact: {},
  mealTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  mealInfo: {
    flex: 1,
    paddingRight: 66,
  },
  mealTitle: {
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 19,
  },
  mealMacroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    flexWrap: "wrap",
  },
  mealMacroSimple: {
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
  mealActions: {
    position: "absolute",
    top: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  mealActionButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  mealSourceSquare: {
    width: 54,
    height: 54,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  mealSourceImage: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
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
  insightRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 6,
    marginBottom: 8,
  },
  insightText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  linkText: {
    fontSize: 13,
    fontWeight: "700",
  },
  trendBars: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    height: 104,
    marginBottom: 10,
  },
  trendBarColumn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
  },
  trendBarTrack: {
    width: "78%",
    flex: 1,
    position: "relative",
    borderRadius: 10,
    justifyContent: "flex-end",
    marginBottom: 6,
  },
  trendGoalBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    width: "100%",
    borderRadius: 10,
  },
  trendBarFill: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    width: "100%",
    borderRadius: 10,
  },
  trendBarStatusDash: {
    position: "absolute",
    alignSelf: "center",
    top: "45%",
    fontSize: 12,
    fontWeight: "800",
  },
  trendBarLabel: {
    fontSize: 10,
    fontWeight: "700",
    lineHeight: 13,
  },
  trendLegend: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  trendStatsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 10,
  },
  trendAverageLabel: {
    textTransform: "uppercase",
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: 3,
  },
  trendStatBlock: {
    flex: 1,
  },
  trendStatBlockRight: {
    alignItems: "flex-end",
  },
  trendStatValue: {
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 2,
  },
  trendStatValueLarge: {
    fontSize: 20,
  },
  trendStatLabel: {
    fontSize: 12,
    lineHeight: 16,
  },
  trendText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  floatingActionsWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 16,
    paddingHorizontal: 14,
  },
  floatingActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 10,
  },
  floatingWeightButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
  },
  floatingWeightText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
  floatingAddMealButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
  },
  floatingActionText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
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
  weightModalKeyboard: {
    width: "100%",
    alignItems: "center",
  },
  weightModalCard: {
    width: "92%",
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
  },
  weightModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  weightFieldLabel: {
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  weightValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 14,
  },
  weightValueInput: {
    flex: 1,
  },
  weightUnitText: {
    minWidth: 28,
    fontSize: 15,
    fontWeight: "800",
  },
  weightDateButton: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  weightDateText: {
    fontSize: 14,
    fontWeight: "700",
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
  modalInputSmall: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  modalDateButton: {
    justifyContent: "center",
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
  loadingButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  recipeList: {
    maxHeight: 340,
  },
  recipeListLoading: {
    minHeight: 150,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  filterCard: {
    width: "90%",
    maxHeight: "78%",
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
  },
  recipeSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    marginBottom: 8,
  },
  recipeSearchInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
  },
  recipeSearchInputInline: {
    flex: 1,
    marginTop: 0,
    marginBottom: 0,
  },
  recipeFilterButton: {
    width: 46,
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  recipeFilterBadge: {
    position: "absolute",
    top: -5,
    right: -5,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  recipeFilterBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
  },
  recipeFilterSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
    gap: 12,
  },
  recipeFilterSummaryText: {
    flex: 1,
    fontSize: 12,
  },
  recipeFilterClearText: {
    fontSize: 12,
    fontWeight: "700",
  },
  recipeFilterSearchInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 10,
  },
  recipeFilterEmptyText: {
    fontSize: 13,
    marginTop: 2,
    marginBottom: 4,
  },
  recipeFilterMoreButton: {
    alignSelf: "flex-start",
    paddingVertical: 6,
  },
  recipeFilterMoreText: {
    fontSize: 13,
    fontWeight: "700",
  },
  recipeCountText: {
    fontSize: 12,
    marginBottom: 10,
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
    paddingRight: 12,
  },
  recipeTitle: {
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 6,
  },
  recipeMeta: {
    fontSize: 12,
    lineHeight: 17,
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
  recipeLoadMoreButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  recipeLoadMoreText: {
    fontSize: 13,
    fontWeight: "700",
  },
  formRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 10,
  },
  formHalf: {
    flex: 1,
  },
  formThird: {
    flex: 1,
  },
  inlineChipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 10,
  },
  inlineChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  inlineChipText: {
    fontSize: 13,
    fontWeight: "600",
  },
  planPanel: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginTop: 4,
    marginBottom: 10,
  },
  formLabelCompact: {
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  editMealScrollContent: {
    paddingBottom: 4,
  },
  ingredientsWrap: {
    marginTop: 12,
  },
  ingredientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
  },
  ingredientName: {
    flex: 1.2,
    fontSize: 13,
    fontWeight: "600",
  },
  ingredientInput: {
    width: 72,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
    textAlign: "center",
    transform: [{ translateX: -8 }],
  },
  ingredientInputEditable: {
    borderWidth: 1,
  },
  mealTitleInput: {
    paddingHorizontal: 12,
    width: "100%",
    textAlign: "left",
    transform: [{ translateX: 0 }],
  },
  editMealNutritionWrap: {
    marginTop: 10,
    marginBottom: 12,
  },
  editMealNutritionHint: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  editMealModeWrap: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
    marginBottom: 10,
  },
  editMealModeButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  editMealNutritionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  editMealNutritionCardAuto: {
    minHeight: 58,
    justifyContent: "center",
  },
  editMealNutritionCard: {
    width: "48.5%",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  editMealNutritionLabel: {
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 4,
  },
  editMealNutritionValue: {
    fontSize: 16,
    fontWeight: "700",
  },
  editMealNutritionInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  ingredientUnitBadge: {
    minWidth: 58,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  ingredientUnitBadgeText: {
    fontSize: 13,
    fontWeight: "600",
  },
  ingredientUnitText: {
    minWidth: 44,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "left",
  },
  ingredientRemoveButton: {
    width: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  reviewComposer: {
    marginTop: 6,
  },
  reviewComposerNameInput: {
    flex: 1.2,
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 10,
    fontSize: 13,
    fontWeight: "500",
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  reviewComposerControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    width: "100%",
  },
  reviewComposerQuantityInput: {
    width: 72,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
    textAlign: "center",
    marginLeft: "auto",
  },
  reviewComposerUnitButton: {
    width: 52,
    borderRadius: 10,
    paddingHorizontal: 2,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 1,
    transform: [{ translateX: 8 }],
  },
  reviewComposerUnitText: {
    fontSize: 13,
    fontWeight: "600",
    textAlign: "left",
  },
  reviewComposerAddButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: "auto",
  },
  reviewUnitDropdown: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  reviewUnitDropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  reviewUnitDropdownText: {
    fontSize: 13,
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
  reviewToggleButton: {
    marginTop: 6,
    alignSelf: "flex-start",
  },
  reviewToggleText: {
    fontSize: 13,
    fontWeight: "700",
  },
  ingredientUnitInput: {
    width: 58,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
    textAlign: "center",
  },
  firstUseCard: {
    width: "88%",
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
  },
  firstUseTitle: {
    fontSize: 20,
    fontWeight: "800",
    marginBottom: 8,
  },
  firstUseBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  calendarModalCard: {
    width: "86%",
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
  },
  calendarHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  calendarTitleText: {
    fontSize: 16,
    fontWeight: "800",
  },
  calendarWeekRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  calendarWeekday: {
    width: "14.2%",
    textAlign: "center",
    fontSize: 12,
    fontWeight: "700",
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  calendarCell: {
    width: "14.2%",
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    marginBottom: 6,
  },
});
