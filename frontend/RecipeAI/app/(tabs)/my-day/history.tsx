import React, { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { MaterialIcons } from "@expo/vector-icons";

import AppCard from "../../../components/AppCard";
import MyDayAddMealFlow from "../../../components/MyDayAddMealFlow";
import MyDayMealEditorModal from "../../../components/MyDayMealEditorModal";
import { useThemeColors } from "../../../context/ThemeContext";
import {
  loadMyDayMeals,
  getDayKey,
  MyDayMealIngredient,
  MyDayMealSource,
  removeMeal,
  resolveStructuredMealEstimate,
  updateMeal,
} from "../../../lib/myDayMeals";
import { loadMeasurementSystemPreference, MeasurementSystem } from "../../../lib/myDay";
import { loadSavedRecipes, SavedRecipe } from "../../../lib/myDayRecipes";

type DaySummary = {
  dayKey: string;
  title: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  count: number;
  meals: {
    id: string;
    source: MyDayMealSource;
    title: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    photoUri?: string;
    recipeId?: string;
    ingredients: MyDayMealIngredient[];
  }[];
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

function formatDayLabel(dayKey: string, locale: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const formatted = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
  return formatted.charAt(0).toLocaleUpperCase(locale) + formatted.slice(1);
}

function capitalizeFirst(value: string, locale: string) {
  if (!value) return value;
  return value.charAt(0).toLocaleUpperCase(locale) + value.slice(1);
}

function parseDayKey(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function addDaysToKey(dayKey: string, offset: number) {
  const date = parseDayKey(dayKey);
  date.setDate(date.getDate() + offset);
  return getDayKey(date);
}

function clampDayKeyToToday(dayKey: string | null | undefined, todayKey: string) {
  if (!dayKey) return todayKey;
  return dayKey > todayKey ? todayKey : dayKey;
}

function parseNumber(value: string | number | null | undefined, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
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

function unitForDisplay(unit: string, measurement: MeasurementSystem) {
  if (measurement !== "US") return unit;
  if (unit === "g") return "oz";
  if (unit === "ml") return "fl oz";
  return unit;
}

function normalizeReviewUnitLabel(unit: string) {
  if (unit === "un") return "un";
  return unit;
}

function quantityForDisplay(quantity: string, unit: string, measurement: MeasurementSystem) {
  const parsed = parseNumber(quantity, NaN);
  if (!Number.isFinite(parsed) || measurement !== "US") return quantity;
  if (unit === "g") return String(Number((parsed / 28.3495).toFixed(2)));
  if (unit === "ml") return String(Number((parsed / 29.5735).toFixed(2)));
  return quantity;
}

function quantityFromDisplay(quantity: string, storedUnit: string, measurement: MeasurementSystem) {
  const parsed = parseNumber(quantity, NaN);
  if (!Number.isFinite(parsed) || measurement !== "US") return quantity;
  if (storedUnit === "g") return String(Number((parsed * 28.3495).toFixed(2)));
  if (storedUnit === "ml") return String(Number((parsed * 29.5735).toFixed(2)));
  return quantity;
}

function nutrientUnitForDisplay(measurement: MeasurementSystem) {
  return measurement === "US" ? "oz" : "g";
}

function nutrientValueForDisplay(value: number, measurement: MeasurementSystem) {
  if (measurement !== "US") return `${Math.round(value)}`;
  return `${Number((value / 28.3495).toFixed(1))}`;
}

function getReviewUnitOptions(measurement: MeasurementSystem): ReviewUnitOption[] {
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

function quantityFactor(quantity: string, unit: string) {
  const parsed = parseNumber(quantity, 0);
  if (!parsed) return 0;
  switch (unit) {
    case "g":
      return parsed / 100;
    case "ml":
      return parsed / 100;
    case "tbsp":
      return parsed * 0.15;
    case "tsp":
      return parsed * 0.05;
    default:
      return parsed;
  }
}

function recomputeTotals(base: EditableTotals, baseIngredients: ReviewIngredient[], ingredients: ReviewIngredient[]): EditableTotals {
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

function sanitizeReviewIngredient(item: ReviewIngredient): ReviewIngredient | null {
  const name = sanitizeIngredientNameInput(item.name).trim();
  const quantity = sanitizePositiveDecimalInput(item.quantity);
  const unit = ["g", "ml", "tbsp", "tsp", "un"].includes(item.unit) ? item.unit : "g";
  if (!name || !quantity || parseNumber(quantity, 0) <= 0) return null;
  return { name, quantity, unit };
}

function sanitizeReviewIngredients(items: ReviewIngredient[]) {
  return items.map(sanitizeReviewIngredient).filter(Boolean) as ReviewIngredient[];
}

function normalizeNewReviewIngredient(name: string, quantity: string, unit: string): ReviewIngredient | null {
  return sanitizeReviewIngredient({ name, quantity, unit });
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

export default function MyDayHistoryScreen() {
  const { t, i18n } = useTranslation();
  const { bg, text, subText, border, cta, card, modalBackdrop, primary, isDark } = useThemeColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ day?: string }>();
  const todayKey = getDayKey(new Date());
  const [days, setDays] = useState<DaySummary[]>([]);
  const [savedRecipes, setSavedRecipes] = useState<SavedRecipe[]>([]);
  const [selectedDayKey, setSelectedDayKey] = useState(() =>
    clampDayKeyToToday(typeof params.day === "string" ? params.day : null, todayKey)
  );
  const [healthMeasurement, setHealthMeasurement] = useState<MeasurementSystem>("Metric");
  const [editingMealId, setEditingMealId] = useState<string | null>(null);
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
  const [calendarVisible, setCalendarVisible] = useState(false);
  const [addMealFlowVisible, setAddMealFlowVisible] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const initialDay = parseDayKey(clampDayKeyToToday(typeof params.day === "string" ? params.day : null, todayKey));
    return new Date(initialDay.getFullYear(), initialDay.getMonth(), 1);
  });

  const locale = useMemo(() => (i18n.language === "pt" ? "pt-PT" : i18n.language || "en"), [i18n.language]);
  const nutrientUnit = nutrientUnitForDisplay(healthMeasurement);
  const reviewUnitOptions = useMemo(() => getReviewUnitOptions(healthMeasurement), [healthMeasurement]);
  const interactiveIconColor = isDark ? "#fff" : primary;
  const currentMonthStart = useMemo(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  }, []);

  const dayByKey = useMemo(() => new Map(days.map((day) => [day.dayKey, day])), [days]);
  const savedRecipeById = useMemo(() => {
    const map = new Map<string, SavedRecipe>();
    savedRecipes.forEach((recipe) => {
      map.set(recipe.id, recipe);
    });
    return map;
  }, [savedRecipes]);
  const selectedDay =
    dayByKey.get(selectedDayKey) || {
      dayKey: selectedDayKey,
      title: formatDayLabel(selectedDayKey, locale),
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      count: 0,
      meals: [],
    };
  const selectedDayMacroLine = useMemo(
    () =>
      [
        `${t("my_day.protein", { defaultValue: "Protein" })} ${nutrientValueForDisplay(selectedDay.protein, healthMeasurement)}${nutrientUnit}`,
        `${t("my_day.carbs", { defaultValue: "Carbs" })} ${nutrientValueForDisplay(selectedDay.carbs, healthMeasurement)}${nutrientUnit}`,
        `${t("my_day.fat", { defaultValue: "Fat" })} ${nutrientValueForDisplay(selectedDay.fat, healthMeasurement)}${nutrientUnit}`,
      ].join(" · "),
    [healthMeasurement, nutrientUnit, selectedDay.carbs, selectedDay.fat, selectedDay.protein, t]
  );
  const mealDayKeys = useMemo(() => new Set(days.map((day) => day.dayKey)), [days]);
  const calendarMonthLabel = useMemo(
    () => capitalizeFirst(new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(calendarMonth), locale),
    [calendarMonth, locale]
  );
  const calendarCells = useMemo(() => {
    const monthStartWeekday = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1).getDay();
    const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
    const cells = [
      ...Array.from({ length: monthStartWeekday }, () => null),
      ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
    ];
    return [...cells, ...Array.from({ length: Math.max(0, 42 - cells.length) }, () => null)];
  }, [calendarMonth]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      (async () => {
        const [meals, measurement, recipes] = await Promise.all([
          loadMyDayMeals(),
          loadMeasurementSystemPreference(),
          loadSavedRecipes(),
        ]);
        setHealthMeasurement(measurement);
        const grouped = new Map<string, DaySummary>();

        for (const meal of meals) {
          const current = grouped.get(meal.dayKey) || {
            dayKey: meal.dayKey,
            title: formatDayLabel(meal.dayKey, locale),
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
            count: 0,
            meals: [],
          };

          current.calories += meal.calories;
          current.protein += meal.protein;
          current.carbs += meal.carbs;
          current.fat += meal.fat;
          current.count += 1;
          current.meals.push({
            id: meal.id,
            source: meal.source,
            title: meal.title,
            calories: meal.calories,
            protein: meal.protein,
            carbs: meal.carbs,
            fat: meal.fat,
            photoUri: meal.photoUri,
            recipeId: meal.recipeId,
            ingredients: Array.isArray(meal.ingredients) ? meal.ingredients : [],
          });
          grouped.set(meal.dayKey, current);
        }

        const nextDays = Array.from(grouped.values()).sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1));
        if (!cancelled) {
          setDays(nextDays);
          setSavedRecipes(recipes);
          setSelectedDayKey((current) =>
            typeof params.day === "string" && params.day
              ? clampDayKeyToToday(params.day, todayKey)
              : current || nextDays[0]?.dayKey || getDayKey(new Date())
          );
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [locale, params.day, todayKey])
  );

  const refreshHistory = useCallback(async () => {
    const [meals, measurement, recipes] = await Promise.all([
      loadMyDayMeals(),
      loadMeasurementSystemPreference(),
      loadSavedRecipes(),
    ]);
    setHealthMeasurement(measurement);
    setSavedRecipes(recipes);
    const grouped = new Map<string, DaySummary>();

    for (const meal of meals) {
      const current = grouped.get(meal.dayKey) || {
        dayKey: meal.dayKey,
        title: formatDayLabel(meal.dayKey, locale),
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        count: 0,
        meals: [],
      };

      current.calories += meal.calories;
      current.protein += meal.protein;
      current.carbs += meal.carbs;
      current.fat += meal.fat;
      current.count += 1;
      current.meals.push({
        id: meal.id,
        source: meal.source,
        title: meal.title,
        calories: meal.calories,
        protein: meal.protein,
        carbs: meal.carbs,
        fat: meal.fat,
        photoUri: meal.photoUri,
        recipeId: meal.recipeId,
        ingredients: Array.isArray(meal.ingredients) ? meal.ingredients : [],
      });
      grouped.set(meal.dayKey, current);
    }

    setDays(Array.from(grouped.values()).sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1)));
  }, [locale]);

  const handleDeleteMeal = (mealId: string) => {
    Alert.alert(
      t("my_day.delete_meal_title", { defaultValue: "Delete meal" }),
      t("my_day.delete_meal_body", { defaultValue: "Remove this meal?" }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"),
          style: "destructive",
          onPress: async () => {
            await removeMeal(mealId);
            await refreshHistory();
          },
        },
      ]
    );
  };

  const visibleMealEditIngredients = useMemo(
    () =>
      mealEditShowAllIngredients
        ? mealEditIngredients.map((item, index) => ({ item, index }))
        : mealEditIngredients.slice(0, 6).map((item, index) => ({ item, index })),
    [mealEditIngredients, mealEditShowAllIngredients]
  );

  const openMealEditor = (meal: DaySummary["meals"][number]) => {
    const baseDraft = {
      title: meal.title,
      calories: String(meal.calories),
      protein: String(meal.protein),
      carbs: String(meal.carbs),
      fat: String(meal.fat),
    };
    const nextIngredients =
      Array.isArray(meal.ingredients) && meal.ingredients.length > 0
        ? meal.ingredients.map((item) => ({ ...item }))
        : [];
    setEditingMealId(meal.id);
    setMealEditNutritionMode(meal.source === "manual" ? "manual" : "auto");
    setMealDraftBase(baseDraft);
    setMealDraft(baseDraft);
    setMealEditIngredients(nextIngredients);
    setMealEditIngredientBase(nextIngredients);
    setMealEditShowAllIngredients(false);
    setMealEditNewIngredientName("");
    setMealEditNewIngredientQuantity("");
    setMealEditNewIngredientUnit("g");
    setMealEditUnitDropdownOpen(false);
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

  const updateIngredientDisplayQuantity = (index: number, value: string) => {
    setMealEditIngredients((prev) => {
      const next = prev.map((item, idx) =>
        idx === index
          ? {
              ...item,
              quantity: quantityFromDisplay(sanitizePositiveDecimalInput(value), item.unit, healthMeasurement),
            }
          : item
      );
      if (mealDraftBase && mealEditNutritionMode === "auto") {
        setMealDraft((prevDraft) =>
          prevDraft
            ? {
                ...prevDraft,
                ...recomputeTotals(mealDraftBase, mealEditIngredientBase, next),
              }
            : prevDraft
        );
      }
      return next;
    });
  };

  const removeIngredient = (index: number) => {
    setMealEditIngredients((prev) => {
      const next = prev.filter((_, idx) => idx !== index);
      if (mealDraftBase && mealEditNutritionMode === "auto") {
        setMealDraft((prevDraft) =>
          prevDraft
            ? {
                ...prevDraft,
                ...recomputeTotals(mealDraftBase, mealEditIngredientBase, next),
              }
            : prevDraft
        );
      }
      return next;
    });
  };

  const addIngredient = () => {
    const nextIngredient = normalizeNewReviewIngredient(
      mealEditNewIngredientName,
      quantityFromDisplay(mealEditNewIngredientQuantity, mealEditNewIngredientUnit, healthMeasurement),
      mealEditNewIngredientUnit
    );
    if (!nextIngredient) return;
    setMealEditIngredients((prev) => {
      const next = [...prev, nextIngredient];
      if (mealDraftBase && mealEditNutritionMode === "auto") {
        setMealDraft((prevDraft) =>
          prevDraft
            ? {
                ...prevDraft,
                ...recomputeTotals(mealDraftBase, mealEditIngredientBase, next),
              }
            : prevDraft
        );
      }
      return next;
    });
    setMealEditNewIngredientName("");
    setMealEditNewIngredientQuantity("");
    setMealEditUnitDropdownOpen(false);
  };

  const closeMealEditor = () => {
    setEditingMealId(null);
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

  const saveEdit = async () => {
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
      await updateMeal(editingMealId, {
        title: mealDraft.title.trim() || "Meal",
        calories: refreshedEstimate ? Math.round(refreshedEstimate.calories) : parseNumber(mealDraft.calories, 0),
        protein: refreshedEstimate ? Math.round(refreshedEstimate.protein) : parseNumber(mealDraft.protein, 0),
        carbs: refreshedEstimate ? Math.round(refreshedEstimate.carbs) : parseNumber(mealDraft.carbs, 0),
        fat: refreshedEstimate ? Math.round(refreshedEstimate.fat) : parseNumber(mealDraft.fat, 0),
        ingredients: safeIngredients,
      });
      closeMealEditor();
      await refreshHistory();
    } finally {
      endMealEditSave();
    }
  };

  const goToDay = (dayKey: string) => {
    if (dayKey > todayKey) return;
    setSelectedDayKey(dayKey);
    const nextDate = parseDayKey(dayKey);
    setCalendarMonth(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
    router.setParams({ day: dayKey });
  };

  const canGoForward = selectedDayKey < todayKey;
  const canOpenNextCalendarMonth = calendarMonth < currentMonthStart;

  return (
    <View style={[styles.screen, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t("my_day.trends_history_title", { defaultValue: "History" }),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
          headerLeft: () => (
            <TouchableOpacity activeOpacity={0.8} onPress={() => router.replace("/my-day")} style={styles.backButton}>
              <MaterialIcons name="arrow-back" size={26} color="#fff" />
            </TouchableOpacity>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <AppCard>
          <View style={styles.dayPickerRow}>
            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.dayNavButton, { borderColor: border }]}
              onPress={() => goToDay(addDaysToKey(selectedDayKey, -1))}
            >
              <MaterialIcons name="chevron-left" size={22} color={text} />
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.85}
              style={styles.dayPickerCopy}
              onPress={() => setCalendarVisible(true)}
            >
              <Text style={[styles.dayTitle, { color: text }]}>{selectedDay.title}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.85}
              disabled={!canGoForward}
              style={[styles.dayNavButton, { borderColor: border, opacity: canGoForward ? 1 : 0.35 }]}
              onPress={() => goToDay(addDaysToKey(selectedDayKey, 1))}
            >
              <MaterialIcons name="chevron-right" size={22} color={text} />
            </TouchableOpacity>
          </View>
        </AppCard>

        <AppCard>
          <View style={styles.headerRow}>
            <Text style={[styles.sectionTitle, { color: text }]}>
              {t("my_day.day_summary", { defaultValue: "Day summary" })}
            </Text>
          </View>
          <View style={[styles.separator, { backgroundColor: border }]} />
          <View style={styles.caloriesRow}>
            <MaterialIcons name="local-fire-department" size={16} color={cta} />
            <Text style={[styles.caloriesText, { color: text }]}>{Math.round(selectedDay.calories)} kcal</Text>
          </View>
          <Text style={[styles.macroLine, { color: subText }]}>
            {selectedDayMacroLine}
          </Text>
        </AppCard>

        <AppCard>
          <View style={styles.headerRow}>
            <Text style={[styles.sectionTitle, { color: text }]}>
              {t("my_day.todays_meals", { defaultValue: "Meals" })}
            </Text>
          </View>
          {selectedDay.meals.length === 0 ? (
            <View style={styles.emptyDayState}>
              <Text style={[styles.emptyTitle, { color: text }]}>
                {t("my_day.history_day_empty_title", { defaultValue: "No meals logged for this day" })}
              </Text>
              <Text style={[styles.emptyBody, { color: subText }]}>
                {t("my_day.history_day_empty_body", {
                  defaultValue: "Add a meal if you forgot to log something for this date.",
                })}
              </Text>
            </View>
          ) : (
            <View style={styles.mealsWrap}>
              {selectedDay.meals.map((meal) => {
                const recipeImage =
                  meal.source === "recipe" && meal.recipeId ? savedRecipeById.get(meal.recipeId)?.image : null;
                const sourceImage = meal.source === "photo" && meal.photoUri ? meal.photoUri : recipeImage;
                const sourceIcon =
                  meal.source === "photo"
                    ? "photo-camera"
                    : meal.source === "recipe"
                      ? "menu-book"
                      : "chat-bubble-outline";

                return (
                  <View key={meal.id} style={[styles.mealRow, { borderTopColor: border }]}>
                    <View style={styles.mealRowInner}>
                      <View style={[styles.mealSourceSquare, { backgroundColor: `${primary}14`, borderColor: border }]}>
                        {sourceImage ? (
                          <Image source={{ uri: sourceImage }} style={styles.mealSourceImage} />
                        ) : (
                          <MaterialIcons name={sourceIcon as any} size={25} color={cta} />
                        )}
                      </View>
                      <View style={styles.mealCardContent}>
                        <View style={styles.mealTopRow}>
                          <View style={styles.mealInfo}>
                            <Text style={[styles.mealTitle, { color: text }]} numberOfLines={2}>
                              {meal.title}
                            </Text>
                          </View>
                          <View style={styles.mealActions}>
                            <TouchableOpacity activeOpacity={0.8} onPress={() => openMealEditor(meal)} style={styles.mealActionButton}>
                              <MaterialIcons name="edit" size={18} color={interactiveIconColor} />
                            </TouchableOpacity>
                            <TouchableOpacity activeOpacity={0.8} onPress={() => handleDeleteMeal(meal.id)} style={styles.mealActionButton}>
                              <MaterialIcons name="delete-outline" size={19} color={subText} />
                            </TouchableOpacity>
                          </View>
                        </View>
                        <View style={styles.mealMetaRow}>
                          {[
                            { key: "kcal", label: "Kcal", value: Math.round(meal.calories), icon: "local-fire-department" as const },
                            { key: "protein", label: t("my_day.protein"), value: nutrientValueForDisplay(meal.protein, healthMeasurement) },
                            { key: "carbs", label: t("my_day.carbs"), value: nutrientValueForDisplay(meal.carbs, healthMeasurement) },
                            { key: "fat", label: t("my_day.fat"), value: nutrientValueForDisplay(meal.fat, healthMeasurement) },
                          ].map((macro) => (
                            <View key={`${meal.id}-${macro.key}`} style={styles.mealMacroSimple}>
                              {macro.icon ? (
                                <MaterialIcons name={macro.icon} size={13} color={cta} style={styles.mealMacroIcon} />
                              ) : null}
                              <Text style={[styles.mealMacroLabel, { color: subText }]}>{macro.label}</Text>
                              <Text style={[styles.mealMacroValue, { color: text }]}>
                                {macro.value}
                                {macro.key === "kcal" ? "" : nutrientUnit}
                              </Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </AppCard>
      </ScrollView>
      <View pointerEvents="box-none" style={styles.floatingActionsWrap}>
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

      <MyDayMealEditorModal
        visible={!!mealDraft}
        onClose={closeMealEditor}
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
        onChangeIngredientQuantity={updateIngredientDisplayQuantity}
        onRemoveIngredient={removeIngredient}
        emptyIngredientsText={t("my_day.review_need_ingredient", {
          defaultValue: "Add at least one ingredient before saving.",
        })}
        showAllIngredients={mealEditShowAllIngredients}
        showIngredientsToggle={mealEditIngredients.length > 6}
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
        onAddIngredient={addIngredient}
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
        onSave={saveEdit}
        saveDisabled={mealEditIngredients.length === 0 || mealEditSaveInFlight}
      />
      <MyDayAddMealFlow
        visible={addMealFlowVisible}
        targetDate={parseDayKey(selectedDayKey)}
        onClose={() => setAddMealFlowVisible(false)}
        onSaved={refreshHistory}
      />
      <Modal visible={calendarVisible} transparent animationType="fade" onRequestClose={() => setCalendarVisible(false)}>
        <Pressable style={[styles.calendarOverlay, { backgroundColor: modalBackdrop }]} onPress={() => setCalendarVisible(false)}>
          <View style={[styles.calendarCard, { backgroundColor: card, borderColor: border }]} onStartShouldSetResponder={() => true}>
            <View style={styles.calendarHeader}>
              <TouchableOpacity
                activeOpacity={0.8}
                style={styles.calendarNavButton}
                onPress={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}
              >
                <MaterialIcons name="chevron-left" size={22} color={text} />
              </TouchableOpacity>
              <Text style={[styles.calendarTitle, { color: text }]}>{calendarMonthLabel}</Text>
              <TouchableOpacity
                activeOpacity={0.8}
                style={styles.calendarNavButton}
                disabled={!canOpenNextCalendarMonth}
                onPress={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}
              >
                <MaterialIcons name="chevron-right" size={22} color={canOpenNextCalendarMonth ? text : subText} />
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
              {calendarCells.map((day, index) => {
                const dayKey = day
                  ? `${calendarMonth.getFullYear()}-${`${calendarMonth.getMonth() + 1}`.padStart(2, "0")}-${`${day}`.padStart(2, "0")}`
                  : null;
                const isSelected = dayKey === selectedDayKey;
                const hasMeals = !!dayKey && mealDayKeys.has(dayKey);
                const isFuture = !!dayKey && dayKey > todayKey;
                return (
                  <TouchableOpacity
                    key={`${day ?? "empty"}-${index}`}
                    activeOpacity={day && !isFuture ? 0.85 : 1}
                    disabled={!day || isFuture}
                    style={[
                      styles.calendarCell,
                      isSelected ? { backgroundColor: cta } : null,
                      !isSelected && hasMeals ? { borderColor: cta } : { borderColor: "transparent" },
                      isFuture ? { opacity: 0.3 } : null,
                    ]}
                    onPress={() => {
                      if (!dayKey) return;
                      goToDay(dayKey);
                      setCalendarVisible(false);
                    }}
                  >
                    <Text style={[styles.calendarDayText, { color: isSelected ? "#fff" : text }]}>{day ?? ""}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, paddingBottom: 104 },
  backButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  dayPickerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  dayNavButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dayPickerCopy: {
    flex: 1,
    alignItems: "center",
  },
  dayTitle: {
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
  },
  dayMeta: {
    fontSize: 13,
    fontWeight: "700",
  },
  dayMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  dayQuickActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 14,
  },
  todayButton: {
    flex: 1,
    alignItems: "center",
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 10,
  },
  caloriesRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  caloriesText: {
    fontSize: 24,
    fontWeight: "800",
  },
  macroLine: {
    fontSize: 14,
    lineHeight: 20,
  },
  mealsWrap: {
    marginTop: 12,
  },
  emptyDayState: {
    paddingTop: 12,
  },
  mealRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    marginTop: 10,
  },
  mealRowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
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
  mealCardContent: {
    flex: 1,
    position: "relative",
    gap: 8,
  },
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
    fontWeight: "700",
    lineHeight: 19,
  },
  mealMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
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
  mealMacroLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
  mealMacroValue: {
    fontSize: 12,
    fontWeight: "700",
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
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    padding: 16,
  },
  optionSheet: {
    width: "90%",
    alignSelf: "center",
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
  modalCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
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
    marginTop: 14,
  },
  quantityTitle: {
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
  },
  ingredientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  ingredientName: {
    flex: 1,
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
  ingredientUnitText: {
    minWidth: 44,
    fontSize: 13,
    fontWeight: "600",
  },
  ingredientRemoveButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  mealTitleInput: {
    paddingHorizontal: 12,
    width: "100%",
    textAlign: "left",
    transform: [{ translateX: 0 }],
  },
  reviewComposer: {
    marginTop: 10,
  },
  reviewComposerControls: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    gap: 10,
  },
  reviewComposerNameInput: {
    flex: 1.2,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
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
    minWidth: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 2,
  },
  reviewComposerUnitText: {
    fontSize: 13,
    fontWeight: "600",
  },
  reviewUnitDropdown: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
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
  reviewToggleButton: {
    marginTop: 8,
  },
  reviewToggleText: {
    fontSize: 13,
    fontWeight: "700",
  },
  floatingActionsWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 16,
    paddingHorizontal: 14,
    alignItems: "flex-end",
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
  calendarOverlay: {
    flex: 1,
    justifyContent: "center",
    padding: 18,
  },
  calendarCard: {
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 10,
  },
  calendarHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  calendarNavButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  calendarTitle: {
    fontSize: 16,
    fontWeight: "800",
  },
  calendarWeekRow: {
    flexDirection: "row",
    marginBottom: 8,
  },
  calendarWeekday: {
    flex: 1,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "800",
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  calendarCell: {
    width: "14.2%",
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 4,
  },
  calendarDayText: {
    fontSize: 14,
    fontWeight: "800",
    lineHeight: 16,
    includeFontPadding: false,
    textAlignVertical: "center",
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
  emptyTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
  },
});
