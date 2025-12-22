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
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "../../../context/ThemeContext";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDeviceId } from "../../../utils/deviceId";
import AppCard from "../../../components/AppCard";
import { MaterialIcons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { syncEngine } from "../../../lib/sync/SyncEngine";

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
  const { id, recipe, from } = useLocalSearchParams<{ id?: string; recipe?: string; from?: string }>();
  const [currentRecipe, setCurrentRecipe] = useState<Recipe | null>(null);
  const [servings, setServings] = useState<number>(1);
  const [cookbookNames, setCookbookNames] = useState<string[]>([]);
  const [isSaved, setIsSaved] = useState(false);
  const router = useRouter();
  const { bg, text, subText } = useThemeColors();
  const { t } = useTranslation();

  // economy / cookies gating (cookbook creation)
  const backendUrl = process.env.EXPO_PUBLIC_API_URL;
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  const isDark = bg !== "#fff";

  const [insufficientModal, setInsufficientModal] = useState<{ visible: boolean; remaining: number }>(
    { visible: false, remaining: 0 }
  );

  const [offerCookies5, setOfferCookies5] = useState<
    | null
    | {
        id: string;
        title: string;
        subtitle?: string | null;
        price: number;
        currency: string;
        cookies: number;
        badges?: string[];
        isPromo?: boolean;
        bonusCookies?: number;
        mostPurchased?: boolean;
      }
  >(null);
  const editRecipe = () => {
    if (!currentRecipe) return;
    router.push({
      pathname: "/add-recipe",
      params: { edit: JSON.stringify(currentRecipe) },
    });
  };


  const goToStore = (highlightOfferId?: string) => {
    try {
      router.push({
        pathname: "/economy/store",
        params: highlightOfferId ? { highlight: highlightOfferId } : undefined,
      } as any);
    } catch {
      router.push("/economy/store" as any);
    }
  };

  const openInsufficientCookiesModal = async (remaining: number | null | undefined) => {
    const rem = typeof remaining === "number" ? remaining : 0;

    // Fetch offer cookies_5 so the modal matches the Store cards.
    if (!offerCookies5 && backendUrl) {
      try {
        const currentUser = auth.currentUser;
        const idToken = currentUser ? await currentUser.getIdToken() : null;
        const deviceId = await getDeviceId().catch(() => null);
        const userId = currentUser?.uid ?? null;

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-app-env": appEnv,
        };
        if (idToken) headers.Authorization = `Bearer ${idToken}`;
        if (deviceId) headers["x-device-id"] = deviceId;
        if (userId) headers["x-user-id"] = userId;

        const res = await fetch(`${backendUrl}/economy/catalog`, { headers });
        const data = await res.json().catch(() => null);
        const root = (data as any)?.data ?? data;
        const rawOffers: any[] =
          (root?.catalog?.offers && Array.isArray(root.catalog.offers) ? root.catalog.offers : null) ||
          (root?.offers && Array.isArray(root.offers) ? root.offers : null) ||
          [];

        const o5 = rawOffers.find(
          (o: any) => String(o?.id ?? o?.offerId ?? o?.productId ?? "").trim() === "cookies_5"
        );

        if (o5) {
          const currency = String(o5?.currency ?? root?.catalog?.currency ?? root?.currency ?? "USD").toUpperCase();
          setOfferCookies5({
            id: "cookies_5",
            title: String(o5?.title ?? o5?.name ?? "").trim() || "5 Cookies",
            subtitle:
              (typeof o5?.subtitle === "string"
                ? o5.subtitle
                : typeof o5?.description === "string"
                  ? o5.description
                  : null) ?? null,
            price: typeof o5?.price === "number" ? o5.price : Number(o5?.amount ?? 0),
            currency,
            cookies: Math.max(0, Math.floor(Number(o5?.cookies ?? o5?.cookieAmount ?? o5?.qty ?? 0))),
            badges: Array.isArray(o5?.badges) ? o5.badges.filter((b: any) => typeof b === "string") : undefined,
            isPromo: typeof o5?.isPromo === "boolean" ? o5.isPromo : undefined,
            bonusCookies: typeof o5?.bonusCookies === "number" ? o5.bonusCookies : undefined,
            mostPurchased: typeof o5?.mostPurchased === "boolean" ? o5.mostPurchased : undefined,
          });
        }
      } catch {
        // ignore
      }
    }

    setInsufficientModal({ visible: true, remaining: rem });
  };

  const fetchCookieBalanceSafe = async (): Promise<number | null> => {
    try {
      if (!backendUrl) return null;
      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : null;
      const deviceId = await getDeviceId().catch(() => null);
      const userId = currentUser?.uid ?? null;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-app-env": appEnv,
      };
      if (idToken) headers.Authorization = `Bearer ${idToken}`;
      if (deviceId) headers["x-device-id"] = deviceId;
      if (userId) headers["x-user-id"] = userId;

      const res = await fetch(`${backendUrl}/economy/balance`, { method: "GET", headers });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const bal = (data as any)?.balance;
      return typeof bal === "number" ? bal : null;
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

  const consumeCookbookCookieIfNeeded = async (): Promise<boolean> => {
    try {
      if (!backendUrl) {
        console.warn("[RecipeDetail] No backend URL configured; skipping economy consume for cookbook");
        return true;
      }

      const authInfo = await ensureAuthUid();
      if (!authInfo?.token) {
        console.warn("[RecipeDetail] Missing auth token for economy consume; blocking cookbook creation");
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

      const res = await fetch(`${backendUrl}/economy/consume`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "create_cookbook",
          uid: authInfo.uid,
        }),
      });

      if (res.status === 404) {
        const ok = await ensureHasCookiesOrPrompt(1);
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
        await openInsufficientCookiesModal(remaining);
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
          const allowedFlag = (data as any)?.allowed;
          const successFlag = (data as any)?.success;

          const remaining =
            typeof (data as any)?.remaining === "number"
              ? (data as any).remaining
              : typeof (data as any)?.balance === "number"
                ? (data as any).balance
                : null;

          if (allowedFlag === false || successFlag === false) {
            await openInsufficientCookiesModal(remaining);
            return false;
          }

          if (typeof remaining === "number") {
            try {
              await AsyncStorage.setItem("economy_cookie_balance", String(remaining));
            } catch {
              // ignore
            }
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
        message || t("wizard.error_generate", "Something went wrong. Please try again.")
      );
      return false;
    } catch (err) {
      console.warn("[RecipeDetail] economy/consume exception; blocking cookbook creation to avoid bypass", err);
      Alert.alert(
        t("common.error", "Error"),
        t("economy.try_again", "Couldn't verify your Cookie balance. Please try again.")
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

          // 2) Also parse recipe param if present (may come from navigation)
          if (recipe) {
            try {
              paramRecipe = JSON.parse(recipe as string) as Recipe;
            } catch (e) {
              console.warn("[RecipeDetail] Failed to parse recipe param:", e);
            }
          }

          // 3) Merge both, preferring storedRecipe but falling back to paramRecipe for any missing fields
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
    if (from === "history") {
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
    Alert.alert("Delete Recipe", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
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
            const backendUrl = process.env.EXPO_PUBLIC_API_URL;
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
    Alert.alert("Error", "Failed to share recipe");
  }
};

const scaleIngredient = (ingredient: string) => {
  // This helper attempts to find numbers in the ingredient string and scale them
  // For example: "2 cups flour" with servings 4 and base servings 2 => "4 cups flour"
  if (!currentRecipe) return ingredient;
  const baseServings = currentRecipe.servings;
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
            const allowed = await consumeCookbookCookieIfNeeded();
            if (!allowed) {
              // Do not proceed with saving the recipe if cookbook creation is blocked.
              return;
            }

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

    Alert.alert("Success", "Recipe saved successfully");
    setIsSaved(true);
  } catch (error) {
    Alert.alert("Error", "Failed to save recipe");
    console.error("Failed to save recipe:", error);
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


// Mappings for difficulty and cost
const difficultyMap = {
  Easy: t("difficulty.easy"),
  Moderate: t("difficulty.moderate"),
  Challenging: t("difficulty.challenging"),
};
const costMap = {
  Cheap: t("cost.cheap"),
  Medium: t("cost.medium"),
  Expensive: t("cost.expensive"),
};

// Use map to always show emoji label
const difficultyDisplay = currentRecipe ? (difficultyMap[currentRecipe.difficulty] || currentRecipe.difficulty) : "";

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
              <Text style={[styles.quickInfoText, { color: text }]}>
                ⏱ {currentRecipe.cookingTime} min
              </Text>
              <Text style={[styles.quickInfoText, { color: text }]}>
                {difficultyDisplay}
              </Text>
              <Text style={[styles.quickInfoText, { color: text }]}>
                {costMap[currentRecipe.cost]}
              </Text>
            </View>
          </AppCard>

          {/* Ingredients */}
          <Text style={[styles.sectionTitle, { color: text }]}>
            {t("recipes.ingredients")}
          </Text>
          <AppCard>
            <View style={styles.servingsRow}>
              <Text style={[styles.servingsLabel, { color: text }]}>
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
                {step}
              </Text>
            ))}
          </AppCard>

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
        <Modal
          visible={insufficientModal.visible}
          transparent
          animationType="fade"
          onRequestClose={() => setInsufficientModal((s) => ({ ...s, visible: false }))}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => setInsufficientModal((s) => ({ ...s, visible: false }))}
          />
          <View style={styles.modalCenter}>
            <View
              style={[
                styles.modalCard,
                {
                  backgroundColor: isDark ? "#1f2430" : "#fff",
                  borderColor: isDark ? "#ffffff22" : "#00000012",
                },
              ]}
            >
              <TouchableOpacity
                onPress={() => setInsufficientModal((s) => ({ ...s, visible: false }))}
                style={styles.modalCloseBtn}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={[styles.modalCloseText, { color: isDark ? "#f5f5f5" : "#293a53" }]}>✕</Text>
              </TouchableOpacity>

              <Text style={[styles.modalTitleCookies, { color: isDark ? "#f5f5f5" : "#293a53" }]}>
                {t("economy.insufficient_title", "Not enough Cookies")}
              </Text>

              <Text style={[styles.modalBodyCookies, { color: isDark ? "#ddd" : "#444" }]}>
                {t("economy.insufficient_cookbook_body_short", {
                  remaining: insufficientModal.remaining,
                  defaultValue: `You need 1 Cookie to create a new cookbook. You have ${insufficientModal.remaining}.`,
                })}
              </Text>

              {offerCookies5 ? (
                <View
                  style={[
                    styles.modalOfferCard,
                    {
                      backgroundColor: isDark ? "#171b24" : "#fff",
                      borderColor: isDark ? "#ffffff22" : "#00000012",
                    },
                  ]}
                >
                  <View style={styles.modalOfferLeft}>
                    <View style={styles.modalOfferTopRow}>
                      <View style={styles.modalOfferTopLeft}>
                        <Text style={[styles.modalOfferTitle, { color: isDark ? "#f5f5f5" : "#293a53" }]}>
                          🍪 {offerCookies5.cookies} {t("economy.cookies", "Cookies")}
                        </Text>
                      </View>
                    </View>

                    <Text style={[styles.modalOfferPriceLine, { color: isDark ? "#ddd" : "#666" }]}>
                      {offerCookies5.subtitle
                        ? `${offerCookies5.subtitle} | ${offerCookies5.price.toFixed(2)} ${String(
                            offerCookies5.currency || "USD"
                          ).toUpperCase()}`
                        : `${offerCookies5.price.toFixed(2)} ${String(
                            offerCookies5.currency || "USD"
                          ).toUpperCase()}`}
                    </Text>
                  </View>

                  <View style={styles.modalOfferRight}>
                    <TouchableOpacity
                      style={styles.buyBtnCookies}
                      onPress={() => {
                        setInsufficientModal((s) => ({ ...s, visible: false }));
                        goToStore("cookies_5");
                      }}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.buyBtnTextCookies}>{t("economy.buy", "Buy")}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}

              <View style={styles.modalActionsRow}>
                <TouchableOpacity
                  style={[
                    styles.modalActionBtn,
                    {
                      backgroundColor: isDark ? "#2b3141" : "#eef1f6",
                      borderColor: isDark ? "#ffffff22" : "#00000012",
                    },
                  ]}
                  onPress={() => {
                    setInsufficientModal((s) => ({ ...s, visible: false }));
                    goToStore();
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.modalActionText, { color: isDark ? "#f5f5f5" : "#293a53" }]}>
                    {t("economy.offers_button", "Other offers")}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.modalActionBtn,
                    {
                      backgroundColor: isDark ? "#2b3141" : "#eef1f6",
                      borderColor: isDark ? "#ffffff22" : "#00000012",
                    },
                  ]}
                  onPress={() => setInsufficientModal((s) => ({ ...s, visible: false }))}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.modalActionText, { color: isDark ? "#f5f5f5" : "#293a53" }]}>
                    {t("wizard.button_back", "Back")}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
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
  quickInfo: { flexDirection: "row", justifyContent: "space-between" },
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
  servingsLabel: {
    fontSize: 16,
    fontWeight: "600",
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