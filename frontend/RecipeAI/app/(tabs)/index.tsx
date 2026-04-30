import React, { useState, useRef, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";
import {
  StyleSheet,
  TextInput,
  View,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  Alert,
  Text,
  TouchableOpacity,
  Animated,
  Easing,
  Modal,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, Stack, useFocusEffect } from "expo-router";
import { MaterialIcons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useThemeColors } from "../../context/ThemeContext";
import { getApiBaseUrl } from "../../lib/config/api";
import {
  fetchEconomyCatalogBundle,
  fetchEconomySnapshot,
  shouldHidePremiumPricing,
  writeCachedEconomySnapshot,
  type EconomyCatalogOffer,
} from "../../lib/economy/client";
import AppButton from "../../components/AppButton";
import InsufficientCookiesModal from "../../components/InsufficientCookiesModal";
import EggIcon from "../../components/EggIcon";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import i18n from "../../i18n";
import { getAuth } from "firebase/auth";
import { getDeviceId } from "../../utils/deviceId";
import { prefsEvents, PREFS_UPDATED } from "../../lib/prefs";
import { RecipeNutritionInfo } from "../../lib/recipes/nutrition";

// --- Types ---
interface Recipe {
  id: string;
  title: string;
  cookingTime: number;
  difficulty: "Easy" | "Moderate" | "Challenging";
  servings: number;
  ingredients: string[];
  steps: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  nutritionInfo?: RecipeNutritionInfo | null;
}

const AI_KITCHEN_SUGGESTIONS_KEY = "aiKitchenSuggestions";
const AI_KITCHEN_SUGGESTION_HISTORY_KEY = "aiKitchenSuggestionHistory";
const AI_KITCHEN_RECIPE_CACHE_KEY = "aiKitchenRecipeCache";

function validateRecipe(raw: any): Recipe {
  return {
    id: raw.id || `${Date.now()}`,
    title: raw.title?.trim() || "Untitled Recipe",
    cookingTime: raw.cookingTime || 30,
    difficulty: raw.difficulty || "Easy",
    servings: raw.servings || 2,
    ingredients: raw.ingredients || [],
    steps: raw.steps || [],
    tags: raw.tags || [],
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
    nutritionInfo: raw.nutritionInfo || null,
  };
}


const mealOptions = [
  { labelKey: "meal.breakfast", icon: "🍳" },
  { labelKey: "meal.lunch", icon: "🥪" },
  { labelKey: "meal.dinner", icon: "🍝" },
  { labelKey: "meal.snack", icon: "🍎" },
  { labelKey: "meal.just_hungry", icon: "🤔" },
];

// Cuisine options
const cuisineOptions = [
  { labelKey: "cuisine.surprise", icon: "🎲" },
  { labelKey: "cuisine.italian", icon: "🍝" },
  { labelKey: "cuisine.mexican", icon: "🌮" },
  { labelKey: "cuisine.chinese", icon: "🥡" },
  { labelKey: "cuisine.japanese", icon: "🍣" },
  { labelKey: "cuisine.indian", icon: "🍛" },
  { labelKey: "cuisine.french", icon: "🥖" },
  { labelKey: "cuisine.thai", icon: "🍜" },
  { labelKey: "cuisine.american", icon: "🍔" },
  { labelKey: "cuisine.mediterranean", icon: "🥙" },
];


// --- Main component ---
export default function Index() {
  const { t } = useTranslation();
  const language = i18n.language || "en";
  const allDietaryOptions = t("dietary", { returnObjects: true }) as Record<string, { label: string; icon: string }>;
  const allAvoidOptions = t("avoid", { returnObjects: true }) as Record<string, { label: string; icon: string }>;
  const router = useRouter();
  const { bg, text, card, border, isDark } = useThemeColors();
  const auth = getAuth();

  // Step state
  const [step, setStep] = useState(1);

  // Collected answers
  const [mealType, setMealType] = useState("meal.just_hungry");
  const [note, setNote] = useState("");
  const [people, setPeople] = useState(2);
  const [time, setTime] = useState<"quick" | "medium" | "slow">("medium");
  const [cuisine, setCuisine] = useState("cuisine.surprise");
  const [dietary, setDietary] = useState<string[]>([]);
  const [avoid, setAvoid] = useState<string[]>([]);
  const [avoidOther, setAvoidOther] = useState("");
  // Track the measurement system from Profile (or onboarding)
  const [measurementSystem, setMeasurementSystem] = useState<"Metric" | "US">("Metric");


  // Load profile preferences from AsyncStorage.
  // IMPORTANT: Profile is the source of truth; AI Kitchen should refresh these
  // when the tab becomes active so changes made in Profile are reflected here.
  const loadProfilePrefsFromStorage = useCallback(async () => {
    try {
      const [
        storedDietary,
        storedAvoid,
        storedAvoidOther,
        storedMeasurement,
        storedMeasureSystem,
      ] = await Promise.all([
        AsyncStorage.getItem("dietary"),
        AsyncStorage.getItem("avoid"),
        AsyncStorage.getItem("avoidOther"),
        AsyncStorage.getItem("measurement"),
        AsyncStorage.getItem("measureSystem"),
      ]);

      let parsedDietary: string[] = [];
      let parsedAvoid: string[] = [];

      try {
        if (storedDietary) {
          const val = JSON.parse(storedDietary);
          if (Array.isArray(val)) parsedDietary = val;
        }
      } catch {
        parsedDietary = [];
      }

      try {
        if (storedAvoid) {
          const val = JSON.parse(storedAvoid);
          if (Array.isArray(val)) parsedAvoid = val;
        }
      } catch {
        parsedAvoid = [];
      }

      // Drop legacy prefixes like "dietary.vegan" -> "vegan", and ignore "none"/"dietary.none"
      parsedDietary = parsedDietary
        .map((d) => (typeof d === "string" ? d : ""))
        .filter(Boolean)
        .map((d) => (d.startsWith("dietary.") ? d.substring("dietary.".length) : d))
        .filter((d) => d !== "dietary.none" && d.toLowerCase() !== "none");

      // Drop legacy prefixes like "avoid.gluten" -> "gluten", and ignore "none"/"avoid.none"
      parsedAvoid = parsedAvoid
        .map((a) => (typeof a === "string" ? a : ""))
        .filter(Boolean)
        .map((a) => (a.startsWith("avoid.") ? a.substring("avoid.".length) : a))
        .filter((a) => a !== "avoid.none" && a.toLowerCase() !== "none");

      setDietary(parsedDietary);
      setAvoid(parsedAvoid);
      setAvoidOther(storedAvoidOther ?? "");

      // Measurement system: accept both Profile-style ("US"/"Metric") and onboarding-style ("imperial"/"metric")
      let ms: "Metric" | "US" = "Metric";
      const measurementSource = storedMeasurement || storedMeasureSystem;
      if (measurementSource) {
        const lower = measurementSource.toLowerCase();
        if (lower === "us" || lower === "imperial") {
          ms = "US";
        } else {
          // "metric" or anything else defaults to Metric
          ms = "Metric";
        }
      }
      setMeasurementSystem(ms);
    } catch (err) {
      console.error("Error loading profile prefs for AI Kitchen:", err);
    }
  }, []);

  // Initial load on mount
  useEffect(() => {
    loadProfilePrefsFromStorage();
  }, [loadProfilePrefsFromStorage]);

  // Refresh whenever this tab/screen comes into focus
  useFocusEffect(
    useCallback(() => {
      loadProfilePrefsFromStorage();
      return undefined;
    }, [loadProfilePrefsFromStorage])
  );

  // Refresh instantly when preferences are updated elsewhere (e.g., Profile tab)
  useEffect(() => {
    const onPrefsUpdated = () => {
      loadProfilePrefsFromStorage();
    };

    prefsEvents.on(PREFS_UPDATED, onPrefsUpdated);
    return () => {
      prefsEvents.off(PREFS_UPDATED, onPrefsUpdated as any);
    };
  }, [loadProfilePrefsFromStorage]);

  // Also refresh defaults when the user reaches Step 3.
  // This ensures Profile changes are reflected in the Step 3 chips,
  // while still allowing the user to override selections within the step.
  useEffect(() => {
    if (step === 3) {
      loadProfilePrefsFromStorage();
    }
  }, [step, loadProfilePrefsFromStorage]);

  // Sanitizer for avoidOther input
  const sanitizeAvoidOther = (raw: string) => {
    if (!raw) return "";
    let safe = raw.replace(/[^a-zA-Z0-9 ,.;:!?áéíóúàèìòùçãõâêîôûÁÉÍÓÚÀÈÌÒÙÇÃÕÂÊÎÔÛ-]/g, "");
    if (safe.length > 120) safe = safe.slice(0, 120);
    return safe;
  };

  // Loading
  const [loading, setLoading] = useState(false);

  // Suggestions
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [suggestionHistory, setSuggestionHistory] = useState<any[]>([]);
  const [cachedRecipesBySuggestionId, setCachedRecipesBySuggestionId] = useState<Record<string, Recipe>>({});

  // --- Insufficient cookies modal ---
  const [insufficientModal, setInsufficientModal] = useState<{
    visible: boolean;
    context: "suggestions" | "full-recipe";
    remaining: number;
  }>({ visible: false, context: "suggestions", remaining: 0 });
  const [freePremiumActionsRemaining, setFreePremiumActionsRemaining] = useState<number | null>(null);
  const [availableRewardsCount, setAvailableRewardsCount] = useState(0);
  const [featuredOffer, setFeaturedOffer] = useState<EconomyCatalogOffer | null>(null);

  const backendUrl = getApiBaseUrl()!;
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  console.log("Using backend URL:", backendUrl, "env:", appEnv);

  useEffect(() => {
    (async () => {
      try {
        const [storedSuggestions, storedHistory, storedRecipeCache] = await Promise.all([
          AsyncStorage.getItem(AI_KITCHEN_SUGGESTIONS_KEY),
          AsyncStorage.getItem(AI_KITCHEN_SUGGESTION_HISTORY_KEY),
          AsyncStorage.getItem(AI_KITCHEN_RECIPE_CACHE_KEY),
        ]);

        if (storedSuggestions) {
          const parsed = JSON.parse(storedSuggestions);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setSuggestions(parsed);
          }
        }

        if (storedHistory) {
          const parsed = JSON.parse(storedHistory);
          if (Array.isArray(parsed)) {
            setSuggestionHistory(parsed);
          }
        }

        if (storedRecipeCache) {
          const parsed = JSON.parse(storedRecipeCache);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            setCachedRecipesBySuggestionId(parsed);
          }
        }
      } catch (err) {
        console.warn("[AI Kitchen] Failed to restore session state", err);
      }
    })();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(AI_KITCHEN_SUGGESTIONS_KEY, JSON.stringify(suggestions)).catch(() => {});
  }, [suggestions]);

  useEffect(() => {
    AsyncStorage.setItem(AI_KITCHEN_SUGGESTION_HISTORY_KEY, JSON.stringify(suggestionHistory)).catch(() => {});
  }, [suggestionHistory]);

  useEffect(() => {
    AsyncStorage.setItem(AI_KITCHEN_RECIPE_CACHE_KEY, JSON.stringify(cachedRecipesBySuggestionId)).catch(() => {});
  }, [cachedRecipesBySuggestionId]);

  // --- Animation refs ---
  const contentAnim = useRef(new Animated.Value(0)).current;
  const buttonAnim = useRef(new Animated.Value(0)).current;

  // Chef Animations: step 1 (bounce), step 2 (wiggle), step 3 (pulse)
  const chefBounceAnim = useRef(new Animated.Value(0)).current;
  const chefWiggleAnim = useRef(new Animated.Value(0)).current;
  const chefPulseAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    chefBounceAnim.stopAnimation();
    chefWiggleAnim.stopAnimation();
    chefPulseAnim.stopAnimation();
    if (step === 1) {
      chefBounceAnim.setValue(0);
      Animated.loop(
        Animated.sequence([
          Animated.timing(chefBounceAnim, {
            toValue: 1,
            duration: 900,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(chefBounceAnim, {
            toValue: 0,
            duration: 900,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else if (step === 2) {
      chefWiggleAnim.setValue(0);
      Animated.loop(
        Animated.sequence([
          Animated.timing(chefWiggleAnim, {
            toValue: 1,
            duration: 200,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.timing(chefWiggleAnim, {
            toValue: -1,
            duration: 400,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.timing(chefWiggleAnim, {
            toValue: 0,
            duration: 200,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else if (step === 3) {
      chefPulseAnim.setValue(0);
      Animated.loop(
        Animated.sequence([
          Animated.timing(chefPulseAnim, {
            toValue: 1,
            duration: 400,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(chefPulseAnim, {
            toValue: 0,
            duration: 400,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      ).start();
    }
  }, [step]);

  const animateStep = () => {
    contentAnim.setValue(0);
    buttonAnim.setValue(0);
    Animated.parallel([
      Animated.timing(contentAnim, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(buttonAnim, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    ]).start();
  };

  useEffect(() => {
    animateStep();
  }, [step]);

  // When Step 3 opens, refresh prefs from Profile so the UI reflects the latest selections
  useEffect(() => {
    if (step === 3) {
      loadProfilePrefsFromStorage();
    }
  }, [step, loadProfilePrefsFromStorage]);

  // --- Helpers for chips ---
  // Toggle logic for dietary and avoid options (Profile is source of truth; this is per-request only)
  const toggleDietary = (optionKey: string) => {
    setDietary((prev) =>
      prev.includes(optionKey)
        ? prev.filter((d) => d !== optionKey)
        : [...prev, optionKey]
    );
  };

  const toggleAvoid = (optionKey: string) => {
    setAvoid((prev) => {
      let next: string[];
      if (prev.includes(optionKey)) {
        next = prev.filter((a) => a !== optionKey);
        if (optionKey === "other") setAvoidOther("");
      } else {
        next = [...prev, optionKey];
      }
      return next;
    });
  };

  // Cuisine selection logic: "Surprise me" is default, exclusive
  const handleCuisineSelect = (labelKey: string) => {
    if (labelKey === "cuisine.surprise") {
      setCuisine("cuisine.surprise");
    } else {
      setCuisine(labelKey === cuisine ? "cuisine.surprise" : labelKey);
    }
  };

  // --- Economy / API error helpers ---
  const getErrorMessageFromResponse = (data: any): string | null => {
    if (!data) return null;
    if (typeof data === "string") return data;
    if (typeof data?.message === "string") return data.message;
    if (typeof data?.error === "string") return data.error;
    return null;
  };

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
    } catch (e) {
      // Fallback in case params typing/routes differ
      router.push("/economy/store" as any);
    }
  };

  const openInsufficientCookiesModal = async (
    remaining: number | null | undefined,
    context: "suggestions" | "full-recipe"
  ) => {
    const rem = typeof remaining === "number" ? remaining : 0;

    if (!featuredOffer || availableRewardsCount === 0) {
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
        // ignore - modal can still render without the offer card
      }
    }

    setInsufficientModal({ visible: true, context, remaining: rem });
  };

  const handleApiResponse = async (
    response: Response,
    opts: {
      genericTitleKey: string;
      genericTitleDefault: string;
      genericBodyKey: string;
      genericBodyDefault: string;
    },
    context: "suggestions" | "full-recipe" = "suggestions"
  ): Promise<any | null> => {
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.ok) return data;

    // Economy: insufficient cookies
    if (response.status === 402) {
      await openInsufficientCookiesModal(data?.remaining, context);
      return null;
    }

    const msg = getErrorMessageFromResponse(data);
    Alert.alert(
      t(opts.genericTitleKey, opts.genericTitleDefault),
      msg || t(opts.genericBodyKey, opts.genericBodyDefault)
    );

    return null;
  };

  const mergeSuggestionHistory = useCallback((incoming: any[]) => {
    setSuggestionHistory((prev) => {
      const merged = [...prev];
      const seen = new Set(
        prev.map((item) =>
          String(item?.title ?? "")
            .trim()
            .toLowerCase()
        )
      );

      for (const item of incoming) {
        const key = String(item?.title ?? "")
          .trim()
          .toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }

      return merged;
    });
  }, []);

  // --- Fetch recipe suggestions from backend ---
  const generateRecipe = async () => {
    setLoading(true);
    try {
      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : null;
      const deviceId = await getDeviceId();
      const userId = currentUser?.uid ?? null;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-app-env": appEnv,
      };

      if (idToken) {
        headers.Authorization = `Bearer ${idToken}`;
      }
      if (deviceId) {
        headers["x-device-id"] = deviceId;
      }
      if (userId) {
        headers["x-user-id"] = userId;
      }

      const response = await fetch(`${backendUrl}/getRecipeSuggestions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          mealType,
          note,
          people,
          time,
          cuisine,
          dietary,
          avoid: avoid.includes("other") ? [...avoid, avoidOther] : avoid,
          language,
          measurementSystem,
          excludeSuggestions: suggestionHistory.map((item) => ({
            title: item?.title,
            description: item?.description,
          })),
        }),
      });

      const data = await handleApiResponse(response, {
        genericTitleKey: "wizard.error_generate_title",
        genericTitleDefault: "Error",
        genericBodyKey: "wizard.error_generate",
        genericBodyDefault: "Something went wrong while generating suggestions.",
      }, "suggestions");

      if (!data) {
        setSuggestions([]);
        return;
      }

      // Expecting array of suggestions: [{id, title, cookingTime, difficulty, description}]
      const nextSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
      setSuggestions(nextSuggestions);
      mergeSuggestionHistory(nextSuggestions);
    } catch (err) {
      console.error("Error generating suggestions:", err);
      Alert.alert(t("wizard.error_generate_title", "Error"), t("wizard.error_generate"));
    }
    setLoading(false);
  };

  // Fetch full recipe for a suggestion from backend
  const fetchFullRecipe = async (suggestion: any) => {
    const cachedRecipe = cachedRecipesBySuggestionId[String(suggestion?.id ?? "")];
    if (cachedRecipe) {
      const tempRecipeKey = `aiKitchenRecipe:${cachedRecipe.id}:${Date.now()}`;
      await AsyncStorage.setItem(tempRecipeKey, JSON.stringify(cachedRecipe));
      router.push({
        pathname: "/recipe/[id]",
        params: {
          id: cachedRecipe.id,
          tempRecipeKey,
          from: "ai-kitchen",
        },
      });
      return;
    }

    setLoading(true);
    try {
      // Pre-check cookie balance to avoid wasting AI resources.
      const okToProceed = await ensureHasCookiesOrPrompt(1, "full-recipe");
      if (!okToProceed) {
        setLoading(false);
        return;
      }
      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : null;
      const deviceId = await getDeviceId();
      const userId = currentUser?.uid ?? null;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-app-env": appEnv,
      };

      if (idToken) {
        headers.Authorization = `Bearer ${idToken}`;
      }
      if (deviceId) {
        headers["x-device-id"] = deviceId;
      }
      if (userId) {
        headers["x-user-id"] = userId;
      }

      const response = await fetch(`${backendUrl}/getRecipe`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          note,
          time,
          dietary,
          avoid: avoid.includes("other") ? [...avoid, avoidOther] : avoid,
          mealType,
          avoidOther,
          suggestionId: suggestion.id,
          suggestion,
          people,
          language,
          measurementSystem,
        }),
      });

      const data = await handleApiResponse(response, {
        genericTitleKey: "wizard.error_get_recipe_title",
        genericTitleDefault: "Error",
        genericBodyKey: "wizard.error_get_recipe",
        genericBodyDefault: "Something went wrong while creating the recipe.",
      }, "full-recipe");

      if (!data) {
        return;
      }
      // Expecting structured recipe: {title, duration, difficulty, description, ingredients, steps, ...}
      let recipeRaw = data.recipe || {};
      let difficultyRaw = recipeRaw.difficulty || suggestion.difficulty || "";
      let difficulty: "Easy" | "Moderate" | "Challenging" = "Easy";
      if (
        typeof difficultyRaw === "string" &&
        (difficultyRaw.toLowerCase() === "medium" ||
          difficultyRaw.toLowerCase() === "moderate")
      ) {
        difficulty = "Moderate";
      } else if (
        typeof difficultyRaw === "string" &&
        (difficultyRaw.toLowerCase() === "hard" ||
          difficultyRaw.toLowerCase() === "challenging")
      ) {
        difficulty = "Challenging";
      } else {
        difficulty = "Easy";
      }
      const safeRecipe = validateRecipe({
        ...recipeRaw,
        id: recipeRaw.id || suggestion.id,
        title: recipeRaw.title || suggestion.title,
        cookingTime: recipeRaw.cookingTime || recipeRaw.duration || suggestion.cookingTime,
        difficulty,
        description: recipeRaw.description || suggestion.description,
        nutritionInfo: recipeRaw.nutritionInfo || null,
      });
      const nextRecipeCache = {
        ...cachedRecipesBySuggestionId,
        [String(suggestion.id)]: safeRecipe,
      };
      setCachedRecipesBySuggestionId(nextRecipeCache);
      await AsyncStorage.setItem(AI_KITCHEN_RECIPE_CACHE_KEY, JSON.stringify(nextRecipeCache));
      const tempRecipeKey = `aiKitchenRecipe:${safeRecipe.id}:${Date.now()}`;
      await AsyncStorage.setItem(tempRecipeKey, JSON.stringify(safeRecipe));
      router.push({
        pathname: "/recipe/[id]",
        params: {
          id: safeRecipe.id,
          tempRecipeKey,
          from: "ai-kitchen",
        },
      });
    } catch (err) {
      console.error("Error getting recipe:", err);
      Alert.alert(t("wizard.error_get_recipe_title", "Error"), t("wizard.error_get_recipe"));
    }
    setLoading(false);
  };

  // --- Helper to fetch cookie balance and pre-check before AI call ---
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

  const ensureHasCookiesOrPrompt = async (
    required: number,
    context: "suggestions" | "full-recipe"
  ): Promise<boolean> => {
    const bal = await fetchCookieBalanceSafe();
    // If we can't pre-check (endpoint missing, etc.), don't block the action.
    if (typeof bal !== "number") return true;
    if (bal >= required) return true;
    await openInsufficientCookiesModal(bal, context);
    return false;
  };

  useFocusEffect(
    useCallback(() => {
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
    }, [backendUrl, appEnv])
  );

  // --- Navigation helpers ---
  const maxStep = 3;
  const nextStep = () => setStep((s) => Math.min(maxStep, s + 1));
  const prevStep = () => setStep((s) => Math.max(1, s - 1));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: isDark ? bg : "#F5F5F5" }} edges={['left', 'right', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor="#293a53" />
      <Stack.Screen
        options={{
          title: t("app_titles.ai_kitchen"),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
        }}
      />
      {/* Progress bar and chef icon always visible during wizard steps (1-3) */}
      {(!loading && suggestions.length === 0) && (
        <View style={{ marginTop: 0, marginBottom: 0, alignItems: "center", width: "100%" }}>
          {/* Cooking Mode-style progress bar */}
          <View style={{ width: "100%", alignItems: "center" }}>
            <View
              style={{
                width: "92%",
                backgroundColor: "#e0e4ea",
                borderRadius: 100,
                height: 12,
                overflow: "hidden",
                marginTop: 20,
                marginBottom: 6,
                justifyContent: "center",
              }}
            >
              <Animated.View
                style={{
                  height: "100%",
                  backgroundColor: "#E27D60",
                  borderRadius: 100,
                  width: `${(step / maxStep) * 100}%`,
                  position: "absolute",
                  left: 0,
                  top: 0,
                }}
              />
            </View>
            {/* Step text below bar removed */}
          </View>
          {/* Chef icon below progress bar, animated according to step */}
          <View style={{ alignItems: "center", marginTop: 6, marginBottom: 0 }}>
            <Text
              style={[
                styles.chefImageSmall,
                { textAlign: "center", fontSize: 52 },
              ]}
              accessibilityLabel="Chef emoji"
            >
              👨‍🍳
            </Text>
          </View>
        </View>
      )}

      {/* Insufficient cookies modal */}
      <InsufficientCookiesModal
        visible={insufficientModal.visible}
        isDark={isDark}
        title={t("economy.insufficient_title", "Not enough Eggs")}
        body={
          insufficientModal.context === "full-recipe"
            ? `You need 1 Egg to open the full recipe. Currently, you have ${insufficientModal.remaining} Eggs.`
            : `You need 1 Egg to generate recipe suggestions. Currently, you have ${insufficientModal.remaining} Eggs.`
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

      <KeyboardAwareScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: 20, flexGrow: 1 }}
        enableOnAndroid={true}
        keyboardShouldPersistTaps="handled"
        extraScrollHeight={80}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={styles.centered}>
            <Text style={{ fontSize: 20, color: text, marginBottom: 8 }}>
              {t("wizard.cooking_message")}
            </Text>
            <ActivityIndicator size="large" color="#E27D60" />
          </View>
        ) : suggestions.length > 0 ? (
          <View style={{ flex: 1 }}>
            {/* Reduce space above "Recipe Suggestions" */}
            <Text
              style={{
                fontSize: 20,
                fontWeight: "700",
                color: isDark ? "#f5f5f5" : "#293a53",
                marginTop: 20,
                marginBottom: 8,
              }}
            >
              {t("wizard.recipe_suggestions_title")}
            </Text>
            <Text
              style={{
                fontSize: 15,
                color: isDark ? "#ccc" : "#666",
                marginBottom: 10,
              }}
            >
              {t("wizard.recipe_suggestions_subtitle")}
            </Text>
            {shouldHidePremiumPricing(freePremiumActionsRemaining) ? null : (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  marginBottom: 12,
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    color: isDark ? "#bbb" : "#666",
                  }}
                >
                  {t("wizard.open_recipe_cookie_hint", {
                    defaultValue: "Open a recipe for 1",
                  })}
                </Text>
                <EggIcon size={15} />
              </View>
            )}
            {suggestions.map((sugg, idx) => {
              const suggestionCalories =
                typeof sugg.calories === "number"
                  ? sugg.calories
                  : Number.isFinite(Number(sugg.calories))
                  ? Number(sugg.calories)
                  : null;
              // Sanitize and normalize difficulty for mapping
              const cleanDifficulty = (sugg.difficulty || "")
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .trim();
              let diffLabel = t("difficulty.unknown");
              if (cleanDifficulty === "easy") {
                diffLabel = t("difficulty.easy");
              } else if (
                cleanDifficulty === "medium" ||
                cleanDifficulty === "moderate"
              ) {
                diffLabel = t("difficulty.moderate");
              } else if (
                cleanDifficulty === "hard" ||
                cleanDifficulty === "challenging"
              ) {
                diffLabel = t("difficulty.challenging");
              }
              return (
                <TouchableOpacity
                  key={sugg.id || idx}
                  style={{
                    backgroundColor: "#fff",
                    borderRadius: 14,
                    padding: 16,
                    marginBottom: 14,
                    borderWidth: 1,
                    borderColor: "#e0e0e0",
                    shadowColor: "#000",
                    shadowOpacity: 0.05,
                    shadowRadius: 2,
                    shadowOffset: { width: 0, height: 2 },
                  }}
                  onPress={() => fetchFullRecipe(sugg)}
                >
                  <Text style={{ fontSize: 18, fontWeight: "700", color: "#293a53" }}>
                    {sugg.title}
                  </Text>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      flexWrap: "wrap",
                      columnGap: 12,
                      rowGap: 4,
                      marginTop: 6,
                    }}
                  >
                    <Text style={{ color: "#666" }}>
                      ⏱ {sugg.cookingTime || sugg.time || "?"} min
                    </Text>
                    <Text style={{ color: "#666" }}>{diffLabel}</Text>
                    {typeof suggestionCalories === "number" &&
                    Number.isFinite(suggestionCalories) ? (
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                        }}
                      >
                        <MaterialCommunityIcons
                          name="fire"
                          size={15}
                          color="#E27D60"
                          style={{ marginRight: 4 }}
                        />
                        <Text style={{ color: "#666" }}>{`${Math.round(suggestionCalories)} kcal`}</Text>
                      </View>
                    ) : null}
                  </View>
                  {sugg.description && (
                    <Text style={{ color: "#222", marginTop: 8 }}>
                      {sugg.description}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}
            <AppButton
              label={t("wizard.button_generate_more")}
              onPress={generateRecipe}
              variant="secondary"
              fullWidth
            />
            <AppButton
              label={t("wizard.button_back_wizard")}
              onPress={async () => {
                setSuggestions([]);
                setSuggestionHistory([]);
                setCachedRecipesBySuggestionId({});
                await Promise.all([
                  AsyncStorage.removeItem(AI_KITCHEN_SUGGESTIONS_KEY),
                  AsyncStorage.removeItem(AI_KITCHEN_SUGGESTION_HISTORY_KEY),
                  AsyncStorage.removeItem(AI_KITCHEN_RECIPE_CACHE_KEY),
                ]).catch(() => {});
                setStep(1);
              }}
              variant="secondary"
              fullWidth
              style={{ marginTop: 10 }}
            />
          </View>
        ) : (
          <>
            <Animated.View
              style={{
                flex: 1,
                opacity: contentAnim,
                transform: [
                  {
                    translateY: contentAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [20, 0],
                    }),
                  },
                ],
              }}
            >
              {/* Remove chef icon from step content, now shown above */}
              {step === 1 && (
                <View style={[styles.step, { paddingBottom: 120, flexGrow: 1 }]}>
                  <Animated.Text
                    style={[
                      styles.questionSmall,
                      {
                        opacity: contentAnim,
                        transform: [
                          {
                            translateY: contentAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [10, 0],
                            }),
                          },
                        ],
                        fontSize: 18,
                        color: isDark ? "#f5f5f5" : "#293a53",
                      },
                    ]}
                  >
                    {t("wizard.step1_meal_question")}
                  </Animated.Text>
                  <View style={styles.optionsRow}>
                    {mealOptions.map((m) => (
                      <TouchableOpacity
                        key={m.labelKey}
                        style={[
                          styles.optionChip,
                          {
                            backgroundColor: mealType === m.labelKey
                              ? (isDark ? "#E27D60" : "#293a53")
                              : "#E0E0E0"
                          },
                        ]}
                        onPress={() => setMealType(m.labelKey)}
                      >
                        <Text style={{ color: mealType === m.labelKey ? "#fff" : "#000", fontSize: 15 }}>
                          {m.icon} {t(m.labelKey)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Animated.Text
                    style={[
                      styles.questionSmall,
                      {
                        opacity: contentAnim,
                        transform: [
                          {
                            translateY: contentAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [10, 0],
                            }),
                          },
                        ],
                        fontSize: 18,
                        color: isDark ? "#f5f5f5" : "#293a53",
                      },
                    ]}
                  >
                    {t("wizard.step1_note_question")}
                  </Animated.Text>
                  <TextInput
                    style={[styles.input, { fontSize: 16 }]}
                    placeholder={t("wizard.step1_note_placeholder", "e.g. I want a burger today")}
                    placeholderTextColor="#888"
                    value={note}
                    onChangeText={setNote}
                    multiline
                  />
                  {/* Buttons at the bottom of scrollable content */}
                  <View style={styles.buttonRow}>
                    {step > 1 && (
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <AppButton
                          label={t("wizard.button_back")}
                          onPress={prevStep}
                          variant="secondary"
                          fullWidth
                        />
                      </View>
                    )}
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <AppButton
                        label={t("wizard.button_next")}
                        onPress={nextStep}
                        variant="cta"
                        fullWidth
                      />
                    </View>
                  </View>
                </View>
              )}
              {/* Step 2: people, time */}
              {step === 2 && (
                <View style={[styles.step, { paddingBottom: 120, flexGrow: 1 }]}>
                  <Animated.Text
                    style={[
                      styles.questionSmall,
                      {
                        opacity: contentAnim,
                        transform: [
                          {
                            translateY: contentAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [10, 0],
                            }),
                          },
                        ],
                        fontSize: 18,
                        color: isDark ? "#f5f5f5" : "#293a53",
                      },
                    ]}
                  >
                    {t("wizard.step2_people")}
                  </Animated.Text>
                  <View style={styles.stepperRow}>
                    <TouchableOpacity
                      style={[
                        styles.stepperButton,
                        { backgroundColor: isDark ? "#E27D60" : "#293a53" }
                      ]}
                      onPress={() => setPeople(Math.max(1, people - 1))}
                    >
                      <MaterialIcons name="remove" size={20} color="#fff" />
                    </TouchableOpacity>
                    <Text
                      style={[
                        styles.stepperValue,
                        { color: isDark ? "#f5f5f5" : "#293a53" }
                      ]}
                    >
                      {people}
                    </Text>
                    <TouchableOpacity
                      style={[
                        styles.stepperButton,
                        { backgroundColor: isDark ? "#E27D60" : "#293a53" }
                      ]}
                      onPress={() => setPeople(Math.min(999, people + 1))}
                    >
                      <MaterialIcons name="add" size={20} color="#fff" />
                    </TouchableOpacity>
                  </View>

                  <Animated.Text
                    style={[
                      styles.questionSmall,
                      { marginTop: 14 },
                      {
                        opacity: contentAnim,
                        transform: [
                          {
                            translateY: contentAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [10, 0],
                            }),
                          },
                        ],
                        fontSize: 18,
                        color: isDark ? "#f5f5f5" : "#293a53",
                      },
                    ]}
                  >
                    {t("wizard.step2_time")}
                  </Animated.Text>
                  <View style={styles.optionsRow}>
                    {[
                      { key: "quick", label: t("wizard.step2_time_quick", "Quick (5–15 min)") },
                      { key: "medium", label: t("wizard.step2_time_medium", "Medium (30–60 min)") },
                      { key: "slow", label: t("wizard.step2_time_slow", "Slow Cook (2h+)") },
                    ].map((tOpt) => (
                      <TouchableOpacity
                        key={tOpt.key}
                        style={[
                          styles.optionChip,
                          {
                            backgroundColor:
                              time === tOpt.key
                                ? (isDark ? "#E27D60" : "#293a53")
                                : "#E0E0E0"
                          },
                        ]}
                        onPress={() => setTime(tOpt.key as any)}
                      >
                        <Text style={{ color: time === tOpt.key ? "#fff" : "#000", fontSize: 15 }}>
                          {tOpt.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {/* Buttons at the bottom of scrollable content */}
                  <View style={styles.buttonRow}>
                    {step > 1 && (
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <AppButton
                          label={t("wizard.button_back")}
                          onPress={prevStep}
                          variant="secondary"
                          fullWidth
                        />
                      </View>
                    )}
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <AppButton
                        label={t("wizard.button_next")}
                        onPress={nextStep}
                        variant="cta"
                        fullWidth
                      />
                    </View>
                  </View>
                </View>
              )}
              {/* Step 3: Dietary/Avoid */}
              {step === 3 && (
                <View style={[styles.step, { paddingBottom: 120, flexGrow: 1 }]}>
                  <Animated.Text
                    style={[
                      styles.questionSmall,
                      {
                        opacity: contentAnim,
                        transform: [
                          {
                            translateY: contentAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [10, 0],
                            }),
                          },
                        ],
                        fontSize: 18,
                        color: isDark ? "#f5f5f5" : "#293a53",
                      },
                    ]}
                  >
                    {t("wizard.step3_dietary")}
                  </Animated.Text>
                  <View style={styles.optionsRow}>
                    {Object.entries(allDietaryOptions)
                      .filter(([key]) => key !== "dietary.none" && key.toLowerCase() !== "none")
                      .map(([key, option]) => (
                        <TouchableOpacity
                          key={key}
                          style={[
                            styles.optionChip,
                            {
                              backgroundColor: dietary.includes(key)
                                ? (isDark ? "#E27D60" : "#293a53")
                                : "#E0E0E0"
                            },
                          ]}
                          onPress={() => toggleDietary(key)}
                        >
                          <Text style={{ color: dietary.includes(key) ? "#fff" : "#000", fontSize: 15 }}>
                            {option.icon} {option.label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                  </View>

                  <Animated.Text
                    style={[
                      styles.questionSmall,
                      { marginTop: 14 },
                      {
                        opacity: contentAnim,
                        transform: [
                          {
                            translateY: contentAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [10, 0],
                            }),
                          },
                        ],
                        fontSize: 18,
                        color: isDark ? "#f5f5f5" : "#293a53",
                      },
                    ]}
                  >
                    {t("wizard.step3_avoid")}
                  </Animated.Text>
                  <View>
                    <View style={styles.optionsRow}>
                      {Object.entries(allAvoidOptions)
                        .filter(([key]) => key !== "avoid.none" && key.toLowerCase() !== "none")
                        .map(([key, option]) => (
                          <TouchableOpacity
                            key={key}
                            style={[
                              styles.optionChip,
                              {
                                backgroundColor: avoid.includes(key)
                                  ? (isDark ? "#E27D60" : "#293a53")
                                  : "#E0E0E0"
                              },
                            ]}
                            onPress={() => toggleAvoid(key)}
                          >
                            <Text style={{ color: avoid.includes(key) ? "#fff" : "#000", fontSize: 15 }}>
                              {option.icon} {option.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                    </View>
                    {/* Show "other" input if selected, using Profile.tsx texts */}
                    {avoid.includes("other") && (
                      <View style={{ marginTop: 12 }}>
                        <Text
                          style={{
                            marginBottom: 6,
                            fontSize: 15,
                            color: isDark ? "#f5f5f5" : "#293a53",
                          }}
                        >
                          {t("profile.avoid_other_label")}
                        </Text>
                        <TextInput
                          style={[styles.input, { fontSize: 16, marginTop: 0 }]}
                          placeholder={t("profile.avoid_other_placeholder")}
                          placeholderTextColor="#888"
                          value={avoidOther}
                          onChangeText={(text) => setAvoidOther(sanitizeAvoidOther(text))}
                          multiline
                        />
                      </View>
                    )}
                  </View>
                  {/* Buttons at the bottom of scrollable content */}
                  <View style={styles.buttonRow}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <AppButton
                        label={t("wizard.button_back")}
                        onPress={prevStep}
                        variant="secondary"
                        fullWidth
                      />
                    </View>
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <AppButton
                        label={t("wizard.button_generate")}
                        onPress={generateRecipe}
                        variant="cta"
                        fullWidth
                      />
                    </View>
                  </View>
                </View>
              )}
            </Animated.View>
          </>
        )}
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Reduce top padding so the gap from header to progress bar/chef shrinks
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 0 },
  step: { flex: 1, justifyContent: "flex-start", gap: 16 },
  question: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
    color: "#293a53",
  },
  questionLarge: {
    fontSize: 26,
    fontWeight: "700",
    marginBottom: 10,
    color: "#293a53",
  },
  // Consistent, smaller top margin for all step/suggestion titles
  questionSmall: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
    color: "#293a53",
    marginTop: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    minHeight: 60,
    backgroundColor: "#fff",
    marginBottom: 16,
  },
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  stepperButton: {
    backgroundColor: "#293a53",
    padding: 8,
    borderRadius: 8,
  },
  stepperValue: {
    fontSize: 18,
    marginHorizontal: 16,
    fontWeight: "600",
    color: "#293a53",
  },
  optionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
  },
  optionChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 20,
  },
  chefImage: {
    alignSelf: "center",
    width: 120,
    height: 120,
    marginBottom: 10,
  },
  chefImageSmall: {
    alignSelf: "center",
    width: 82,
    height: 82,
    marginTop: 10,
    marginBottom: 0,
  },
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
  modalTitle: {
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 8,
  },
  modalBody: {
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
  modalOfferTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalOfferTopLeft: { flexDirection: "row", alignItems: "center", flexShrink: 1 },
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
  buyBtn: {
  backgroundColor: "#E27D60",
  paddingHorizontal: 18,
  paddingVertical: 12,
  borderRadius: 14,
  minWidth: 92,
  alignItems: "center",
  justifyContent: "center",

  // Android elevation
  elevation: 3,

  // iOS shadow (harmless on Android)
  shadowColor: "#000",
  shadowOpacity: 0.18,
  shadowRadius: 4,
  shadowOffset: { width: 0, height: 2 },
},
buyBtnText: {
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
});
