import React, { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Image,
  Animated,
  Share,
  Modal,
  TouchableWithoutFeedback,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "../../../context/ThemeContext";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDeviceId } from "../../../utils/deviceId";
import { getApiBaseUrl } from "../../../lib/config/api";
import {
  fetchEconomyCatalogBundle,
  fetchEconomySnapshot,
  shouldHidePremiumPricing,
  writeCachedEconomySnapshot,
  type EconomyCatalogOffer,
} from "../../../lib/economy/client";
import AppCard from "../../../components/AppCard";
import InsufficientCookiesModal from "../../../components/InsufficientCookiesModal";
import EggIcon from "../../../components/EggIcon";
import { MaterialIcons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { syncEngine } from "../../../lib/sync/SyncEngine";
import {
  RecipeNutritionInfo,
  getRecipeCaloriesPerServing,
} from "../../../lib/recipes/nutrition";
import { normalizeRecipeDifficulty } from "../../../lib/recipes/difficulty";
import {
  estimateRecipeNutrition,
  resolveRecipeNutritionEstimate,
  SavedRecipe,
} from "../../../lib/myDayRecipes";

const defaultImage = require("../../../assets/default_recipe.png");

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
  createdAt: string;
  updatedAt?: number | string;
  image?: string;
  cookbooks?: (string | { id: string; name: string })[];
  isDeleted?: boolean;
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
  image?: string;
  imageUrl?: string;
  createdAt?: number;
  updatedAt?: number;
  isDeleted?: boolean;
}

export default function RecipeDetail() {
  const insets = useSafeAreaInsets();
  const auth = getAuth();
  const { id, recipe, from, tempRecipeKey } = useLocalSearchParams<{
    id?: string;
    recipe?: string;
    from?: string;
    tempRecipeKey?: string;
  }>();
  const [currentRecipe, setCurrentRecipe] = useState<Recipe | null>(null);
  const [servings, setServings] = useState<number>(1);
  const [cookbookNames, setCookbookNames] = useState<string[]>([]);
  const [isSaved, setIsSaved] = useState(false);
  const [isEstimatingNutrition, setIsEstimatingNutrition] = useState(false);
  const router = useRouter();
  const { bg, text, subText } = useThemeColors();
  const { t, i18n } = useTranslation();

  // economy / cookies gating (cookbook creation)
  const backendUrl = getApiBaseUrl();
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  const isDark = bg !== "#fff";

  const [insufficientModal, setInsufficientModal] = useState<{
    visible: boolean;
    remaining: number;
    context: "cookbook" | "nutrition_estimate";
  }>(
    { visible: false, remaining: 0, context: "cookbook" }
  );
  const [freePremiumActionsRemaining, setFreePremiumActionsRemaining] = useState<number | null>(null);
  const [availableRewardsCount, setAvailableRewardsCount] = useState(0);
  const [featuredOffer, setFeaturedOffer] = useState<EconomyCatalogOffer | null>(null);
  const editRecipe = () => {
    if (!currentRecipe) return;
    router.push({
      pathname: "/add-recipe",
      params: { edit: JSON.stringify(currentRecipe) },
    });
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
    } catch {
      router.push("/economy/store" as any);
    }
  };

  const openInsufficientCookiesModal = async (
    remaining: number | null | undefined,
    context: "cookbook" | "nutrition_estimate" = "cookbook"
  ) => {
    const rem = typeof remaining === "number" ? remaining : 0;

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

  const ensureAuthUid = async (): Promise<{ uid: string; token: string } | null> => {
    try {
      if (auth.currentUser) {
        const token = await auth.currentUser.getIdToken();
        return { uid: auth.currentUser.uid, token };
      }
      // Sign in anonymously to obtain a UID/token when user isn't logged in
      const cred = await signInAnonymously(auth);
      const token = await cred.user.getIdToken();
      return { uid: cred.user.uid, token };
    } catch (e) {
      console.warn("[RecipeDetail] ensureAuthUid failed", e);
      return null;
    }
  };

  const buildIngredientsSignature = (lines: unknown) => {
    if (Array.isArray(lines)) {
      return lines
        .map((line) => String(line || "").trim())
        .filter(Boolean)
        .join("|");
    }

    if (typeof lines === "string") {
      return lines
        .split(/\r?\n/)
        .map((line) => String(line || "").trim())
        .filter(Boolean)
        .join("|");
    }

    return "";
  };

  const requestNutritionEstimateEconomy = async (
    mode: "preview" | "commit"
  ): Promise<boolean> => {
    try {
      if (!backendUrl) {
        console.warn("[RecipeDetail] No backend URL configured; skipping economy consume for nutrition estimate");
        return true;
      }

      const authInfo = await ensureAuthUid();
      if (!authInfo?.token) {
        console.warn("[RecipeDetail] Missing auth token for nutrition estimate consume; blocking estimate");
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
      console.warn("[RecipeDetail] nutrition estimate consume exception; blocking estimate", err);
      Alert.alert(
        t("common.error", "Error"),
        t("economy.try_again", "Couldn't verify your Egg balance. Please try again.")
      );
      return false;
    }
  };

  // ✅ Persisted animation value
  const fabAnim = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      (async () => {
        try {
          let storedRecipe: Recipe | null = null;
          let paramRecipe: Recipe | null = null;

          // 1) Try to load from AsyncStorage using id (this is our source of truth)
          if (id) {
            const stored = await AsyncStorage.getItem("recipes");
            const arr: Recipe[] = stored ? JSON.parse(stored) : [];
            const found = arr.find((r) => r.id === id);
            if (found) {
              storedRecipe = found;
            }
          }

          // 2) Try a temporary local recipe handoff key (used by AI Kitchen)
          if (tempRecipeKey) {
            try {
              const tempStored = await AsyncStorage.getItem(tempRecipeKey as string);
              if (tempStored) {
                paramRecipe = JSON.parse(tempStored) as Recipe;
              }
            } catch (e) {
              console.warn("[RecipeDetail] Failed to load temp recipe param:", e);
            }
          }

          // 3) Also parse recipe param if present (may come from navigation)
          if (!paramRecipe && recipe) {
            try {
              paramRecipe = JSON.parse(recipe as string) as Recipe;
            } catch (e) {
              console.warn("[RecipeDetail] Failed to parse recipe param:", e);
            }
          }

          // 4) Merge both, preferring storedRecipe but falling back to paramRecipe for any missing fields
          let merged: Recipe | null = null;
          if (storedRecipe && paramRecipe) {
            merged = {
              ...paramRecipe,
              ...storedRecipe,
            };
            // Make sure we keep a valid image if one of them has it
            const storedImg = storedRecipe.image;
            const paramImg = paramRecipe.image;
            if ((storedImg === undefined || storedImg === null || storedImg === "" || storedImg === "null" || storedImg === "undefined") && paramImg) {
              merged.image = paramImg;
            } else if (!merged.image && (paramImg || storedImg)) {
              merged.image = (storedImg || paramImg) as any;
            }
          } else {
            merged = storedRecipe || paramRecipe;
          }

          if (isActive && merged) {
            setCurrentRecipe(merged);
            setServings(merged.servings || 1);
            if (merged.cookbooks && merged.cookbooks.length > 0) {
              await loadCookbookNames(merged.cookbooks);
            } else {
              setCookbookNames([]);
            }
          }
        } catch (err) {
          console.error("Failed to load recipe:", err);
        }
      })();

      // Animate FAB in
      Animated.timing(fabAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();

      return () => {
        isActive = false;
      };
    }, [id, recipe])
  );

  useEffect(() => {
    if (currentRecipe?.cookbooks && currentRecipe.cookbooks.length > 0) {
      loadCookbookNames(currentRecipe.cookbooks);
    } else {
      setCookbookNames([]);
    }
  }, [currentRecipe?.cookbooks]);

  // Check if recipe is saved
  useEffect(() => {
    const checkIsSaved = async () => {
      if (!currentRecipe) {
        setIsSaved(false);
        return;
      }
      try {
        const stored = await AsyncStorage.getItem("recipes");
        const arr: Recipe[] = stored ? JSON.parse(stored) : [];
        const exists = arr.find((r) => r.id === currentRecipe.id);
        setIsSaved(!!exists);
      } catch (error) {
        setIsSaved(false);
      }
    };
    checkIsSaved();
  }, [currentRecipe]);

  const loadCookbookNames = async (cookbookField: (string | { id: string; name: string })[]) => {
    try {
      const storedCookbooks = await AsyncStorage.getItem("cookbooks");
      const allCookbooks: Cookbook[] = storedCookbooks ? JSON.parse(storedCookbooks) : [];

      // Only consider cookbooks that are not deleted.
      const activeCookbooks = allCookbooks.filter((c) => c && c.id && c.isDeleted !== true);

      const names = cookbookField
        .map((cb) => {
          const id = typeof cb === "string" ? cb : cb?.id;
          if (!id || typeof id !== "string") return "";

          const match = activeCookbooks.find((c) => c.id === id);
          // If not found locally, or marked deleted, do not show it.
          if (!match) return "";

          // Prefer local canonical name; fall back to embedded name if needed.
          const embeddedName = typeof cb === "object" && cb ? String(cb.name ?? "") : "";
          return (match.name || embeddedName || "").trim();
        })
        .filter((n) => typeof n === "string" && n.trim().length > 0);

      setCookbookNames(names);
    } catch (error) {
      console.error("Failed to load cookbooks:", error);
      setCookbookNames([]);
    }
  };

  const loadCookbooksSnapshot = async (): Promise<Cookbook[]> => {
    try {
      const storedCookbooks = await AsyncStorage.getItem("cookbooks");
      const parsed: Cookbook[] = storedCookbooks ? JSON.parse(storedCookbooks) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map((cb: any) => ({
        ...cb,
        image: cb.image || cb.imageUrl || undefined,
      }));
    } catch {
      return [];
    }
  };

  async function syncCookbooksSnapshot(updated: Cookbook[]) {
    try {
      if (!syncEngine) {
        console.warn("[RecipeDetail] syncEngine is not available (unexpected). Falling back to AsyncStorage only.");
        await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));
        return;
      }

      if (typeof (syncEngine as any).saveLocalCookbooksSnapshot !== "function") {
        console.warn(
          "[RecipeDetail] syncEngine.saveLocalCookbooksSnapshot is not available; falling back to legacy AsyncStorage only"
        );
        await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));
        return;
      }

      await (syncEngine as any).saveLocalCookbooksSnapshot(updated);

      if (typeof (syncEngine as any).requestSync === "function") {
        (syncEngine as any).requestSync("manual");
      }
    } catch (err) {
      console.warn("[RecipeDetail] syncCookbooksSnapshot failed", err);
      try {
        await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));
      } catch {
        // ignore
      }
    }
  }

  const handleBack = () => {
    if (from === "ai-kitchen") {
      router.replace("/");
    } else if (from === "history") {
      router.replace("/(tabs)/history");
    } else if (from && from.startsWith("cookbook:")) {
      const cookbookId = from.split(":")[1];
      router.push(`/cookbook/${cookbookId}`);
    } else {
      router.replace("/(tabs)/history");
    }
  };

  const deleteRecipe = async () => {
    if (!currentRecipe) return;
    Alert.alert(t("recipes.delete_recipe_confirm"), t("recipes.delete_recipe_desc"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: async () => {
          // Mark deleted locally (dirty) + trigger a full sync.
          // We intentionally run a full sync because cookbook/preferences may have pending dirty state too.
          if (syncEngine) {
            try {
              const recipeSync = (syncEngine as any)?.recipeSync;
              if (recipeSync && typeof recipeSync.markLocalDeleted === "function") {
                await recipeSync.markLocalDeleted(currentRecipe.id);
              }
              // Trigger a full sync immediately (bypass throttling).
              await syncEngine.syncAll("manual", { bypassThrottle: true });
            } catch (e) {
              console.warn("[RecipeDetail] deleteRecipe sync failed", e);
            }
          }

          // 🔹 Analytics: manual recipe deleted (reuses /analytics-event)
          try {
            const backendUrl = getApiBaseUrl();
            if (backendUrl && currentRecipe) {
              const currentUser = auth.currentUser;
              const userId = currentUser?.uid ?? null;

              let deviceId: string | null = null;
              try {
                deviceId = await getDeviceId();
              } catch (e) {
                console.warn("[RecipeDetail] getDeviceId failed for delete analytics", e);
              }

              const headers: Record<string, string> = {
                "Content-Type": "application/json",
              };
              if (deviceId) headers["x-device-id"] = deviceId;
              if (userId) headers["x-user-id"] = userId;

              fetch(`${backendUrl}/analytics-event`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  eventType: "manual_recipe_deleted",
                  userId,
                  deviceId,
                  metadata: {
                    source: "recipe_detail",
                    recipeId: currentRecipe.id,
                    title: currentRecipe.title,
                    hasImage: !!currentRecipe.image,
                    ingredientsCount: currentRecipe.ingredients.length,
                    stepsCount: currentRecipe.steps.length,
                    tagsCount: currentRecipe.tags.length,
                    cookbooksCount: currentRecipe.cookbooks ? currentRecipe.cookbooks.length : 0,
                  },
                }),
              }).catch((err) => {
                console.warn("[RecipeDetail] analytics-event fetch failed", err);
              });
            }
          } catch (e) {
            console.warn("[RecipeDetail] analytics logging failed", e);
          }

          router.back();
        },
      },
    ]);
  };



const startCooking = () => {
  if (!currentRecipe) return;

  // fade out FAB then navigate
  Animated.timing(fabAnim, {
    toValue: 0,
    duration: 200,
    useNativeDriver: true,
  }).start(() => {
    router.push({
      pathname: "/recipe/start-cooking", // ✅ correct route
      params: { recipe: JSON.stringify(currentRecipe) },
    });
  });
};

const shareRecipe = async () => {
  if (!currentRecipe) return;
  try {
    const message = `${currentRecipe.title}\n\nIngredients:\n${currentRecipe.ingredients.join(
      "\n"
    )}\n\nSteps:\n${currentRecipe.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
    await Share.share({
      message,
      title: currentRecipe.title,
    });
  } catch (error) {
    Alert.alert(t("common.error_generic"), t("recipes.share_error"));
  }
};

const scaleIngredient = (ingredient: string) => {
  // This helper attempts to find numbers in the ingredient string and scale them
  // For example: "2 cups flour" with servings 4 and base servings 2 => "4 cups flour"
  if (!currentRecipe) return ingredient;
  const baseServings =
    typeof currentRecipe.servings === "number" && currentRecipe.servings > 0
      ? currentRecipe.servings
      : 1;
  if (baseServings === servings) return ingredient;

  return ingredient.replace(/(\d+(\.\d+)?)/g, (match) => {
    const num = parseFloat(match);
    if (isNaN(num)) return match;
    const scaled = (num * servings) / baseServings;
    // Format to max 2 decimals, remove trailing zeros
    return scaled % 1 === 0 ? scaled.toString() : scaled.toFixed(2).replace(/\.?0+$/, "");
  });
};

const saveRecipe = async () => {
  if (!currentRecipe) return;

  try {
    const nowTs = Date.now();

    // Normalize updatedAt to a numeric timestamp.
    const withUpdatedAt: any = {
      ...currentRecipe,
      updatedAt: nowTs,
    };

    // If this recipe references cookbooks that don't exist locally yet (e.g. created during edit flow),
    // persist those cookbooks first (and apply economy gating), aligned with History.tsx/add-recipe.tsx.
    try {
      const cbField = Array.isArray(withUpdatedAt.cookbooks) ? withUpdatedAt.cookbooks : [];
      const cookbookIdsInRecipe = cbField
        .map((cb: any) => (typeof cb === "string" ? cb : cb?.id))
        .filter((v: any) => typeof v === "string" && v.trim().length > 0) as string[];

      const cookbookObjsInRecipe = cbField
        .map((cb: any) => (typeof cb === "object" && cb ? cb : null))
        .filter(Boolean) as Array<{ id: string; name?: string }>;

      if (cookbookIdsInRecipe.length > 0) {
        const existingCookbooks = await loadCookbooksSnapshot();
        const existingIds = new Set(existingCookbooks.map((c) => c.id));

        const missingIds = cookbookIdsInRecipe.filter((cid) => !existingIds.has(cid));
        if (missingIds.length > 0) {
          let updatedCookbooks = [...existingCookbooks];

          for (const missingId of missingIds) {
            const fromObj = cookbookObjsInRecipe.find((o) => o.id === missingId);
            const name = (fromObj?.name || "").trim() || t("recipes.cookbook");
            const now = Date.now();
            const newCb: Cookbook = {
              id: missingId,
              name,
              createdAt: now,
              updatedAt: now,
            };
            updatedCookbooks = [...updatedCookbooks, newCb];
            existingIds.add(missingId);

            // Best-effort: mark cookbook dirty (History.tsx relies on snapshot; AddRecipe also marks dirty explicitly)
            try {
              if (syncEngine && typeof (syncEngine as any).markCookbookDirty === "function") {
                await (syncEngine as any).markCookbookDirty({ id: newCb.id, name: newCb.name });
              }
            } catch (e) {
              console.warn("[RecipeDetail] failed to mark cookbook dirty", e);
            }
          }

          await syncCookbooksSnapshot(updatedCookbooks);
        }
      }
    } catch (e) {
      // Safety: never block saving a recipe due to cookbook persistence issues.
      console.warn("[RecipeDetail] cookbook persistence during saveRecipe failed", e);
    }

    // 1) Persist locally so UI stays consistent.
    const stored = await AsyncStorage.getItem("recipes");
    const arr: Recipe[] = stored ? JSON.parse(stored) : [];
    const next = arr.some((r) => r.id === withUpdatedAt.id)
      ? arr.map((r) => (r.id === withUpdatedAt.id ? withUpdatedAt : r))
      : [...arr, withUpdatedAt];

    // Prefer sync engine helper when available, but always fall back to AsyncStorage.
    const helper = (syncEngine as any)?.saveLocalRecipesSnapshot;
    if (syncEngine && typeof helper === "function") {
      try {
        await helper.call(syncEngine, next);
      } catch (e) {
        await AsyncStorage.setItem("recipes", JSON.stringify(next));
      }
    } else {
      await AsyncStorage.setItem("recipes", JSON.stringify(next));
    }

    // 2) Mark recipe as dirty in the sync store using the SAME shape as add-recipe.tsx.
    if (syncEngine && typeof (syncEngine as any).markRecipeDirty === "function") {
      // Map UI difficulty/cost to sync-friendly values.
      const difficultyForSync =
        withUpdatedAt.difficulty === "Easy"
          ? "easy"
          : withUpdatedAt.difficulty === "Moderate"
          ? "medium"
          : "hard";

      const costForSync =
        withUpdatedAt.cost === "Cheap"
          ? "low"
          : withUpdatedAt.cost === "Medium"
          ? "medium"
          : withUpdatedAt.cost === "Expensive"
          ? "high"
          : null;

      const cookbookIds = Array.isArray(withUpdatedAt.cookbooks)
        ? withUpdatedAt.cookbooks
            .map((cb: any) => (typeof cb === "string" ? cb : cb?.id))
            .filter((v: any) => typeof v === "string" && v.trim().length > 0)
        : [];

      // Try to derive a stable createdAt numeric timestamp.
      const createdAtTs = (() => {
        const v = (withUpdatedAt as any)?.createdAt;
        if (typeof v === "number") return v;
        if (typeof v === "string") {
          const ms = Date.parse(v);
          return Number.isFinite(ms) ? ms : nowTs;
        }
        return nowTs;
      })();

      const imageUrlForSync =
        typeof withUpdatedAt.image === "string" && withUpdatedAt.image.trim()
          ? withUpdatedAt.image.trim()
          : null;

      await (syncEngine as any).markRecipeDirty({
        id: withUpdatedAt.id,
        title: withUpdatedAt.title,
        imageUrl: imageUrlForSync,
        cookingTimeMinutes: withUpdatedAt.cookingTime || 30,
        servings: withUpdatedAt.servings || 2,
        difficulty: difficultyForSync,
        ...(costForSync !== null ? { cost: costForSync } : {}),
        ingredients: Array.isArray(withUpdatedAt.ingredients) ? [...withUpdatedAt.ingredients] : [],
        steps: Array.isArray(withUpdatedAt.steps) ? [...withUpdatedAt.steps] : [],
        cookbookIds,
        tags: Array.isArray(withUpdatedAt.tags) ? [...withUpdatedAt.tags] : [],
        createdAt: createdAtTs,
        updatedAt: nowTs,
        isDeleted: false,
      });

      // 3) Trigger a full sync immediately (bypass throttling)
      if (typeof (syncEngine as any).syncAll === "function") {
        await (syncEngine as any).syncAll("manual", { bypassThrottle: true });
      } else if (typeof (syncEngine as any).requestSync === "function") {
        (syncEngine as any).requestSync("manual");
      }
    } else if (syncEngine) {
      // Fallback: keep previous behavior if markRecipeDirty is not available.
      const recipeSync = (syncEngine as any)?.recipeSync;
      if (recipeSync && typeof recipeSync.upsertLocalRecipe === "function") {
        await recipeSync.upsertLocalRecipe(withUpdatedAt);
      } else if (recipeSync && typeof recipeSync.updateLocalRecipe === "function") {
        await recipeSync.updateLocalRecipe(withUpdatedAt);
      }
      if (typeof (syncEngine as any).syncAll === "function") {
        await (syncEngine as any).syncAll("manual", { bypassThrottle: true });
      } else if (typeof (syncEngine as any).requestSync === "function") {
        (syncEngine as any).requestSync("manual");
      }
    }

    Alert.alert(t("common.done"), t("recipes.save_success"));
    setIsSaved(true);
  } catch (error) {
    Alert.alert(t("common.error_generic"), t("recipes.save_error"));
    console.error("Failed to save recipe:", error);
  }
};

const estimateNutritionForRecipe = async () => {
  if (!currentRecipe || !Array.isArray(currentRecipe.ingredients) || currentRecipe.ingredients.length === 0) {
    return;
  }

  let recipeForEstimate: SavedRecipe | null = null;
  try {
    const allowed = await requestNutritionEstimateEconomy("preview");
    if (!allowed) return;

    setIsEstimatingNutrition(true);
    await new Promise((resolve) => setTimeout(resolve, 350));

    recipeForEstimate = {
      id: currentRecipe.id,
      title: currentRecipe.title,
      servings: Number(currentRecipe.servings) > 0 ? Math.max(Number(currentRecipe.servings), 1) : null,
      ingredients: currentRecipe.ingredients || [],
      nutritionInfo: null,
      nutrition: null,
    };
    let nutrition;
    let mealLoggingRepresentation = null;
    try {
      const resolved = await resolveRecipeNutritionEstimate(recipeForEstimate, i18n.language);
      nutrition = resolved.nutrition;
      mealLoggingRepresentation = null;
    } catch (error) {
      console.warn("[RecipeDetail] resolveRecipeNutritionEstimate failed, using local fallback", error);
      nutrition = estimateRecipeNutrition(recipeForEstimate);
      mealLoggingRepresentation = null;
    }

    const committed = await requestNutritionEstimateEconomy("commit");
    if (!committed) return;

    const nutritionInfo: RecipeNutritionInfo = {
      perServing: {
        calories: nutrition.caloriesPerServing,
        protein: nutrition.proteinPerServing,
        carbs: nutrition.carbsPerServing,
        fat: nutrition.fatPerServing,
      },
      source: "estimated",
      updatedAt: new Date().toISOString(),
    };

    const updatedRecipe: Recipe = {
      ...currentRecipe,
      servings: nutrition.servings && nutrition.servings > 0 ? nutrition.servings : currentRecipe.servings,
      servingInfo: nutrition.servingInfo ?? (currentRecipe as any).servingInfo ?? null,
      nutritionInfo,
      mealLoggingRepresentation,
      nutritionEstimateMeta: {
        ingredientsSignature: buildIngredientsSignature(currentRecipe.ingredients),
        perServing: {
          calories: String(nutritionInfo.perServing.calories ?? ""),
          protein: String(nutritionInfo.perServing.protein ?? ""),
          carbs: String(nutritionInfo.perServing.carbs ?? ""),
          fat: String(nutritionInfo.perServing.fat ?? ""),
        },
      },
    };

    setCurrentRecipe(updatedRecipe);
    if (updatedRecipe.servings && updatedRecipe.servings > 0) {
      setServings(updatedRecipe.servings);
    }

    try {
      const stored = await AsyncStorage.getItem("recipes");
      const arr: Recipe[] = stored ? JSON.parse(stored) : [];
      const next = arr.map((recipe) => (recipe.id === updatedRecipe.id ? updatedRecipe : recipe));
      await AsyncStorage.setItem("recipes", JSON.stringify(next));

      if (syncEngine && typeof (syncEngine as any).saveLocalRecipesSnapshot === "function") {
        try {
          await (syncEngine as any).saveLocalRecipesSnapshot(next);
        } catch {
          // ignore and keep local AsyncStorage copy
        }
      }

      if (syncEngine && typeof (syncEngine as any).markRecipeDirty === "function") {
        const nowTs = Date.now();
        const difficultyForSync =
          updatedRecipe.difficulty === "Easy"
            ? "easy"
            : updatedRecipe.difficulty === "Moderate"
            ? "medium"
            : "hard";

        const costForSync =
          updatedRecipe.cost === "Cheap"
            ? "low"
            : updatedRecipe.cost === "Medium"
            ? "medium"
            : updatedRecipe.cost === "Expensive"
            ? "high"
            : null;

        const cookbookIds = Array.isArray(updatedRecipe.cookbooks)
          ? updatedRecipe.cookbooks
              .map((cb: any) => (typeof cb === "string" ? cb : cb?.id))
              .filter((v: any) => typeof v === "string" && v.trim().length > 0)
          : [];

        const createdAtTs = (() => {
          const v = (updatedRecipe as any)?.createdAt;
          if (typeof v === "number") return v;
          if (typeof v === "string") {
            const ms = Date.parse(v);
            return Number.isFinite(ms) ? ms : nowTs;
          }
          return nowTs;
        })();

        const imageUrlForSync =
          typeof updatedRecipe.image === "string" && updatedRecipe.image.trim()
            ? updatedRecipe.image.trim()
            : null;

        await (syncEngine as any).markRecipeDirty({
          id: updatedRecipe.id,
          title: updatedRecipe.title,
          imageUrl: imageUrlForSync,
          cookingTimeMinutes: updatedRecipe.cookingTime || 30,
          servings: updatedRecipe.servings || 2,
          difficulty: difficultyForSync,
          ...(costForSync !== null ? { cost: costForSync } : {}),
          ingredients: Array.isArray(updatedRecipe.ingredients) ? [...updatedRecipe.ingredients] : [],
          steps: Array.isArray(updatedRecipe.steps) ? [...updatedRecipe.steps] : [],
          cookbookIds,
          tags: Array.isArray(updatedRecipe.tags) ? [...updatedRecipe.tags] : [],
          nutritionInfo: updatedRecipe.nutritionInfo ?? null,
          createdAt: createdAtTs,
          updatedAt: nowTs,
          isDeleted: false,
        });

        if (typeof (syncEngine as any).syncAll === "function") {
          await (syncEngine as any).syncAll("manual", { bypassThrottle: true });
        } else if (typeof (syncEngine as any).requestSync === "function") {
          (syncEngine as any).requestSync("manual");
        }
      }
    } catch (persistError) {
      console.warn("[RecipeDetail] estimateNutritionForRecipe persistence warning", persistError);
    }
  } catch (error) {
    console.warn("[RecipeDetail] estimateNutritionForRecipe failed", error);
    if (recipeForEstimate && currentRecipe) {
      try {
        const fallback = estimateRecipeNutrition(recipeForEstimate);
        const fallbackNutritionInfo: RecipeNutritionInfo = {
          perServing: {
            calories: fallback.caloriesPerServing,
            protein: fallback.proteinPerServing,
            carbs: fallback.carbsPerServing,
            fat: fallback.fatPerServing,
          },
          source: "estimated",
          updatedAt: new Date().toISOString(),
        };

        const fallbackRecipe: Recipe = {
          ...currentRecipe,
          nutritionInfo: fallbackNutritionInfo,
          mealLoggingRepresentation: null,
          nutritionEstimateMeta: {
            ingredientsSignature: buildIngredientsSignature(currentRecipe.ingredients),
            perServing: {
              calories: String(fallbackNutritionInfo.perServing.calories ?? ""),
              protein: String(fallbackNutritionInfo.perServing.protein ?? ""),
              carbs: String(fallbackNutritionInfo.perServing.carbs ?? ""),
              fat: String(fallbackNutritionInfo.perServing.fat ?? ""),
            },
          },
        };

        setCurrentRecipe(fallbackRecipe);
        return;
      } catch (fallbackError) {
        console.warn("[RecipeDetail] local fallback estimate failed", fallbackError);
      }
    }
    Alert.alert(t("common.error_generic"), t("recipes.nutrition_estimate_error"));
  } finally {
    setIsEstimatingNutrition(false);
  }
};


// Safely resolve recipe image source (supports string or { uri } object)
const getRecipeImageSource = () => {
  if (!currentRecipe || !currentRecipe.image) {
    return defaultImage;
  }

  const img: any = currentRecipe.image;

  // Case 1: image is a simple string URL/URI
  if (typeof img === "string") {
    const trimmed = img.trim();
    if (!trimmed || trimmed === "null" || trimmed === "undefined") {
      return defaultImage;
    }
    // Let React Native try to load any non-empty URI string (http, file, content, data:, etc.)
    return { uri: trimmed };
  }

  // Case 2: image is an object like { uri: "..." }
  if (typeof img === "object" && img !== null && typeof img.uri === "string") {
    const trimmed = img.uri.trim();
    if (!trimmed || trimmed === "null" || trimmed === "undefined") {
      return defaultImage;
    }
    return { uri: trimmed };
  }

  // Fallback
  return defaultImage;
};

const imageSource = getRecipeImageSource();


// Mappings for difficulty
const difficultyMap = {
  Easy: t("difficulty.easy"),
  Moderate: t("difficulty.moderate"),
  Challenging: t("difficulty.challenging"),
};

// Use map to always show emoji label
const normalizedDifficulty = currentRecipe ? normalizeRecipeDifficulty(currentRecipe.difficulty) : "Easy";
const difficultyDisplay = currentRecipe
  ? difficultyMap[normalizedDifficulty] || normalizedDifficulty
  : "";
const caloriesPerServing = getRecipeCaloriesPerServing(currentRecipe);

return (
  <SafeAreaView style={{ flex: 1, backgroundColor: bg }}>
    <Stack.Screen
      options={{
        headerShown: true,
        title: t("recipes.open_recipe"),
        headerStyle: { backgroundColor: "#293a53" },
        headerTintColor: "#fff",
        headerTitleAlign: "center",
        headerLeft: () => (
          <TouchableOpacity
            onPress={handleBack}
            style={{ padding: 8 }}
          >
            <MaterialIcons name="arrow-back" size={26} color="#fff" />
          </TouchableOpacity>
        ),
        headerRight: () => (
          <View style={{ flexDirection: "row" }}>
            <TouchableOpacity onPress={shareRecipe} style={{ padding: 8 }}>
              <MaterialIcons name="share" size={26} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity onPress={editRecipe} style={{ padding: 8 }}>
              <MaterialIcons name="edit" size={26} color="#fff" />
            </TouchableOpacity>
          </View>
        ),
      }}
    />

    {!currentRecipe ? (
      <View style={[styles.center, { flex: 1 }]}>
        <Text style={{ color: text }}>{t("recipes.not_found", "Recipe not found")}</Text>
      </View>
    ) : (
      <>
        <ScrollView
          style={styles.container}
          contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
        >
          <Image
            source={imageSource}
            style={styles.detailImage}
            resizeMode="cover"
          />

          <Text style={[styles.title, { color: text }]}>{currentRecipe.title}</Text>
          <Text style={{ color: subText, marginBottom: 16 }}>
            {t("recipes.created_on")}{" "}
            {new Date(currentRecipe.createdAt).toLocaleDateString()}
          </Text>

          {/* Quick Info */}
          <AppCard>
            <View style={styles.quickInfo}>
              <View style={styles.quickInfoItem}>
                <Text style={[styles.quickInfoText, { color: text }]}>
                  ⏱ {currentRecipe.cookingTime} min
                </Text>
              </View>
              <View style={styles.quickInfoItem}>
                <Text style={[styles.quickInfoText, { color: text }]}>
                  {difficultyDisplay}
                </Text>
              </View>
              {caloriesPerServing !== null ? (
                <View style={styles.quickInfoItem}>
                  <MaterialCommunityIcons name="fire" size={16} color="#E27D60" />
                  <Text style={[styles.quickInfoText, { color: text }]}>
                    {`${Math.round(caloriesPerServing)} kcal`}
                  </Text>
                </View>
              ) : null}
            </View>
          </AppCard>

          {/* Ingredients */}
          <Text style={[styles.sectionTitle, { color: text }]}>
            {t("recipes.ingredients")}
          </Text>
          <AppCard>
            <View style={styles.servingsRow}>
              <Text style={styles.servingsLabel}>
                {t("recipes.servings", { count: servings })}
              </Text>
              <View style={{ flexDirection: "row" }}>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() =>
                    setServings((prev) => (prev > 1 ? prev - 1 : 1))
                  }
                >
                  <Text style={styles.stepper}>−</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setServings((prev) => prev + 1)}
                >
                  <Text style={styles.stepper}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={[styles.servingsDivider, { backgroundColor: `${text}1F` }]} />
            {currentRecipe.ingredients.map((ing, i) => (
              <Text key={i} style={[styles.text, { color: text }]}>
                • {scaleIngredient(ing)}
              </Text>
            ))}
          </AppCard>

          {/* Preparation */}
          <Text style={[styles.sectionTitle, { color: text }]}>
            {t("recipes.preparation")}
          </Text>
          <AppCard>
            {currentRecipe.steps.map((step, i) => (
              <Text key={i} style={[styles.text, { color: text }]}>
                • {step}
              </Text>
            ))}
          </AppCard>

          {currentRecipe.nutritionInfo ? (
            <>
              <Text style={[styles.sectionTitle, { color: text }]}>
                {t("recipes.nutrition_info", { defaultValue: "Nutrition per serving" })}
              </Text>
              <AppCard>
                <View style={styles.nutritionGrid}>
                  {[
                    {
                      key: "calories",
                      label: t("recipes.nutrition_calories", { defaultValue: "Calories" }),
                      value: currentRecipe.nutritionInfo.perServing.calories,
                      unit: "kcal",
                    },
                    {
                      key: "protein",
                      label: t("recipes.nutrition_protein", { defaultValue: "Protein" }),
                      value: currentRecipe.nutritionInfo.perServing.protein,
                      unit: "g",
                    },
                    {
                      key: "carbs",
                      label: t("recipes.nutrition_carbs", { defaultValue: "Carbs" }),
                      value: currentRecipe.nutritionInfo.perServing.carbs,
                      unit: "g",
                    },
                    {
                      key: "fat",
                      label: t("recipes.nutrition_fat", { defaultValue: "Fat" }),
                      value: currentRecipe.nutritionInfo.perServing.fat,
                      unit: "g",
                    },
                  ].map((item) => (
                    <View key={item.key} style={styles.nutritionItem}>
                      <Text style={[styles.nutritionLabel, { color: subText }]}>{item.label}</Text>
                      <View style={styles.nutritionValueRow}>
                        <Text style={[styles.nutritionValue, { color: text }]}>
                          {item.value ?? "—"}
                        </Text>
                        <Text style={[styles.nutritionUnit, { color: subText }]}>{item.unit}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              </AppCard>
            </>
          ) : (
            <>
              <Text style={[styles.sectionTitle, { color: text }]}>
                {t("recipes.nutrition_info", { defaultValue: "Nutrition per serving" })}
              </Text>
              <AppCard>
                <Text style={[styles.nutritionEmptyText, { color: subText }]}>
                  {t("recipes.nutrition_estimate_prompt", {
                    defaultValue: "Estimate the nutrition values automatically from this recipe's ingredients.",
                  })}
                </Text>
                <TouchableOpacity
                  disabled={isEstimatingNutrition}
                  onPress={estimateNutritionForRecipe}
                  activeOpacity={0.85}
                  style={[
                    styles.estimateButton,
                    {
                      backgroundColor: isEstimatingNutrition
                        ? isDark
                          ? "#3b4352"
                          : "#d7dce5"
                        : bg !== "#fff"
                        ? "#E27D60"
                        : "#293a53",
                      borderColor: isEstimatingNutrition
                        ? isDark
                          ? "#3b4352"
                          : "#d7dce5"
                        : bg !== "#fff"
                        ? "#E27D60"
                        : "#293a53",
                      opacity: isEstimatingNutrition ? 0.7 : 1,
                      alignSelf: "flex-start",
                    },
                  ]}
                >
                  {isEstimatingNutrition ? (
                    <View style={styles.estimateButtonLoadingContent}>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text style={[styles.estimateButtonText, { color: "#fff" }]}>
                        {t("recipes.nutrition_estimate_loading_cta", {
                          defaultValue: "Checking ingredients",
                        })}
                      </Text>
                    </View>
                  ) : (
                    <>
                      <Text style={[styles.estimateButtonText, { color: "#fff" }]}>
                        {t("recipes.ai_estimate", { defaultValue: "AI Estimate" })}
                      </Text>
                      {shouldHidePremiumPricing(freePremiumActionsRemaining) ? null : (
                        <>
                          <EggIcon size={14} variant="mono" tintColor="#fff" />
                          <Text style={[styles.estimateButtonCost, { color: "#fff" }]}>1</Text>
                        </>
                      )}
                    </>
                  )}
                </TouchableOpacity>
                {isEstimatingNutrition ? (
                  <Text style={[styles.nutritionEstimateLoadingText, { color: subText }]}>
                    {t("recipes.nutrition_estimate_loading_help", {
                      defaultValue:
                        "We’re checking this recipe’s ingredients. If some aren’t in our nutrition catalog yet, we’ll use AI to estimate them for you.",
                    })}
                  </Text>
                ) : null}
              </AppCard>
            </>
          )}

          {/* Cookbook */}
          <Text style={[styles.sectionTitle, { color: text }]}>
            {t("recipes.cookbooks")}
          </Text>
          <AppCard style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {cookbookNames.length > 0 ? (
              cookbookNames.map((name, index) => (
                <View key={index} style={styles.cookbookChip}>
                  <Text
                    style={[
                      styles.cookbookChipText,
                      { color: bg === "#fff" ? text : "#000" },
                    ]}
                  >
                    {name}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={{ color: subText }}>
                {t("recipes.not_in_cookbook")}
              </Text>
            )}
          </AppCard>

          {/* Tags */}
          {currentRecipe.tags.length > 0 && (
            <>
              <Text style={[styles.sectionTitle, { color: text }]}>
                {t("recipes.tags")}
              </Text>
              <AppCard style={{ flexDirection: "row", flexWrap: "wrap" }}>
                {currentRecipe.tags.map((tag, i) => (
                  <Text key={i} style={styles.tag}>
                    {tag}
                  </Text>
                ))}
              </AppCard>
            </>
          )}
        </ScrollView>

        {/* FAB with animation */}
        <Animated.View
          style={[
            styles.fabContainer,
            {
              bottom: insets.bottom + 20,
              opacity: fabAnim,
              flexDirection: "row",
              justifyContent: "flex-end",
              alignItems: "center",
            },
          ]}
        >
          <TouchableOpacity style={styles.fab} onPress={startCooking}>
            <MaterialIcons name="restaurant-menu" size={22} color="#fff" />
            <Text style={styles.fabText}>{t("recipes.start_cooking")}</Text>
          </TouchableOpacity>
          {!isSaved && (
            <TouchableOpacity
              style={[styles.fab, { marginLeft: 12 }]}
              onPress={saveRecipe}
            >
              <MaterialIcons name="save" size={22} color="#fff" />
              <Text style={styles.fabText}>{t("recipes.save_recipe")}</Text>
            </TouchableOpacity>
          )}
        </Animated.View>

        {/* Insufficient cookies modal (cookbooks) */}
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
      </>
    )}
  </SafeAreaView>
);
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  detailImage: {
    width: "100%",
    height: 200,
    borderRadius: 12,
    marginTop: 10,
    marginBottom: 16,
  },
  title: { fontSize: 24, fontWeight: "bold", marginBottom: 4 },
  quickInfo: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: 38,
  },
  quickInfoItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  quickInfoText: { fontSize: 14 },
  sectionTitle: { fontSize: 18, fontWeight: "600", marginTop: 0, marginBottom: 6 },
  text: { fontSize: 16, marginBottom: 6, lineHeight: 22 },
  tag: {
    backgroundColor: "#FFECB3",
    paddingHorizontal: 10,
    borderRadius: 16,
    fontSize: 13,
    marginRight: 6,
    marginBottom: 6,
    height: 26,
    lineHeight: 26,
  },
  cookbookChip: {
    backgroundColor: "#B3D4FC",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
    marginBottom: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  cookbookChipText: {
    fontSize: 13,
  },
  fabContainer: {
    position: "absolute",
    right: 20,
  },
  fab: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E27D60",
    borderRadius: 28,
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 5,
  },
  fabText: { color: "#fff", fontWeight: "600", marginLeft: 6 },
  servingsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  sectionHint: {
    fontSize: 13,
    marginTop: -8,
    marginBottom: 8,
  },
  nutritionGrid: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  nutritionItem: {
    width: "24%",
    alignItems: "center",
  },
  nutritionLabel: {
    fontSize: 13,
    fontWeight: "500",
    marginBottom: 6,
    textAlign: "center",
  },
  nutritionValue: {
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
  },
  nutritionValueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
  },
  nutritionEmptyText: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  nutritionEstimateLoadingText: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
    marginBottom: 0,
  },
  nutritionUnit: {
    fontSize: 13,
    fontWeight: "500",
    marginLeft: 4,
    textAlign: "center",
  },
  estimateButton: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 5,
  },
  estimateButtonLoadingContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  estimateButtonText: {
    fontSize: 13,
    fontWeight: "700",
  },
  estimateButtonCost: {
    fontSize: 13,
    fontWeight: "700",
  },
  servingsLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: "#E27D60",
  },
  servingsDivider: {
    height: 1,
    width: "100%",
    marginBottom: 12,
  },
  stepper: {
    fontSize: 20,
    fontWeight: "600",
    color: "#E27D60",
    textAlign: "center",
  },
  stepperBtn: {
    borderWidth: 1,
    borderColor: "#E27D60",
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 2,
    marginLeft: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    width: 320,
    borderRadius: 12,
    padding: 20,
    maxHeight: "80%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "bold",
  },
  // --- Insufficient cookies modal styles (match AddRecipe / AI Kitchen) ---
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
});
