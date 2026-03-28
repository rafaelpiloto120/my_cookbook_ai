import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Modal,
  Pressable,
  Image,
  Alert,
  NativeSyntheticEvent,
  NativeScrollEvent,
  ScrollView,
  TouchableWithoutFeedback,
} from "react-native";
import { getAuth } from "firebase/auth";
import { getDeviceId } from "../../utils/deviceId";
import { ActivityIndicator } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "@react-navigation/native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import { useThemeColors } from "../../context/ThemeContext";
import AppButton from "../../components/AppButton";
import { Ionicons } from "@expo/vector-icons";
import AppCard from "../../components/AppCard";
import ImportFileModal from "../../components/ImportFileModal";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { useAuth } from "../../context/AuthContext";
import { syncEngine as globalSyncEngine } from "../../lib/sync/SyncEngine";
import { importRecipesFromFile } from "../../utils/importFromFile";

const defaultImage = require("../../assets/default_recipe.png");

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
  imageUrl?: string;
  cookbooks?: (string | { id: string; name: string })[];
  isDeleted?: boolean;
}

interface Cookbook {
  id: string;
  name: string;
  image?: string;
  imageUrl?: string;
}

const defaultCookbookImagesById: Record<string, string> = {
  "cb-favorites": "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600",
  "cb-breakfast": "https://images.unsplash.com/photo-1504754524776-8f4f37790ca0?w=600",
  "cb-lunch": "https://images.unsplash.com/photo-1525755662778-989d0524087e?w=600",
  "cb-snacks": "https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=600",
  "cb-dinner": "https://images.unsplash.com/photo-1543353071-873f17a7a088?w=600",
};

// These will be assigned after t is available

let difficultyMap: Record<string, string>;
let costMap: Record<string, string>;

type RecipeSortOption =
  | "title_asc"
  | "title_desc"
  | "updated_desc"
  | "created_desc"
  | "created_asc";

function getApiBaseUrl(): string | null {
  const v = process.env.EXPO_PUBLIC_API_URL;
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

const API_BASE_URL = getApiBaseUrl();
const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";

async function trackAnalyticsEvent(
  eventType: string,
  payload: Record<string, any> = {}
) {
  if (!API_BASE_URL) {
    if (__DEV__) {
      console.warn(
        "[Analytics] EXPO_PUBLIC_API_URL is not set, cannot send event:",
        eventType
      );
    }
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/analytics/track/simple`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventType,
        metadata: {
          sourceScreen: "history",
          env: appEnv,
          ...payload,
        },
      }),
    });
    if (!res.ok && __DEV__) {
      console.warn(
        "[Analytics] Event request failed",
        eventType,
        "status:",
        res.status
      );
    }
  } catch (err) {
    if (__DEV__) {
      console.warn("[Analytics] Failed to send event", eventType, err);
    }
  }
}

export default function History() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [cookbooks, setCookbooks] = useState<Cookbook[]>([]);
  const [activeTab, setActiveTab] = useState<"all" | "cookbooks">(
    () => (params?.tab === "cookbooks" ? "cookbooks" : "all")
  );
  const [search, setSearch] = useState("");

  // filter modal
  const [filterVisible, setFilterVisible] = useState(false);
  const [sortVisible, setSortVisible] = useState(false);
  const [sortBy, setSortBy] = useState<RecipeSortOption>("title_asc");
  const [selectedDifficulties, setSelectedDifficulties] = useState<string[]>([]);
  const [selectedCosts, setSelectedCosts] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // new cookbook modal
  const [newCookbookVisible, setNewCookbookVisible] = useState(false);
  const [newCookbookName, setNewCookbookName] = useState("");


  // new recipe modal (FAB)
  const [newRecipeVisible, setNewRecipeVisible] = useState(false);

  // import from URL modal
  const [importUrlVisible, setImportUrlVisible] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importUrlLoadingText, setImportUrlLoadingText] = useState<string | null>(null);
  const [instagramImportBalance, setInstagramImportBalance] = useState<number | null>(null);
  const [instagramImportBalanceLoading, setInstagramImportBalanceLoading] = useState(false);
  const [successVisible, setSuccessVisible] = useState(false);
  const [importedRecipe, setImportedRecipe] = useState<Recipe | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importFileVisible, setImportFileVisible] = useState(false);
  const [importFileLoading, setImportFileLoading] = useState(false);
  const [importFileLoadingText, setImportFileLoadingText] = useState<string | null>(null);
  const [importFileError, setImportFileError] = useState<string | null>(null);

  const router = useRouter();
  const { bg, text, subText, card, border, isDark } = useThemeColors();
  const { t } = useTranslation();
  const auth = useAuth();
  // Prefer the singleton engine (always available). AuthContext may expose one too.
  const syncEngine = (auth as any)?.syncEngine ?? globalSyncEngine;
  const INSTAGRAM_REEL_IMPORT_COST = 2;
  // --- Insufficient cookies modal (reuse from AI Kitchen) ---
  const [insufficientModal, setInsufficientModal] = useState<{
    visible: boolean;
    context: "cookbook" | "instagram_reel";
    remaining: number;
  }>({ visible: false, context: "cookbook", remaining: 0 });

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

  const backendUrl = process.env.EXPO_PUBLIC_API_URL!;
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  const firebaseAuth = getAuth();

  const getErrorMessageFromResponse = (data: any): string | null => {
    if (!data) return null;
    if (typeof data === "string") return data;
    if (typeof data?.message === "string") return data.message;
    if (typeof data?.error === "string") return data.error;
    return null;
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

  const openImportFileHelp = useCallback(() => {
    router.push("/import-help" as any);
  }, [router]);

  const isInstagramReelUrl = useCallback((value: string) => {
    try {
      const parsed = new URL(value.trim());
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      return host === "instagram.com" && /^\/reel\/[^/]+/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }, []);

  const getMeasurementSystemForImport = useCallback(async (): Promise<"Metric" | "US"> => {
    const stored =
      (await AsyncStorage.getItem("measurement")) ||
      (await AsyncStorage.getItem("measureSystem"));
    return stored === "US" ? "US" : "Metric";
  }, []);

  const buildBackendAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const currentUser = firebaseAuth.currentUser;
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
    return headers;
  }, [appEnv, firebaseAuth.currentUser]);

  const handleImportFromFile = useCallback(async () => {
    if (!backendUrl) {
      setImportFileError(
        t("recipes.file_import_error_backend_missing", {
          defaultValue: "Backend URL is not configured.",
        })
      );
      return;
    }

    setImportFileError(null);
    setImportFileLoading(true);
    setImportFileLoadingText(
      t("recipes.file_import_progress_uploading", {
        defaultValue: "Uploading file...",
      })
    );
    try {
      const result = await importRecipesFromFile({
        backendUrl,
        appEnv,
        syncEngine,
        onProgress: (stage) => {
          const key =
            stage === "uploading"
              ? "recipes.file_import_progress_uploading"
              : stage === "processing"
              ? "recipes.file_import_progress_processing"
              : stage === "saving"
              ? "recipes.file_import_progress_saving"
              : "recipes.file_import_progress_syncing";

          const fallback =
            stage === "uploading"
              ? "Uploading file..."
              : stage === "processing"
              ? "Reading recipes..."
              : stage === "saving"
              ? "Saving recipes..."
              : "Syncing recipes...";

          setImportFileLoadingText(t(key, { defaultValue: fallback }));
        },
      });

      const stored = await AsyncStorage.getItem("recipes");
      const nextRecipes: Recipe[] = stored ? JSON.parse(stored) : [];
      setRecipes(nextRecipes);
      setImportFileVisible(false);
      setImportFileError(null);

      Alert.alert(
        t("recipes.import_from_file", { defaultValue: "Import from File / App" }),
        t("recipes.file_import_success", {
          defaultValue: "Imported {{count}} recipes successfully.",
          count: result.count,
        })
      );
    } catch (err: any) {
      setImportFileError(
        err?.message ||
          t("recipes.file_import_failed", {
            defaultValue: "The selected file could not be imported.",
          })
      );
    } finally {
      setImportFileLoading(false);
      setImportFileLoadingText(null);
    }
  }, [appEnv, backendUrl, syncEngine, t]);

  const openInsufficientCookiesModal = async (
    remaining: number | null | undefined,
    context: "cookbook" | "instagram_reel" = "cookbook"
  ) => {
    const rem = typeof remaining === "number" ? remaining : 0;

    // Try to fetch catalog offer cookies_5 so we can render it in the same style as Store.
    if (!offerCookies5) {
      try {
        const currentUser = firebaseAuth.currentUser;
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

    setInsufficientModal({ visible: true, context, remaining: rem });
  };

  const fetchCookieBalanceSafe = useCallback(async (): Promise<number | null> => {
    try {
      const headers = await buildBackendAuthHeaders();
      const res = await fetch(`${backendUrl}/economy/balance`, { method: "GET", headers });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const bal = data?.balance;
      return typeof bal === "number" ? bal : null;
    } catch {
      return null;
    }
  }, [backendUrl, buildBackendAuthHeaders]);

  useEffect(() => {
    let cancelled = false;

    const loadInstagramBalance = async () => {
      if (!importUrlVisible) {
        setInstagramImportBalance(null);
        setInstagramImportBalanceLoading(false);
        return;
      }

      const trimmedUrl = importUrl.trim();
      if (!isInstagramReelUrl(trimmedUrl)) {
        setInstagramImportBalance(null);
        setInstagramImportBalanceLoading(false);
        return;
      }

      setInstagramImportBalanceLoading(true);
      const balance = await fetchCookieBalanceSafe();
      if (!cancelled) {
        setInstagramImportBalance(balance);
        setInstagramImportBalanceLoading(false);
      }
    };

    loadInstagramBalance();
    return () => {
      cancelled = true;
    };
  }, [fetchCookieBalanceSafe, importUrl, importUrlVisible, isInstagramReelUrl]);

  const ensureHasCookiesOrPrompt = async (
    required: number,
    context: "cookbook" | "instagram_reel" = "cookbook"
  ): Promise<boolean> => {
    const bal = await fetchCookieBalanceSafe();
    // If we can't pre-check (endpoint missing, etc.), don't block the action.
    if (typeof bal !== "number") return true;
    if (bal >= required) return true;
    await openInsufficientCookiesModal(bal, context);
    return false;
  };
  // Use translations for difficulty and cost maps (matching i18n.ts structure)
  difficultyMap = {
    Easy: t("difficulty.easy"),
    Moderate: t("difficulty.moderate"),
    Challenging: t("difficulty.challenging"),
  };
  costMap = {
    Cheap: t("cost.cheap"),
    Medium: t("cost.medium"),
    Expensive: t("cost.expensive"),
  };
  // --- Scroll position persistence
  const listRef = useRef<FlatList>(null);
  // Key for AsyncStorage for scroll position
  const RECIPES_SCROLL_Y_KEY = "recipesScrollY";

  const getRecipeTimestamp = useCallback((value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      const parsed = new Date(value).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }, []);

  const compareRecipeTitles = useCallback((a: Recipe, b: Recipe) => {
    return (a.title || "").localeCompare(b.title || "", undefined, {
      sensitivity: "base",
    });
  }, []);

  const sortRecipes = useCallback(
    (list: Recipe[]) => {
      const sorted = [...list];
      sorted.sort((a, b) => {
        switch (sortBy) {
          case "title_desc":
            return compareRecipeTitles(b, a);
          case "updated_desc":
            return (
              getRecipeTimestamp(b.updatedAt ?? b.createdAt) -
                getRecipeTimestamp(a.updatedAt ?? a.createdAt) ||
              compareRecipeTitles(a, b)
            );
          case "created_desc":
            return (
              getRecipeTimestamp(b.createdAt) - getRecipeTimestamp(a.createdAt) ||
              compareRecipeTitles(a, b)
            );
          case "created_asc":
            return (
              getRecipeTimestamp(a.createdAt) - getRecipeTimestamp(b.createdAt) ||
              compareRecipeTitles(a, b)
            );
          case "title_asc":
          default:
            return compareRecipeTitles(a, b);
        }
      });
      return sorted;
    },
    [compareRecipeTitles, getRecipeTimestamp, sortBy]
  );

  // // Clear "recipes" key in AsyncStorage once
  // useEffect(() => {
  //   const clearRecipes = async () => {
  //     try {
  //       await AsyncStorage.removeItem("recipes");
  //       console.log("✅ Recipes cleared from AsyncStorage");
  //     } catch (err) {
  //       console.error("❌ Error clearing recipes:", err);
  //     }
  //   };
  //   clearRecipes();
  // }, []);

  // Handler for saving scroll position
  const handleScroll = async (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y;
    try {
      await AsyncStorage.setItem(RECIPES_SCROLL_Y_KEY, JSON.stringify(y));
    } catch (err) {
      // ignore
    }
  };


  // --- Load recipes
  const loadRecipes = useCallback(async () => {
    try {
      const stored = await AsyncStorage.getItem("recipes");
      let parsed = stored ? JSON.parse(stored) : [];
      if (Array.isArray(parsed)) {
        // Normalize each recipe's image property, also supporting legacy keys like imageUrl
        parsed = parsed
          .map((recipe: any) => {
            // Prefer canonical "image", but fall back to "imageUrl" if needed
            let image = recipe.image;
            if (
              (!image || typeof image !== "string") &&
              typeof recipe.imageUrl === "string"
            ) {
              image = recipe.imageUrl;
            }

            // Only keep image if it's a non-empty string; we don't enforce URL shape here
            if (typeof image !== "string" || !image.trim()) {
              image = null;
            }

            // Normalize deletion flag (some legacy entries may omit it)
            const isDeleted = recipe?.isDeleted === true;

            return { ...recipe, image, isDeleted };
          })
          // Never show deleted recipes in UI lists
          .filter((r: any) => r?.isDeleted !== true);
      }
      setRecipes(parsed);
    } catch (err) {
      console.error("Error loading recipes:", err);
    }
  }, []);

  // --- Load cookbooks
  const loadCookbooks = useCallback(async () => {
    try {
      const stored = await AsyncStorage.getItem("cookbooks");
      let parsed: Cookbook[] | null = null;

      if (stored) {
        try {
          parsed = JSON.parse(stored);
        } catch {
          console.warn("⚠️ Corrupted cookbooks in storage, resetting.");
        }
      }

      if (Array.isArray(parsed)) {
        const normalized = parsed.map((cb: any) => ({
          ...cb,
          image: cb.image || cb.imageUrl || undefined,
        }));
        setCookbooks(normalized);
      } else {
        setCookbooks([]);
      }
    } catch (err) {
      console.error("Error loading cookbooks:", err);
      setCookbooks([]);
    }
  }, []);

  /**
   * Persist the current cookbooks list into AsyncStorage ("cookbooks")
   * AND let SyncEngine handle LocalEntity-style store and syncing.
   */
  async function syncCookbooksSnapshot(updated: Cookbook[]) {
    try {
      if (!syncEngine) {
        console.warn("[History] syncEngine is not available (unexpected). Falling back to AsyncStorage only.");
        await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));
        return;
      }

      if (typeof (syncEngine as any).saveLocalCookbooksSnapshot !== "function") {
        console.warn(
          "[History] syncEngine.saveLocalCookbooksSnapshot is not available; falling back to legacy AsyncStorage only"
        );
        await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));
        return;
      }

      // IMPORTANT: write cookbooks only through SyncEngine so it can:
      //  - persist the legacy snapshot key
      //  - mark cookbooks dirty / deletions
      //  - keep sync_* stores coherent
      await (syncEngine as any).saveLocalCookbooksSnapshot(updated);

      console.log("[History] cookbooks snapshot saved via SyncEngine", {
        count: updated.length,
        engine: syncEngine === globalSyncEngine ? "singleton" : "auth-context",
      });

      // Trigger a full sync (manual reason is not throttled in SyncEngine)
      if (typeof (syncEngine as any).requestSync === "function") {
        (syncEngine as any).requestSync("manual");
      }
    } catch (err) {
      console.warn("[History] syncCookbooksSnapshot failed", err);
      // Safety net: do not block UI persistence
      try {
        await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));
      } catch {
        // ignore
      }
    }
  }

  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      let timeout: NodeJS.Timeout | null = null;
      // Load recipes and cookbooks, then restore scroll position
      const restoreScroll = async () => {
        await loadRecipes();
        await loadCookbooks();
        // Wait for FlatList to render
        timeout = setTimeout(async () => {
          try {
            const yStr = await AsyncStorage.getItem(RECIPES_SCROLL_Y_KEY);
            const y = yStr ? JSON.parse(yStr) : 0;
            if (listRef.current && y && isActive) {
              // @ts-ignore
              listRef.current.scrollToOffset({ offset: y, animated: false });
            }
          } catch (err) {
            // ignore
          }
        }, 80); // delay to ensure FlatList is rendered
      };
      restoreScroll();
      return () => {
        isActive = false;
        if (timeout) clearTimeout(timeout);
      };
    }, [loadRecipes, loadCookbooks])
  );


  // --- Delete modal state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string, type: "recipe" | "cookbook" } | null>(null);

  // --- Create cookbook
  const createCookbook = async () => {
    if (!newCookbookName.trim()) {
      Alert.alert(t("common.validation"), t("recipes.validation_name"));
      return;
    }

    // Creating additional cookbooks beyond the free limit costs 1 Cookie.
    // Assumption: the first cookbook is free; from the 2nd onward, require 1 Cookie.
    // We pre-check to avoid wasting AI / backend resources and to give a clear upgrade path.
    if (Array.isArray(cookbooks) && cookbooks.length >= 1) {
      // Close the name modal first, then show the insufficient cookies modal if needed.
      const ok = await ensureHasCookiesOrPrompt(1);
      if (!ok) {
        setNewCookbookVisible(false);
        return;
      }
    }

    const ts = Date.now();
    const newBook: Cookbook = {
      id: `${ts}`,
      name: newCookbookName.trim(),
      image: undefined,
      // @ts-expect-error: legacy cookbook shape used by sync layer includes timestamps
      createdAt: ts,
      // @ts-expect-error: legacy cookbook shape used by sync layer includes timestamps
      updatedAt: ts,
    };

    const safeCookbooks = Array.isArray(cookbooks) ? cookbooks : [];
    const updated = [...safeCookbooks, newBook];

    setCookbooks(updated);
    try {
      await syncCookbooksSnapshot(updated);
    } catch (syncErr: unknown) {
      console.warn("[History] sync after create cookbook failed", syncErr);
    }
    trackAnalyticsEvent("cookbook_created", {
      cookbookId: newBook.id,
      cookbookName: newBook.name,
    });

    setNewCookbookName("");
    setNewCookbookVisible(false);
  };

  // --- Delete recipe
  const deleteRecipe = (id: string) => {
    setDeleteTarget({ id, type: "recipe" });
  };

  // --- Delete cookbook
  const deleteCookbook = (id: string) => {
    setDeleteTarget({ id, type: "cookbook" });
  };

  // --- Confirm delete
  const confirmDelete = async () => {
    if (!deleteTarget) return;

    if (deleteTarget.type === "recipe") {
      // capture the recipe before removing it, so we can log useful metadata
      const targetRecipe = recipes.find((r) => r.id === deleteTarget.id) || null;

      let updated = recipes.filter((r) => r.id !== deleteTarget.id);
      updated = updated.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setRecipes(updated);
      try {
        if (!syncEngine) {
          console.warn("[History] syncEngine missing; cannot trigger recipe sync");
        } else {
          // 1) Persist the legacy snapshot so UI stays consistent
          if (typeof (syncEngine as any).saveLocalRecipesSnapshot === "function") {
            await (syncEngine as any).saveLocalRecipesSnapshot(updated);
          } else {
            // Fallback (shouldn't happen): keep local storage correct
            await AsyncStorage.setItem("recipes", JSON.stringify(updated));
          }

          // 2) Mark the deleted recipe as dirty so RecipeSync can push a deletion
          // (removing from the legacy snapshot alone is not enough for remote delete)
          const now = Date.now();
          const deletedForSync = {
            ...(targetRecipe ?? {}),
            id: deleteTarget.id,
            isDeleted: true,
            updatedAt: now,
          };

          if (typeof (syncEngine as any).markRecipeDirty === "function") {
            await (syncEngine as any).markRecipeDirty(deletedForSync);
          } else {
            console.warn(
              "[History] syncEngine.markRecipeDirty is not available; recipe delete may not sync until next full sync"
            );
          }

          // 3) Trigger a full sync (manual is not throttled)
          if (typeof (syncEngine as any).requestSync === "function") {
            (syncEngine as any).requestSync("manual");
          }

          console.log("[History] recipe deleted -> marked dirty + sync requested", {
            id: deleteTarget.id,
            remaining: updated.length,
          });
        }
      } catch (syncErr: unknown) {
        console.warn("[History] sync after delete recipe failed", syncErr);
      }
      trackAnalyticsEvent("manual_recipe_deleted", {
        recipeId: deleteTarget.id,
        recipeTitle: targetRecipe?.title ?? null,
        // how many recipes remain after deletion
        remainingRecipes: updated.length,
      });
    } else {
      // capture the cookbook before removing it, so we can log useful metadata
      const targetCookbook =
        cookbooks.find((c) => c.id === deleteTarget.id) || null;

      const updated = cookbooks.filter((c) => c.id !== deleteTarget.id);
      setCookbooks(updated);
      try {
        await syncCookbooksSnapshot(updated);
      } catch (syncErr: unknown) {
        console.warn("[History] sync after delete cookbook failed", syncErr);
      }
      trackAnalyticsEvent("cookbook_deleted", {
        cookbookId: deleteTarget.id,
        cookbookName: targetCookbook?.name ?? null,
        remainingCookbooks: updated.length,
      });
    }

    setDeleteTarget(null);
  };

  // --- Normalize tags
  const getNormalizedTags = (tags: string[] = []) =>
    tags
      .flatMap((t) => t.split(","))
      .map((t) => t.trim())
      .filter(Boolean);

  // --- All tags (for filters)
  const allTags = Array.from(
    new Set(recipes.flatMap((r) => getNormalizedTags(r.tags)))
  );

  // --- Filtered recipes
  const filteredRecipes = recipes.filter((r) => {
    if ((r as any)?.isDeleted) return false;
    const matchesSearch = r.title.toLowerCase().includes(search.toLowerCase());
    const matchesDiff =
      selectedDifficulties.length === 0 ||
      selectedDifficulties.includes(r.difficulty);
    const matchesCost =
      selectedCosts.length === 0 || selectedCosts.includes(r.cost);

    const normalizedTags = getNormalizedTags(r.tags).map((t) =>
      t.toLowerCase()
    );
    const matchesTags =
      selectedTags.length === 0 ||
      normalizedTags.some((t) =>
        selectedTags.map((ft) => ft.toLowerCase()).includes(t)
      );

    return matchesSearch && matchesDiff && matchesCost && matchesTags;
  });

  const visibleRecipes = sortRecipes(filteredRecipes);

  const sortOptions: { value: RecipeSortOption; label: string }[] = [
    {
      value: "title_asc",
      label: t("recipes.sort_alphabetical_asc", { defaultValue: "Alphabetical (A-Z)" }),
    },
    {
      value: "title_desc",
      label: t("recipes.sort_alphabetical_desc", { defaultValue: "Alphabetical (Z-A)" }),
    },
    {
      value: "updated_desc",
      label: t("recipes.sort_recently_updated", { defaultValue: "Recently Updated" }),
    },
    {
      value: "created_desc",
      label: t("recipes.sort_recently_added", { defaultValue: "Recently Added" }),
    },
    {
      value: "created_asc",
      label: t("recipes.sort_oldest_added", { defaultValue: "Oldest Added" }),
    },
  ];

  const selectedSortLabel =
    sortOptions.find((option) => option.value === sortBy)?.label ??
    t("recipes.sort_alphabetical_asc", { defaultValue: "Alphabetical (A-Z)" });

  // --- Toggle filter chip
  const toggleFilter = (
    arr: string[],
    value: string,
    setFn: (v: string[]) => void
  ) => {
    if (arr.includes(value)) {
      setFn(arr.filter((v) => v !== value));
    } else {
      setFn([...arr, value]);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          title: t("recipes.my_recipes"),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
        }}
      />

      {/* Tabs */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[
            styles.tab,
            { backgroundColor: activeTab === "all" ? "#F5F5F5" : "#ddd" },
          ]}
          onPress={() => setActiveTab("all")}
        >
          <Text>{t("recipes.all_recipes")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.tab,
            { backgroundColor: activeTab === "cookbooks" ? "#F5F5F5" : "#ddd" },
          ]}
          onPress={() => setActiveTab("cookbooks")}
        >
          <Text>{t("recipes.cookbooks")}</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {activeTab === "all" ? (
        <>
          {/* Search + filter */}
          <View style={styles.searchRow}>
            <MaterialIcons
              name="search"
              size={22}
              color={subText}
              style={{ marginRight: 6 }}
            />
            <TextInput
              style={{ flex: 1, color: text }}
              placeholder={t("recipes.search_placeholder")}
              placeholderTextColor={subText}
              value={search}
              onChangeText={setSearch}
            />
            <TouchableOpacity onPress={() => setFilterVisible(true)}>
              <MaterialIcons name="filter-list" size={24} color="#293a53" />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            onPress={() => setSortVisible(true)}
            accessibilityLabel={t("recipes.sort_by", { defaultValue: "Sort by" })}
            style={styles.sortSummaryButton}
          >
            <Text style={[styles.resultMetaText, { color: text }]}>
              {t("recipes.sort_by_label", {
                defaultValue: "Sort by: {{value}}",
                value: selectedSortLabel,
              })}
            </Text>
          </TouchableOpacity>

          <FlatList
            ref={listRef}
            data={visibleRecipes}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() =>
                  router.push({
                    pathname: `/recipe/${item.id}`,
                    params: { from: "history" },
                  })
                }
              >
                <AppCard style={styles.recipeCard}>
                  <Image
                    source={item.image ? { uri: item.image } : defaultImage}
                    style={styles.recipeImage}
                  />
                  <View style={{ flex: 1 }}>
                    <View style={styles.cardHeader}>
                      <Text style={[styles.cardTitle, { color: text }]}>
                        {item.title}
                      </Text>
                      <TouchableOpacity onPress={() => deleteRecipe(item.id)}>
                        <MaterialIcons
                          name="delete-outline"
                          size={22}
                          color={subText}
                        />
                      </TouchableOpacity>
                    </View>
                    <Text style={{ color: subText }}>
                      ⏱ {item.cookingTime} min • {difficultyMap[item.difficulty] || item.difficulty} • {costMap[item.cost] || item.cost}
                    </Text>
                    <View style={styles.tagRow}>
                      {getNormalizedTags(item.tags).slice(0, 3).map((t, i) => (
                        <View key={i} style={styles.tagChip}>
                          <Text style={styles.tagText}>{t}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                </AppCard>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <View style={{ alignItems: "center", marginTop: 40 }}>
                <Text style={{ color: subText, marginBottom: 8 }}>
                  {t("recipes.no_recipes")}
                </Text>
                <TouchableOpacity onPress={() => router.push("/(tabs)/")}>
                  <Text style={{ color: "#E27D60", fontWeight: "600" }}>
                    {t("recipes.create_in_ai_kitchen")}
                  </Text>
                </TouchableOpacity>
              </View>
            }
            onScroll={handleScroll}
            scrollEventThrottle={16}
          />
        </>
      ) : (
        <>
          <FlatList
            data={cookbooks}
            keyExtractor={(item) => item.id}
            numColumns={2}
            contentContainerStyle={{ paddingBottom: 10 }}
            renderItem={({ item }) => {
              const firstRecipe = recipes.find(
                (r) =>
                  Array.isArray(r.cookbooks) &&
                  r.cookbooks.some((cb) =>
                    typeof cb === "string" ? cb === item.id : cb.id === item.id
                  )
              );
              const img =
                item.image ||
                (item as any).imageUrl ||
                defaultCookbookImagesById[item.id] ||
                firstRecipe?.image ||
                Image.resolveAssetSource(defaultImage).uri;
              return (
                <TouchableOpacity
                  onPress={() => router.push(`/cookbook/${item.id}`)}
                  style={{ flex: 1 }}
                >
                  <AppCard style={styles.cookbookCard}>
                    <Image source={{ uri: img }} style={styles.cookbookImage} resizeMode="cover" />
                    <View style={styles.cookbookOverlay}>
                      <Text style={styles.cookbookTitle}>{item.name}</Text>
                      <TouchableOpacity onPress={() => deleteCookbook(item.id)}>
                        <MaterialIcons
                          name="delete-outline"
                          size={22}
                          color="#fff"
                        />
                      </TouchableOpacity>
                    </View>
                  </AppCard>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <View style={{ alignItems: "center", marginTop: 40, paddingHorizontal: 16 }}>
                <Text style={{ color: subText, marginBottom: 8, textAlign: "center" }}>
                  {t("recipes.no_cookbooks") || "No cookbooks yet."}
                </Text>
                <TouchableOpacity onPress={() => setNewCookbookVisible(true)}>
                  <Text style={{ color: "#E27D60", fontWeight: "600", textAlign: "center" }}>
                    {t("recipes.add_cookbook") || "Add cookbook"}
                  </Text>
                </TouchableOpacity>
              </View>
            }
          />
        </>
      )}

      {/* FAB */}
      {activeTab === "all" ? (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => setNewRecipeVisible(true)}
        >
          <MaterialIcons name="edit" size={22} color="#fff" />
          <Text style={styles.fabText}>{t("recipes.new_recipe")}</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => setNewCookbookVisible(true)}
        >
          <MaterialIcons name="add" size={22} color="#fff" />
          <Text style={styles.fabText}>{t("recipes.add_cookbook")}</Text>
        </TouchableOpacity>
      )}
      {/* New Recipe modal */}
      <Modal visible={newRecipeVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setNewRecipeVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: card }]}>
            <View style={styles.modalHeader}>
              <Text
                style={[
                  styles.modalTitle,
                  // If dark mode, override color to text for visibility
                  bg !== "#fff" ? { color: text } : null,
                ]}
              >
                {t("recipes.new_recipe")}
              </Text>
              <TouchableOpacity onPress={() => setNewRecipeVisible(false)}>
                <MaterialIcons name="close" size={24} color="#293a53" />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={styles.addOptionRow}
              onPress={() => {
                setNewRecipeVisible(false);
                router.push("/add-recipe");
              }}
            >
              <Text style={styles.addOptionEmoji}>✍️</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.addOptionText}>{t("recipes.manual_recipe")}</Text>
                <Text style={styles.addOptionSub}>{t("recipes.manual_recipe_sub")}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={24} color={subText} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.addOptionRow}
              onPress={() => {
                setNewRecipeVisible(false);
                setImportUrlVisible(true);
              }}
            >
              <Text style={styles.addOptionEmoji}>🌐</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.addOptionText}>{t("recipes.import_from_url")}</Text>
                <Text style={styles.addOptionSub}>{t("recipes.import_desc")}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={24} color={subText} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.addOptionRow}
              onPress={() => {
                setNewRecipeVisible(false);
                Alert.alert(t("common.coming_soon"), t("common.coming_soon_desc"));
              }}
            >
              <Text style={styles.addOptionEmoji}>📷</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.addOptionText}>{t("recipes.import_from_image")}</Text>
                <Text style={styles.addOptionSub}>{t("recipes.import_from_image_sub")}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={24} color={subText} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.addOptionRow}
              onPress={() => {
                setNewRecipeVisible(false);
                setImportFileError(null);
                setImportFileVisible(true);
              }}
            >
              <Text style={styles.addOptionEmoji}>📁</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.addOptionText}>{t("recipes.import_from_file")}</Text>
                <Text style={styles.addOptionSub}>{t("recipes.import_from_file_sub")}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={24} color={subText} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <ImportFileModal
        visible={importFileVisible}
        onClose={() => {
          if (!importFileLoading) {
            setImportFileVisible(false);
            setImportFileError(null);
          }
        }}
        onImport={handleImportFromFile}
        onHelpPress={openImportFileHelp}
        loading={importFileLoading}
        loadingText={importFileLoadingText}
        error={importFileError}
        cardColor={card}
        textColor={text}
        subTextColor={subText}
        borderColor={border}
      />

      {/* Import from URL modal */}
      <Modal visible={importUrlVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => {
            setImportUrlVisible(false);
            setImportError(null);
          }}
        >
          <View style={[styles.modalContent, { backgroundColor: card }]}>
            <View style={styles.modalHeader}>
              <Text
                style={[
                  styles.modalTitle,
                  // If dark mode, override color to text for visibility
                  bg !== "#fff" ? { color: text } : null,
                ]}
              >
                {t("recipes.import_from_url")}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setImportUrlVisible(false);
                  setImportError(null);
                }}
              >
                <MaterialIcons
                  name="close"
                  size={24}
                  color={bg !== "#fff" ? text : "#293a53"}
                />
              </TouchableOpacity>
            </View>
            <Text style={{ color: subText, marginBottom: 10, fontSize: 14, lineHeight: 20 }}>
              {t("recipes.import_desc", {
                defaultValue: "Paste a recipe website or Instagram Reel link.",
              })}
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  borderColor: border,
                  color: text,
                  marginBottom: 10,
                },
              ]}
              placeholder={t("recipes.paste_url")}
              placeholderTextColor={subText}
              value={importUrl}
              onChangeText={(value) => {
                setImportUrl(value);
                setImportError(null);
              }}
              editable={!importing}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {isInstagramReelUrl(importUrl.trim()) ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: border,
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 10,
                  backgroundColor: bg !== "#fff" ? "#ffffff10" : "#F8F5F1",
                }}
              >
                <Text style={{ color: text, fontWeight: "700", marginBottom: 4 }}>
                  {t("recipes.instagram_reel_import_inline_title", {
                    defaultValue: "Instagram Reel import",
                  })}
                </Text>
                <Text style={{ color: subText, lineHeight: 19 }}>
                  {t("recipes.instagram_reel_import_confirm_body", {
                    count: INSTAGRAM_REEL_IMPORT_COST,
                    defaultValue:
                      "Importing a recipe from an Instagram Reel costs {{count}} Cookies. We will only charge you if we create a high-quality draft.",
                  })}
                </Text>
                <Text style={{ color: subText, marginTop: 8, fontWeight: "600" }}>
                  {instagramImportBalanceLoading
                    ? t("economy.loading_balance", {
                        defaultValue: "Checking your Cookies...",
                      })
                    : t("economy.current_balance_short", {
                        count: instagramImportBalance ?? 0,
                        defaultValue: "You have {{count}} Cookies.",
                      })}
                </Text>
              </View>
            ) : null}
            {importError ? (
              <Text style={{ color: "#E27D60", marginBottom: 6, fontSize: 13 }}>
                {importError}
              </Text>
            ) : null}
            <TouchableOpacity
              style={{
                backgroundColor: "#E27D60",
                borderRadius: 8,
                paddingVertical: 12,
                alignItems: "center",
                marginTop: 4,
                opacity: importing ? 0.7 : 1,
              }}
              disabled={importing}
              onPress={async () => {
                setImportError(null);
                setImporting(true);
                setImportUrlLoadingText(
                  t("recipes.url_import_progress_fetching", {
                    defaultValue: "Fetching recipe...",
                  })
                );
                const baseUrl = API_BASE_URL;
                if (!baseUrl) {
                  setImportError("Backend URL is not configured.");
                  setImporting(false);
                  setImportUrlLoadingText(null);
                  return;
                }
                try {
                  const trimmedUrl = importUrl.trim();
                  const isInstagram = isInstagramReelUrl(trimmedUrl);
                  const language = i18n.language || "en";
                  const measurementSystem = await getMeasurementSystemForImport();
                  const headers = await buildBackendAuthHeaders();

                  if (isInstagram) {
                    const hasCookies = await ensureHasCookiesOrPrompt(
                      INSTAGRAM_REEL_IMPORT_COST,
                      "instagram_reel"
                    );
                    if (!hasCookies) {
                      setImporting(false);
                      setImportUrlLoadingText(null);
                      return;
                    }
                  }

                  if (isInstagram) {
                    setImportUrlLoadingText(
                      t("recipes.url_import_progress_analyzing_reel", {
                        defaultValue: "Analyzing Instagram Reel...",
                      })
                    );
                  }

                  const endpoint = isInstagram
                    ? `${baseUrl}/extractRecipeDraftFromUrl`
                    : `${baseUrl}/importRecipeFromUrl`;

                  const res = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(
                      isInstagram
                        ? { url: trimmedUrl, language, measurementSystem }
                        : { url: trimmedUrl }
                    ),
                  });
                  if (!res.ok) {
                    let errMsg = t("recipes.invalid_import"); // default translated message
                    try {
                      const errData = await res.json();
                      if (
                        isInstagram &&
                        res.status === 402 &&
                        (errData?.code === "ECON_NOT_ENOUGH_COOKIES" ||
                          errData?.error === "insufficient_cookies")
                      ) {
                        setInstagramImportBalance(
                          typeof errData?.remaining === "number"
                            ? errData.remaining
                            : 0
                        );
                        await openInsufficientCookiesModal(
                          typeof errData?.remaining === "number"
                            ? errData.remaining
                            : null,
                          "instagram_reel"
                        );
                        setImporting(false);
                        setImportUrlLoadingText(null);
                        return;
                      }
                      if (errData && (errData.errorCode || errData.code)) {
                        if (
                          errData.errorCode === "INVALID_RECIPE_STRUCTURE" ||
                          errData.code === "INSTAGRAM_RECIPE_NOT_EXTRACTED"
                        ) {
                          errMsg =
                            errData.code === "INSTAGRAM_RECIPE_NOT_EXTRACTED"
                              ? t("recipes.invalid_instagram_import", {
                                  defaultValue:
                                    "We could not build a reliable recipe draft from this Instagram Reel. Try another Reel or edit the recipe manually.",
                                })
                              : t("recipes.invalid_import");
                        } else if (errData.code === "UNSUPPORTED_SOURCE_URL") {
                          errMsg = t("recipes.invalid_instagram_reel_url", {
                            defaultValue:
                              "This Instagram link is not a supported Reel URL.",
                          });
                        }
                      } else if (errData && errData.error) {
                        errMsg = errData.error; // fallback to any raw message
                      } else if (errData && errData.message) {
                        errMsg = errData.message;
                      }
                    } catch (_) {
                      // ignore JSON parse errors
                    }
                    setImportError(errMsg);
                    setImportUrl("");
                    return;
                  }
                  const data = await res.json();
                  const recipe = data.recipe;

                  if (isInstagram) {
                    setImportUrlLoadingText(
                      t("recipes.url_import_progress_opening_review", {
                        defaultValue: "Opening recipe review...",
                      })
                    );
                    const draftKey = "pending_import_recipe_draft";
                    await AsyncStorage.setItem(draftKey, JSON.stringify(recipe));
                    setImportUrl("");
                    setImportUrlVisible(false);
                    router.push({ pathname: "/add-recipe", params: { draftKey } } as any);
                    return;
                  }

                  const stored = await AsyncStorage.getItem("recipes");
                  let parsed = stored ? JSON.parse(stored) : [];
                  parsed = [recipe, ...parsed];
                  setRecipes(parsed);
                  try {
                    if (syncEngine) {
                      // Persist legacy snapshot (and let SyncEngine keep its sync_* stores coherent)
                      await syncEngine.saveLocalRecipesSnapshot(parsed);

                      // IMPORTANT: imported recipes must be marked dirty, otherwise RecipeSync
                      // has nothing to push (manual recipes do this in add-recipe.tsx).
                      if (typeof (syncEngine as any).markRecipeDirty === "function") {
                        // Ensure timestamps exist / are updated so conflict strategies behave predictably
                        const now = Date.now();
                        const recipeForSync = {
                          ...recipe,
                          id: recipe?.id,
                          // prefer numeric timestamps if present; otherwise set them
                          createdAt:
                            typeof (recipe as any)?.createdAt === "number"
                              ? (recipe as any).createdAt
                              : now,
                          updatedAt: now,
                          isDeleted: false,
                        };
                        await (syncEngine as any).markRecipeDirty(recipeForSync);
                      } else {
                        console.warn(
                          "[History] syncEngine.markRecipeDirty is not available; imported recipe may not sync until next full sync"
                        );
                      }

                      // Trigger a full sync (manual reason is not throttled in SyncEngine)
                      syncEngine.requestSync("manual");
                    } else {
                      console.warn("[History] syncEngine missing; cannot sync imported recipe");
                    }
                  } catch (syncErr: unknown) {
                    console.warn("[History] sync after import recipe failed", syncErr);
                  }

                  setImportUrl("");
                  setImportUrlVisible(false);
                  setImportedRecipe(recipe);
                  setSuccessVisible(true);
                } catch (err: any) {
                  console.error("Import error:", err);
                  setImportError(
                    err?.message || "Failed to import recipe. Please check the URL."
                  );
                  setImportUrl("");
                } finally {
                  setImporting(false);
                  setImportUrlLoadingText(null);
                }
              }}
            >
              {importing ? (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Ionicons name="reload" size={18} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 15 }}>
                    {importUrlLoadingText ||
                      t("recipes.importing", { defaultValue: "Importing..." })}
                  </Text>
                </View>
              ) : (
                <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 16 }}>
                  {isInstagramReelUrl(importUrl.trim())
                    ? t("recipes.instagram_reel_import_button", {
                        count: INSTAGRAM_REEL_IMPORT_COST,
                        defaultValue: "Proceed for {{count}} Cookies",
                      })
                    : t("recipes.import_button")}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Success Modal */}
      <Modal visible={successVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setSuccessVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: card, width: 320 }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: text }]}>{t("recipes.success_import_title")}</Text>
              <TouchableOpacity onPress={() => setSuccessVisible(false)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  color={bg !== "#fff" ? text : "#293a53"}
                />
              </TouchableOpacity>
            </View>
            <Text style={{ color: subText, marginBottom: 18, fontSize: 16 }}>
              {t("recipes.success_import_desc")}
            </Text>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 18 }}>
              <TouchableOpacity
                onPress={() => {
                  setSuccessVisible(false);
                  if (importedRecipe) {
                    router.push({
                      pathname: `/recipe/${importedRecipe.id}`,
                      params: { from: "history" },
                    });
                  }
                }}
                style={{ paddingHorizontal: 8, paddingVertical: 6 }}
              >
                <Text
                  style={{
                    color: bg !== "#fff" ? text : "#3b4a6b",
                    fontWeight: "bold",
                    fontSize: 15,
                    textTransform: "uppercase",
                  }}
                >
                  {t("recipes.open_recipe")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Filter modal */}
      <Modal visible={filterVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setFilterVisible(false)}
        >
          <TouchableWithoutFeedback>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{t("recipes.filters")}</Text>
                <TouchableOpacity onPress={() => setFilterVisible(false)}>
                  <MaterialIcons name="close" size={24} color="#293a53" />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={{ flexGrow: 0 }}
                contentContainerStyle={{ paddingBottom: 8, paddingHorizontal: 0 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={true}
              >
                <Text style={styles.modalSubtitle}>{t("recipes.difficulty")}</Text>
                <View style={styles.filterRow}>
                  {["Easy", "Moderate", "Challenging"].map((d) => (
                    <TouchableOpacity
                      key={d}
                      style={[
                        styles.filterOption,
                        {
                          backgroundColor: selectedDifficulties.includes(d)
                            ? "#293a53"
                            : "#E0E0E0",
                        },
                      ]}
                      onPress={() =>
                        toggleFilter(selectedDifficulties, d, setSelectedDifficulties)
                      }
                    >
                      <Text
                        style={{
                          color: selectedDifficulties.includes(d) ? "#fff" : "#000",
                        }}
                      >
                        {t(`difficulty.${d.toLowerCase()}`)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.modalSubtitle}>{t("recipes.cost")}</Text>
                <View style={styles.filterRow}>
                  {["Cheap", "Medium", "Expensive"].map((c) => (
                    <TouchableOpacity
                      key={c}
                      style={[
                        styles.filterOption,
                        {
                          backgroundColor: selectedCosts.includes(c)
                            ? "#293a53"
                            : "#E0E0E0",
                        },
                      ]}
                      onPress={() => toggleFilter(selectedCosts, c, setSelectedCosts)}
                    >
                      <Text
                        style={{
                          color: selectedCosts.includes(c) ? "#fff" : "#000",
                        }}
                      >
                        {t(`cost.${c.toLowerCase()}`)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {allTags.length > 0 && (
                  <>
                    <Text style={styles.modalSubtitle}>{t("recipes.tags")}</Text>
                    <View style={styles.filterRow}>
                      {allTags.map((tag) => (
                        <TouchableOpacity
                          key={tag}
                          style={[
                            styles.filterOption,
                            {
                              backgroundColor: selectedTags.includes(tag)
                                ? "#293a53"
                                : "#E0E0E0",
                            },
                          ]}
                          onPress={() => toggleFilter(selectedTags, tag, setSelectedTags)}
                        >
                          <Text
                            style={{
                              color: selectedTags.includes(tag) ? "#fff" : "#000",
                            }}
                          >
                            {tag}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}

                <TouchableOpacity
                  style={[
                    styles.filterOption,
                    { backgroundColor: "#E0E0E0", marginTop: 12 },
                  ]}
                  onPress={() => {
                    setSelectedDifficulties([]);
                    setSelectedCosts([]);
                    setSelectedTags([]);
                  }}
                >
                  <Text
                    style={{
                      color: "#293a53",
                      fontWeight: "600",
                      textAlign: "center",
                    }}
                  >
                    {t("recipes.clear_filters")}
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>
        </TouchableOpacity>
      </Modal>

      {/* Sort modal */}
      <Modal visible={sortVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setSortVisible(false)}
        >
          <TouchableWithoutFeedback>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {t("recipes.sort_by", { defaultValue: "Sort by" })}
                </Text>
                <TouchableOpacity onPress={() => setSortVisible(false)}>
                  <MaterialIcons name="close" size={24} color="#293a53" />
                </TouchableOpacity>
              </View>
              {sortOptions.map((option) => {
                const isSelected = sortBy === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.sortOptionRow,
                      isSelected ? styles.sortOptionRowSelected : null,
                    ]}
                    onPress={() => {
                      setSortBy(option.value);
                      setSortVisible(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.sortOptionText,
                        isSelected ? styles.sortOptionTextSelected : null,
                      ]}
                    >
                      {option.label}
                    </Text>
                    {isSelected ? (
                      <MaterialIcons name="check" size={20} color="#293a53" />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </TouchableWithoutFeedback>
        </TouchableOpacity>
      </Modal>

      {/* New Cookbook modal */}
      <Modal visible={newCookbookVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setNewCookbookVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: card }]}>
            <View style={styles.modalHeader}>
              <Text
                style={[
                  styles.modalTitle,
                  bg !== "#fff" ? { color: text } : null,
                ]}
              >
                {t("recipes.add_cookbook")}
              </Text>
              <TouchableOpacity onPress={() => setNewCookbookVisible(false)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  color={bg !== "#fff" ? text : "#293a53"}
                />
              </TouchableOpacity>
            </View>
            <Text
              style={{
                fontSize: 13,
                lineHeight: 18,
                marginBottom: 12,
                color: subText,
              }}
            >
              {t("economy.cookbook_pricing_note")}
            </Text>
            <TextInput
              style={[styles.input, { borderColor: border, color: text }]}
              placeholder={t("recipes.cookbook_name_placeholder")}
              placeholderTextColor={subText}
              value={newCookbookName}
              onChangeText={setNewCookbookName}
            />
            <AppButton label={t("common.confirm")} onPress={createCookbook} variant="cta" />
          </View>
        </TouchableOpacity>
      </Modal>
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
              {insufficientModal.context === "instagram_reel"
                ? t("economy.insufficient_instagram_reel_body_short", {
                    count: INSTAGRAM_REEL_IMPORT_COST,
                    remaining: insufficientModal.remaining,
                    defaultValue: `You need ${INSTAGRAM_REEL_IMPORT_COST} Cookies to import a recipe from an Instagram Reel. You have ${insufficientModal.remaining}.`,
                  })
                : t("economy.insufficient_cookbook_body_short", {
                    remaining: insufficientModal.remaining,
                    defaultValue: `You need 1 Cookie to create a new cookbook. You have ${insufficientModal.remaining}.`,
                  })}
            </Text>

            {/* Offer card (cookies_5) in Store-like style */}
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

            {/* Bottom actions: only two buttons */}
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

      {/* Delete confirmation modal */}
      <Modal visible={!!deleteTarget} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setDeleteTarget(null)}
        >
          <View style={[styles.modalContent, { backgroundColor: card, width: 320 }]}>
            <View style={styles.modalHeader}>
              <Text
                style={[
                  styles.modalTitle,
                  // If dark mode, override color to text for visibility
                  bg !== "#fff" ? { color: text } : null,
                ]}
              >
                {deleteTarget?.type === "recipe"
                  ? t("recipes.delete_recipe_confirm")
                  : t("recipes.delete_cookbook_confirm")}
              </Text>
              <TouchableOpacity onPress={() => setDeleteTarget(null)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  // If dark mode, use text color for icon, else original
                  color={bg !== "#fff" ? text : "#293a53"}
                />
              </TouchableOpacity>
            </View>
            <Text style={{ color: subText, marginBottom: 18, fontSize: 15 }}>
              {deleteTarget?.type === "recipe"
                ? t("recipes.delete_recipe_desc")
                : t("recipes.delete_cookbook_desc")}
            </Text>
            <TouchableOpacity
              style={{
                backgroundColor: "#E53935",
                borderRadius: 8,
                paddingVertical: 12,
                alignItems: "center",
                marginTop: 4,
              }}
              onPress={confirmDelete}
            >
              <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 16 }}>
                {t("common.delete")}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  tabRow: {
    flexDirection: "row",
    justifyContent: "center",
    padding: 6,
    backgroundColor: "#293a53", // same as header background
  },
  tab: {
    flex: 1,
    marginHorizontal: 6,
    paddingVertical: 8,
    borderRadius: 20,
    alignItems: "center",
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "#F5F5F5",
  },
  recipeCard: { flexDirection: "row", padding: 10 },
  recipeImage: { width: 80, height: 80, borderRadius: 12, marginRight: 12 },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardTitle: { fontSize: 16, fontWeight: "600", flexShrink: 1 },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 4,
  },
  tagChip: {
    backgroundColor: "#E27D60",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginRight: 6,
    marginBottom: 4,
  },
  tagText: {
    color: "#fff",
    fontSize: 12,
    lineHeight: 14,
  },
  fab: {
    flexDirection: "row",
    alignItems: "center",
    position: "absolute",
    bottom: 80,
    right: 20,
    backgroundColor: "#E27D60",
    borderRadius: 28,
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 5,
  },
  fabText: { color: "#fff", fontWeight: "600", marginLeft: 6 },
  cookbookCard: {
    flex: 1,
    margin: 6,
    borderRadius: 12,
    overflow: "hidden",
  },
  cookbookImage: { width: "100%", height: 140 },
  cookbookOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    padding: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cookbookTitle: { color: "#fff", fontWeight: "bold", fontSize: 16 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    width: 320,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 20,
    maxHeight: "80%",
    // Remove alignItems: "center" to allow content to fill width and scroll properly
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
    color: "#293a53",
  },
  modalSubtitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#293a53",
    marginTop: 10,
    marginBottom: 6,
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 8,
  },
  resultMetaText: {
    fontSize: 13,
    fontWeight: "600",
  },
  sortSummaryButton: {
    alignSelf: "flex-start",
    marginBottom: 10,
    marginHorizontal: 16,
  },
  filterOption: {
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  sortOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#EAEAEA",
  },
  sortOptionRowSelected: {
    backgroundColor: "#F5F5F5",
  },
  sortOptionText: {
    fontSize: 16,
    color: "#293a53",
  },
  sortOptionTextSelected: {
    fontWeight: "700",
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    // marginBottom now set inline for import modal
  },
  // Add Option Row Styles (consistent with cookbook/[id].tsx)
  addOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 10,
    backgroundColor: "#F5F5F5",
    borderRadius: 12,
    marginBottom: 10,
    marginTop: 0,
    gap: 10,
  },
  addOptionEmoji: {
    fontSize: 22,
    marginRight: 10,
  },
  addOptionText: {
    fontWeight: "600",
    color: "#293a53",
    fontSize: 16,
    marginBottom: 2,
  },
  addOptionSub: {
    color: "#78849E",
    fontSize: 13,
  },
  // --- Insufficient cookies modal styles (reused from AI Kitchen) ---
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
