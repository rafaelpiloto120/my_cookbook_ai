import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Image,
  Modal,
  TextInput,
  Alert,
  ScrollView,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { MaterialIcons, Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import AppCard from "../../components/AppCard";
import AppButton from "../../components/AppButton";
import InsufficientCookiesModal from "../../components/InsufficientCookiesModal";
import ImportFileModal from "../../components/ImportFileModal";
import { useThemeColors } from "../../context/ThemeContext";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";

import { auth } from "../../firebaseConfig";
import { signInAnonymously } from "firebase/auth";
import { storage } from "../../firebaseConfig";
import { ref, deleteObject } from "firebase/storage";
import { useAuth } from "../../context/AuthContext";
import { syncEngine as syncEngineSingleton } from "../../lib/sync/SyncEngine";
import { importRecipesFromFile } from "../../utils/importFromFile";
import { getDeviceId } from "../../utils/deviceId";
import { getRecipeCaloriesPerServing } from "../../lib/recipes/nutrition";
import {
  claimEconomyReward,
  fetchEconomyCatalogBundle,
  fetchEconomySnapshot,
  shouldHidePremiumPricing,
  writeCachedEconomySnapshot,
  type EconomyCatalogOffer,
} from "../../lib/economy/client";
import {
  claimRewardKeysSequentially,
  getRecipeRewardKeysForCount,
} from "../../lib/economy/rewards";
import { normalizeRecipeDifficulty } from "../../lib/recipes/difficulty";
import { getApiBaseUrl } from "../../lib/config/api";


const difficultyMap = (t: any) => ({
  Easy: t("difficulty.easy"),
  Moderate: t("difficulty.moderate"),
  Challenging: t("difficulty.challenging"),
});
const defaultImage = require("../../assets/default_recipe.png");

type RecipeSortOption =
  | "title_asc"
  | "title_desc"
  | "updated_desc"
  | "created_desc"
  | "created_asc";

type CalorieFilterOption =
  | "none"
  | "low"
  | "medium"
  | "high";

const FILTER_TAGS_INITIAL_VISIBLE = 12;

function getRecipeCalorieBucket(recipe: any): CalorieFilterOption {
  const calories = getRecipeCaloriesPerServing(recipe);
  if (calories === null || !Number.isFinite(calories)) return "none";
  if (calories < 300) return "low";
  if (calories <= 600) return "medium";
  return "high";
}

export default function CookbookDetail() {
  const { id } = useLocalSearchParams(); // cookbook id from route
  const router = useRouter();
  const { bg, text, subText, card, border, isDark } = useThemeColors();
  const { t } = useTranslation();

  const syncEngine = syncEngineSingleton as any;

  const backendUrl = getApiBaseUrl()!;
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  const INSTAGRAM_REEL_IMPORT_COST = 2;
  const [freePremiumActionsRemaining, setFreePremiumActionsRemaining] = useState<number | null>(null);
  const [insufficientModalVisible, setInsufficientModalVisible] = useState(false);
  const [insufficientCookiesRemaining, setInsufficientCookiesRemaining] = useState(0);
  const [featuredOffer, setFeaturedOffer] = useState<EconomyCatalogOffer | null>(null);
  const [availableRewardsCount, setAvailableRewardsCount] = useState(0);
  console.log("Using backend URL:", backendUrl, "env:", appEnv);

  const [cookbookName, setCookbookName] = useState("");
  const [recipes, setRecipes] = useState<any[]>([]);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string, type: "recipe" } | null>(null);

  // edit modal
  const [editVisible, setEditVisible] = useState(false);
  const [newName, setNewName] = useState("");
  const [cookbookImage, setCookbookImage] = useState<string | null>(null);

  // search and filter states
  const [search, setSearch] = useState("");
  const [filterVisible, setFilterVisible] = useState(false);
  const [sortVisible, setSortVisible] = useState(false);
  const [sortBy, setSortBy] = useState<RecipeSortOption>("title_asc");
  const [selectedDifficulties, setSelectedDifficulties] = useState<string[]>([]);
  const [selectedCalories, setSelectedCalories] = useState<CalorieFilterOption[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [filterTagSearch, setFilterTagSearch] = useState("");
  const [visibleFilterTagCount, setVisibleFilterTagCount] = useState(FILTER_TAGS_INITIAL_VISIBLE);

  // Add Recipe Modal
  const [addVisible, setAddVisible] = useState(false);
  // Import from URL Modal
  const [importUrlVisible, setImportUrlVisible] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [importUrlLoadingText, setImportUrlLoadingText] = useState<string | null>(null);
  const [importError, setImportError] = useState("");
  const [instagramImportBalance, setInstagramImportBalance] = useState<number | null>(null);
  const [instagramImportBalanceLoading, setInstagramImportBalanceLoading] = useState(false);
  const [importFileVisible, setImportFileVisible] = useState(false);
  const [importFileLoading, setImportFileLoading] = useState(false);
  const [importFileLoadingText, setImportFileLoadingText] = useState<string | null>(null);
  const [importFileError, setImportFileError] = useState("");

  const getRecipeTimestamp = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      const parsed = new Date(value).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  };

  const compareRecipeTitles = (a: any, b: any) =>
    String(a?.title ?? "").localeCompare(String(b?.title ?? ""), undefined, {
      sensitivity: "base",
    });

  // Success Modal for import
  const [successVisible, setSuccessVisible] = useState(false);
  const [importedRecipe, setImportedRecipe] = useState<any | null>(null);

  // --- Load recipes + cookbook name
  useEffect(() => {
    const load = async () => {
      try {
        const storedRecipes = await AsyncStorage.getItem("recipes");
        const storedCookbooks = await AsyncStorage.getItem("cookbooks");

        const parsedRecipes = storedRecipes ? JSON.parse(storedRecipes) : [];
        const parsedCookbooks = storedCookbooks ? JSON.parse(storedCookbooks) : [];

        const thisCookbook = parsedCookbooks.find((c: any) => c.id === id);
        setCookbookName(thisCookbook?.name || "Cookbook");
        // Support both legacy `image` and newer `imageUrl` fields
        setCookbookImage(thisCookbook?.imageUrl ?? thisCookbook?.image ?? null);

        const filtered = parsedRecipes.filter((r: any) => {
          if (r?.isDeleted) return false;
          if (!Array.isArray(r.cookbooks)) return false;
          return r.cookbooks.some(
            (cb: any) =>
              (typeof cb === "string" && cb === id) ||
              (typeof cb === "object" && cb.id === id)
          );
        });
        setRecipes(filtered);
      } catch (err) {
        console.error("Error loading cookbook detail:", err);
      }
    };
    load();
  }, [id, editVisible]); // reload if edited

  const openImportFileHelp = () => {
    router.push("/import-help" as any);
  };

  const isInstagramReelUrl = (value: string) => {
    try {
      const parsed = new URL(value.trim());
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      return host === "instagram.com" && /^\/reel\/[^/]+/i.test(parsed.pathname);
    } catch {
      return false;
    }
  };

  const getMeasurementSystemForImport = async (): Promise<"Metric" | "US"> => {
    const stored =
      (await AsyncStorage.getItem("measurement")) ||
      (await AsyncStorage.getItem("measureSystem"));
    return stored === "US" ? "US" : "Metric";
  };

  const buildBackendAuthHeaders = async (): Promise<Record<string, string>> => {
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
    return headers;
  };

  const fetchCookieBalanceSafe = useCallback(async (): Promise<number | null> => {
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
  }, [backendUrl, appEnv]);

  const openInsufficientCookiesModal = useCallback(
    async (remaining: number | null | undefined) => {
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
          // ignore
        }
      }
      setInsufficientCookiesRemaining(rem);
      setInsufficientModalVisible(true);
    },
    [appEnv, auth, availableRewardsCount, backendUrl, featuredOffer]
  );

  const promptInstagramReelCookies = async (): Promise<boolean> => {
    const remaining = await fetchCookieBalanceSafe();
    if (shouldHidePremiumPricing(freePremiumActionsRemaining)) {
      return true;
    }
    if (typeof remaining === "number" && remaining < INSTAGRAM_REEL_IMPORT_COST) {
      await openInsufficientCookiesModal(remaining);
      return false;
    }
    return true;
  };

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
  }, [fetchCookieBalanceSafe, importUrl, importUrlVisible]);

  const handleImportFromFile = async () => {
    if (!backendUrl) {
      setImportFileError(
        t("recipes.file_import_error_backend_missing", {
          defaultValue: "Backend URL is not configured.",
        })
      );
      return;
    }

    setImportFileError("");
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
        cookbook: {
          id: String(id),
          name: cookbookName,
        },
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

      const storedRecipes = await AsyncStorage.getItem("recipes");
      const parsedRecipes = storedRecipes ? JSON.parse(storedRecipes) : [];
      const filtered = parsedRecipes.filter((r: any) => {
        if (r?.isDeleted) return false;
        if (!Array.isArray(r.cookbooks)) return false;
        return r.cookbooks.some(
          (cb: any) =>
            (typeof cb === "string" && cb === id) ||
            (typeof cb === "object" && cb.id === id)
        );
      });
      setRecipes(filtered);
      setImportFileVisible(false);

      try {
        if (backendUrl && result.count > 0) {
          const activeRecipeCount = Array.isArray(parsedRecipes)
            ? parsedRecipes.filter((item: any) => !item?.isDeleted).length
            : 0;
          await claimRewardKeysSequentially(
            {
              backendUrl,
              appEnv,
              auth,
            },
            getRecipeRewardKeysForCount(activeRecipeCount)
          );
        }
      } catch (rewardErr) {
        console.warn("[Cookbook] file import reward claim failed", rewardErr);
      }

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
  };

  // Ensure we have a Firebase auth user (real or anonymous) and return uid + ID token
  const ensureAuthUid = async (): Promise<{ uid: string; token: string } | null> => {
    try {
      if (auth.currentUser) {
        const token = await auth.currentUser.getIdToken();
        return { uid: auth.currentUser.uid, token };
      }
      const cred = await signInAnonymously(auth);
      const token = await cred.user.getIdToken();
      return { uid: cred.user.uid, token };
    } catch (e) {
      console.warn("[Cookbook] ensureAuthUid failed", e);
      return null;
    }
  };

  // Upload a cookbook image to backend -> Firebase Storage; returns public URL or null
  const uploadCookbookImage = async (localUri: string, cookbookId: string): Promise<string | null> => {
    try {
      const authInfo = await ensureAuthUid();
      if (!authInfo) return null;

      const apiUrl = `${backendUrl}/uploadRecipeImage`;
      const filename = `cover.jpg`;
      const storagePath = `users/${authInfo.uid}/cookbooks/${cookbookId}/${filename}`;

      const form = new FormData();
      form.append("path", storagePath as any);
      form.append("contentType", "image/jpeg" as any);
      form.append("file", { uri: localUri, name: filename, type: "image/jpeg" } as any);

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
        console.warn("[Cookbook] Backend upload failed", data);
        return null;
      }
      if (data && data.downloadURL) return data.downloadURL as string;
      if (data && data.url) return data.url as string;
      return null;
    } catch (e) {
      console.warn("[Cookbook] Backend upload exception", e);
      return null;
    }
  };

  // Remove current cookbook cover image: delete from Firebase Storage (best-effort) and clear locally
  const removeCookbookCover = async () => {
    if (!cookbookImage) return;
    try {
      // Try to delete the object if this is a download URL or a gs:// path
      try {
        const objRef = ref(storage, cookbookImage);
        await deleteObject(objRef);
        console.log("[Cookbook] Deleted cover from storage");
      } catch (e) {
        console.warn("[Cookbook] deleteObject failed (continuing):", e);
      }

      // Clear from AsyncStorage so the change persists
      const storedCookbooks = await AsyncStorage.getItem("cookbooks");
      const parsedCookbooks = storedCookbooks ? JSON.parse(storedCookbooks) : [];
      const updated = parsedCookbooks.map((c: any) =>
        c.id === id ? { ...c, image: null, imageUrl: null } : c
      );

      // Persist legacy snapshot used by UI screens
      await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));

      // Save via sync engine + trigger remote sync
      const anyEngine = syncEngine as any;
      try {
        if (typeof anyEngine.saveLocalCookbooksSnapshot === "function") {
          await anyEngine.saveLocalCookbooksSnapshot(updated);
        }
        console.log("[CookbookDetail] requesting sync after cover removal");
        // Trigger a full sync NOW.
        if (typeof anyEngine.forceSyncNow === "function") {
          await anyEngine.forceSyncNow("manual");
        } else if (typeof anyEngine.syncAll === "function") {
          try {
            await anyEngine.syncAll("manual", { bypassThrottle: true });
          } catch {
            await anyEngine.syncAll("manual");
          }
        } else if (typeof anyEngine.requestSync === "function") {
          anyEngine.requestSync("manual");
        }
      } catch (syncErr) {
        console.warn("[Cookbook] sync after cover removal failed", syncErr);
      }

      // Update UI state
      setCookbookImage(null);
    } catch (err) {
      console.error("[Cookbook] Error removing cover:", err);
    }
  };

  // --- Save updated cookbook name and image
  const saveCookbookName = async () => {
    if (!newName.trim()) {
      Alert.alert(t("common.validation"), t("recipes.validation_name"));
      return;
    }
    try {
      // If the selected image is a local file, upload it to Firebase Storage first
      let finalCookbookImage: string | null = cookbookImage;
      if (cookbookImage && (cookbookImage.startsWith("file:") || cookbookImage.startsWith("content:"))) {
        const uploaded = await uploadCookbookImage(cookbookImage, String(id));
        if (uploaded) {
          console.log("[Cookbook] Image uploaded =>", uploaded);
          finalCookbookImage = uploaded;
        } else {
          console.warn("[Cookbook] Upload failed; removing local image reference");
          finalCookbookImage = null; // avoid persisting file:// that won't render later
        }
      }
      const storedCookbooks = await AsyncStorage.getItem("cookbooks");
      const parsedCookbooks = storedCookbooks ? JSON.parse(storedCookbooks) : [];

      const updated = parsedCookbooks.map((c: any) =>
        c.id === id
          ? {
              ...c,
              name: newName.trim(),
              // Keep legacy `image` for existing UI, but also persist `imageUrl` for sync.
              image: finalCookbookImage,
              imageUrl: finalCookbookImage,
              updatedAt: Date.now(),
            }
          : c
      );

      // Persist legacy snapshot used by UI screens
      await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));
      // NOTE: `saveLocalCookbooksSnapshot` mirrors this legacy snapshot into the sync-store.

      // Save via sync engine + trigger remote sync
      const anyEngine = syncEngine as any;
      try {
        if (typeof anyEngine.saveLocalCookbooksSnapshot === "function") {
          await anyEngine.saveLocalCookbooksSnapshot(updated);
        }
        console.log("[CookbookDetail] requesting sync after cookbook edit");
        // Trigger a full sync NOW.
        if (typeof anyEngine.forceSyncNow === "function") {
          await anyEngine.forceSyncNow("manual");
        } else if (typeof anyEngine.syncAll === "function") {
          try {
            await anyEngine.syncAll("manual", { bypassThrottle: true });
          } catch {
            await anyEngine.syncAll("manual");
          }
        } else if (typeof anyEngine.requestSync === "function") {
          anyEngine.requestSync("manual");
        }
      } catch (syncErr) {
        console.warn("[Cookbook] sync after cookbook rename failed", syncErr);
      }

      setCookbookName(newName.trim());
      setCookbookImage(finalCookbookImage);
      setEditVisible(false);
    } catch (err) {
      console.error("Error updating cookbook name:", err);
    }
  };

  // --- Pick image for cookbook
  const pickCookbookImage = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (!result.canceled && result.assets && result.assets.length > 0) {
      setCookbookImage(result.assets[0].uri);
    }
  };

  const getNormalizedTags = (tags: any) => {
    if (!tags) return [];
    if (Array.isArray(tags)) {
      return tags.map((t) => (typeof t === "string" ? t : t.name));
    }
    return [];
  };

  const filteredRecipes = recipes.filter((recipe) => {
    const titleMatch = recipe.title.toLowerCase().includes(search.toLowerCase());
    const difficultyMatch =
      selectedDifficulties.length === 0 ||
      selectedDifficulties.includes(normalizeRecipeDifficulty(recipe.difficulty));
    const caloriesMatch =
      selectedCalories.length === 0 ||
      selectedCalories.includes(getRecipeCalorieBucket(recipe));
    const recipeTags = getNormalizedTags(recipe.tags);
    const tagsMatch =
      selectedTags.length === 0 ||
      selectedTags.every((tag) => recipeTags.includes(tag));
    return titleMatch && difficultyMatch && caloriesMatch && tagsMatch;
  });

  const visibleRecipes = [...filteredRecipes].sort((a, b) => {
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

  const calorieFilterOptions: { value: CalorieFilterOption; label: string }[] = [
    {
      value: "none",
      label: t("recipes.calories_filter_none", {
        defaultValue: "No calories",
      }),
    },
    {
      value: "low",
      label: t("recipes.calories_filter_low", {
        defaultValue: "Low (<300 kcal)",
      }),
    },
    {
      value: "medium",
      label: t("recipes.calories_filter_medium", {
        defaultValue: "Medium (300-600 kcal)",
      }),
    },
    {
      value: "high",
      label: t("recipes.calories_filter_high", {
        defaultValue: "High (>600 kcal)",
      }),
    },
  ];

  // Collect all tags from recipes for filter chips
  const allTags = Array.from(
    new Set(
      recipes.reduce((acc: string[], recipe) => {
        const t = getNormalizedTags(recipe.tags);
        return acc.concat(t);
      }, [])
    )
  ).sort();
  const filteredTagOptions = allTags.filter((tag) =>
    tag.toLowerCase().includes(filterTagSearch.trim().toLowerCase())
  );
  const visibleTagOptions =
    filterTagSearch.trim().length > 0
      ? filteredTagOptions
      : filteredTagOptions.slice(0, visibleFilterTagCount);

  const toggleSelection = <T extends string>(
    item: T,
    selected: T[],
    setSelected: (v: T[]) => void
  ) => {
    if (selected.includes(item)) {
      setSelected(selected.filter((i) => i !== item));
    } else {
      setSelected([...selected, item]);
    }
  };

  // --- Delete recipe (modal confirmation)
  const deleteRecipe = (recipeId: string) => {
    setDeleteTarget({ id: recipeId, type: "recipe" });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const recipeId = deleteTarget.id;

    try {
      const stored = await AsyncStorage.getItem("recipes");
      const all = stored ? JSON.parse(stored) : [];

      const now = Date.now();
      let deletedRecipe: any | null = null;

      const updatedAll = Array.isArray(all)
        ? all.map((r: any) => {
            if (!r || r.id !== recipeId) return r;
            deletedRecipe = {
              ...r,
              isDeleted: true,
              updatedAt: now,
            };
            return deletedRecipe;
          })
        : [];

      // Persist legacy snapshot used by UI screens
      await AsyncStorage.setItem("recipes", JSON.stringify(updatedAll));

      // Save via sync engine + mark dirty + trigger remote sync
      const anyEngine = syncEngine as any;
      try {
        if (typeof anyEngine.saveLocalRecipesSnapshot === "function") {
          await anyEngine.saveLocalRecipesSnapshot(updatedAll);
        }

        // Ensure the deletion becomes a dirty item in the sync store
        if (deletedRecipe && typeof anyEngine.markRecipeDirty === "function") {
          await anyEngine.markRecipeDirty(deletedRecipe);
        }

        // Trigger a full sync NOW.
        if (typeof anyEngine.forceSyncNow === "function") {
          await anyEngine.forceSyncNow("manual");
        } else if (typeof anyEngine.syncAll === "function") {
          try {
            await anyEngine.syncAll("manual", { bypassThrottle: true });
          } catch {
            await anyEngine.syncAll("manual");
          }
        } else if (typeof anyEngine.requestSync === "function") {
          anyEngine.requestSync("manual");
        }
      } catch (syncErr) {
        console.warn("[Cookbook] sync after recipe delete failed", syncErr);
      }

      // Update UI state (remove from this cookbook list immediately)
      setRecipes((prev) => prev.filter((r) => r.id !== recipeId));
    } catch (err) {
      console.error("Error deleting recipe:", err);
    }

    setDeleteTarget(null);
  };

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          title: cookbookName,
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
          headerLeft: () => (
            <TouchableOpacity
              onPress={() =>
                router.replace({
                  pathname: "/(tabs)/history",
                  params: { tab: "cookbooks" },
                })
              }
            >
              <MaterialIcons name="arrow-back" size={24} color="#fff" />
            </TouchableOpacity>
          ),
          headerRight: () => (
            <TouchableOpacity
              onPress={() => {
                setNewName(cookbookName);
                setEditVisible(true);
              }}
            >
              <MaterialIcons name="edit" size={24} color="#fff" />
            </TouchableOpacity>
          ),
        }}
      />

      {/* Search and Filter Bar */}
      <View style={[styles.searchRow]}>
        <MaterialIcons name="search" size={24} color={subText} style={{ marginRight: 8 }} />
        <TextInput
          placeholder={t("recipes.search_placeholder")}
          placeholderTextColor={subText}
          value={search}
          onChangeText={setSearch}
          style={{ flex: 1, color: text, fontSize: 16, height: 40 }}
        />
        <TouchableOpacity onPress={() => setFilterVisible(true)}>
          <MaterialIcons name="filter-list" size={24} color={subText} />
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

      {filteredRecipes.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={{ color: subText, marginBottom: 8 }}>
            {t("recipes.no_recipes")}
          </Text>
          <TouchableOpacity onPress={() => router.push("/")}>
            <Text style={{ color: "#E27D60", fontWeight: "600" }}>
              {t("recipes.create_in_ai_kitchen")}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={visibleRecipes}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const recipeTags = getNormalizedTags(item.tags).slice(0, 3);
            return (
              <TouchableOpacity
                onPress={() =>
                  router.push({
                    pathname: "/recipe/[id]",
                    params: { id: item.id, from: `cookbook:${id}` },
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
                      <Text
                        style={[styles.cardTitle, { color: text }]}
                        numberOfLines={2}
                        ellipsizeMode="tail"
                      >
                        {item.title}
                      </Text>
                      <TouchableOpacity
                        onPress={() => deleteRecipe(item.id)}
                        style={styles.deleteButton}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <MaterialIcons name="delete-outline" size={22} color={subText} />
                      </TouchableOpacity>
                    </View>
                    <View style={styles.metaRow}>
                      <Text style={[styles.metaText, { color: subText }]}>
                        {`⏱ ${item.cookingTime} min`}
                      </Text>
                      <Text style={[styles.metaText, { color: subText }]}>
                        {difficultyMap(t)[normalizeRecipeDifficulty(item.difficulty)] ||
                          normalizeRecipeDifficulty(item.difficulty)}
                      </Text>
                      {getRecipeCaloriesPerServing(item) !== null ? (
                        <View style={styles.metaCalories}>
                          <MaterialCommunityIcons name="fire" size={14} color="#E27D60" />
                          <Text style={[styles.metaText, { color: subText }]}>
                            {`${Math.round(getRecipeCaloriesPerServing(item) as number)} kcal`}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    {recipeTags.length > 0 && (
                      <View style={styles.tagRow}>
                        {recipeTags.map((tag) => (
                          <View key={tag} style={[styles.tagChip, { backgroundColor: "#E27D60" }]}>
                            <Text style={styles.tagText}>{tag}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                </AppCard>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setAddVisible(true)}
      >
        <MaterialIcons name="edit" size={22} color="#fff" />
        <Text style={styles.fabText}>{t("recipes.new_recipe")}</Text>
      </TouchableOpacity>

      {/* Edit Cookbook Modal */}
      <Modal visible={editVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setEditVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: text }]}>
                {t("recipes.edit_cookbook")}
              </Text>
              <TouchableOpacity onPress={() => setEditVisible(false)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  color={bg === "#fff" ? "#293a53" : "#fff"}
                />
              </TouchableOpacity>
            </View>
            {/* Cookbook image picker */}
            <TouchableOpacity
              style={{ alignItems: "center", marginBottom: 16 }}
              onPress={pickCookbookImage}
              activeOpacity={0.7}
            >
              <Image
                source={
                  cookbookImage
                    ? { uri: cookbookImage }
                    : defaultImage
                }
                style={{ width: 80, height: 80, borderRadius: 40, marginBottom: 6, borderWidth: 1, borderColor: border }}
              />
              <Text style={{ color: "#E27D60", fontSize: 13 }}>
                {cookbookImage ? t("recipes.tap_to_change_image") : t("recipes.tap_to_upload_image")}
              </Text>
            </TouchableOpacity>
            {cookbookImage ? (
              <TouchableOpacity
                onPress={removeCookbookCover}
                style={{ alignSelf: "center", marginTop: 4, marginBottom: 8, paddingVertical: 6, paddingHorizontal: 10 }}
                activeOpacity={0.7}
              >
                <Text style={{ color: "#E53935", fontWeight: "600" }}>
                  {t("profile.remove_photo", { defaultValue: "Remove Photo" })}
                </Text>
              </TouchableOpacity>
            ) : null}
            <TextInput
              style={[styles.input, { borderColor: border, color: text }]}
              placeholder={t("recipes.cookbook_name_placeholder")}
              placeholderTextColor={subText}
              value={newName}
              onChangeText={setNewName}
            />
            <AppButton label={t("common.confirm")} onPress={saveCookbookName} variant="cta" />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Filter Modal */}
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
                  {Object.entries(difficultyMap(t)).map(([key, label]) => (
                    <TouchableOpacity
                      key={key}
                      style={[
                        styles.filterOption,
                        {
                          backgroundColor: selectedDifficulties.includes(key)
                            ? "#293a53"
                            : "#E0E0E0",
                        },
                      ]}
                      onPress={() =>
                        toggleSelection(key, selectedDifficulties, setSelectedDifficulties)
                      }
                    >
                      <Text
                        style={{
                          color: selectedDifficulties.includes(key) ? "#fff" : "#000",
                        }}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.modalSubtitle}>
                  {t("recipes.calories", { defaultValue: "Calories" })}
                </Text>
                <View style={styles.filterRow}>
                  {calorieFilterOptions.map((option) => (
                    <TouchableOpacity
                      key={option.value}
                      style={[
                        styles.filterOption,
                        {
                          backgroundColor: selectedCalories.includes(option.value)
                            ? "#293a53"
                            : "#E0E0E0",
                        },
                      ]}
                      onPress={() =>
                        toggleSelection(option.value, selectedCalories, setSelectedCalories)
                      }
                    >
                      <Text
                        style={{
                          color: selectedCalories.includes(option.value) ? "#fff" : "#000",
                        }}
                      >
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {allTags.length > 0 && (
                  <>
                    <Text style={styles.modalSubtitle}>{t("recipes.tags")}</Text>
                    <TextInput
                      style={[styles.input, styles.filterSearchInput, { borderColor: border, color: text }]}
                      placeholder={t("recipes.search_tags", { defaultValue: "Search tags" })}
                      placeholderTextColor={subText}
                      value={filterTagSearch}
                      onChangeText={(value) => {
                        setFilterTagSearch(value);
                        setVisibleFilterTagCount(FILTER_TAGS_INITIAL_VISIBLE);
                      }}
                    />
                    <View style={styles.filterRow}>
                      {visibleTagOptions.map((tag) => (
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
                          onPress={() => toggleSelection(tag, selectedTags, setSelectedTags)}
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
                    {filteredTagOptions.length === 0 ? (
                      <Text style={[styles.filterEmptyText, { color: subText }]}>
                        {t("recipes.no_tag_matches", { defaultValue: "No matching tags" })}
                      </Text>
                    ) : null}
                    {filterTagSearch.trim().length === 0 &&
                    filteredTagOptions.length > visibleFilterTagCount ? (
                      <TouchableOpacity
                        style={styles.filterMoreButton}
                        onPress={() =>
                          setVisibleFilterTagCount((prev) => prev + FILTER_TAGS_INITIAL_VISIBLE)
                        }
                      >
                        <Text style={[styles.filterMoreText, { color: text }]}>
                          {t("recipes.show_more_tags", { defaultValue: "Show more tags" })}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </>
                )}

                <TouchableOpacity
                  style={[
                    styles.filterOption,
                    { backgroundColor: "#E0E0E0", marginTop: 12 },
                  ]}
                  onPress={() => {
                    setSelectedDifficulties([]);
                    setSelectedCalories([]);
                    setSelectedTags([]);
                    setFilterTagSearch("");
                    setVisibleFilterTagCount(FILTER_TAGS_INITIAL_VISIBLE);
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

      {/* Sort Modal */}
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

      {/* Add Recipe Modal (styled like History.tsx) */}
      <Modal visible={addVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setAddVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: card, width: 320, alignItems: "stretch", padding: 0 }]}>
            <View style={[styles.modalHeader, { width: "100%", padding: 20, paddingBottom: 8 }]}>
              <Text style={[styles.modalTitle, { color: text }]}>{t("recipes.new_recipe")}</Text>
              <TouchableOpacity onPress={() => setAddVisible(false)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  color={bg === "#fff" ? "#293a53" : "#fff"}
                />
              </TouchableOpacity>
            </View>
            <View style={{ paddingHorizontal: 12, paddingBottom: 16 }}>
              {/* Manual Recipe */}
              <TouchableOpacity
                style={styles.addOptionRow}
                onPress={() => {
                  setAddVisible(false);
                  router.push({ pathname: "/add-recipe", params: { cookbookId: id } });
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.addOptionEmoji}>✍️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.addOptionText, { color: text }]}>{t("recipes.manual_recipe")}</Text>
                  <Text style={[styles.addOptionSub, { color: subText }]}>
                    {t("recipes.manual_recipe_sub")}
                  </Text>
                </View>
                <MaterialIcons name="chevron-right" size={24} color={subText} />
              </TouchableOpacity>

              {/* Import from URL */}
              <TouchableOpacity
                style={styles.addOptionRow}
                onPress={() => {
                  setAddVisible(false);
                  setTimeout(() => setImportUrlVisible(true), 200);
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.addOptionEmoji}>🌐</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.addOptionText, { color: text }]}>{t("recipes.import_from_url")}</Text>
                  <Text style={[styles.addOptionSub, { color: subText }]}>
                    {t("recipes.import_desc")}
                  </Text>
                </View>
                <MaterialIcons name="chevron-right" size={24} color={subText} />
              </TouchableOpacity>

              {/* Import from File/App */}
              <TouchableOpacity
                style={styles.addOptionRow}
                onPress={() => {
                  setAddVisible(false);
                  setImportFileError("");
                  setTimeout(() => {
                    setImportFileVisible(true);
                  }, 200);
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.addOptionEmoji}>📁</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.addOptionText, { color: text }]}>{t("recipes.import_from_file")}</Text>
                  <Text style={[styles.addOptionSub, { color: subText }]}>
                    {t("recipes.import_from_file_sub")}
                  </Text>
                </View>
                <MaterialIcons name="chevron-right" size={24} color={subText} />
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      <ImportFileModal
        visible={importFileVisible}
        onClose={() => {
          if (!importFileLoading) {
            setImportFileVisible(false);
            setImportFileError("");
          }
        }}
        onImport={handleImportFromFile}
        onHelpPress={openImportFileHelp}
        loading={importFileLoading}
        loadingText={importFileLoadingText}
        error={importFileError || null}
        cardColor={card}
        textColor={text}
        subTextColor={subText}
        borderColor={border}
      />

      {/* Import from URL Modal */}
      <Modal visible={importUrlVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => {
            setImportUrlVisible(false);
            setImportError("");
          }}
        >
          <View style={[styles.modalContent, { backgroundColor: card }]}>
            <View style={styles.modalHeader}>
              <Text
                style={[
                  styles.modalTitle,
                  bg !== "#fff" ? { color: text } : null,
                ]}
              >
                {t("recipes.import_from_url")}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setImportUrlVisible(false);
                  setImportError("");
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
                setImportError("");
              }}
              editable={!importLoading}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
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
                {shouldHidePremiumPricing(freePremiumActionsRemaining) ? (
                  <Text style={{ color: subText, lineHeight: 19 }}>
                    {t("recipes.instagram_reel_import_free_runway_body", {
                      defaultValue:
                        "We’ll turn this Reel into a recipe draft for you to review before saving.",
                    })}
                  </Text>
                ) : (
                  <>
                    <Text style={{ color: subText, lineHeight: 19 }}>
                      {t("recipes.instagram_reel_import_confirm_body", {
                        count: INSTAGRAM_REEL_IMPORT_COST,
                        defaultValue:
                          "Importing a recipe from an Instagram Reel costs {{count}} Eggs. We will only charge you if we create a high-quality draft.",
                      })}
                    </Text>
                    <Text style={{ color: subText, marginTop: 8 }}>
                      {instagramImportBalanceLoading
                        ? t("economy.loading_balance", {
                            defaultValue: "Checking your Eggs...",
                          })
                        : t("economy.current_balance_short", {
                            count: instagramImportBalance ?? 0,
                            defaultValue: "You have {{count}} Eggs.",
                          })}
                    </Text>
                  </>
                )}
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
                opacity: importLoading ? 0.7 : 1,
              }}
              disabled={importLoading}
              onPress={async () => {
                setImportError("");
                if (!importUrl.trim() || !/^https?:\/\/.+/i.test(importUrl.trim())) {
                  setImportError(t("recipes.invalid_url"));
                  return;
                }
                setImportLoading(true);
                setImportUrlLoadingText(
                  t("recipes.url_import_progress_fetching", {
                    defaultValue: "Fetching recipe...",
                  })
                );
                try {
                  const trimmedUrl = importUrl.trim();
                  const isInstagram = isInstagramReelUrl(trimmedUrl);
                  const apiUrl = isInstagram
                    ? `${backendUrl}/extractRecipeDraftFromUrl`
                    : `${backendUrl}/importRecipeFromUrl`;
                  const language = i18n.language || "en";
                  const measurementSystem = await getMeasurementSystemForImport();
                  const headers = await buildBackendAuthHeaders();

                  if (isInstagram) {
                    const confirmed = await promptInstagramReelCookies();
                    if (!confirmed) {
                      setImportLoading(false);
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

                  const res = await fetch(apiUrl, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(
                      isInstagram
                        ? { url: trimmedUrl, language, measurementSystem }
                        : { url: trimmedUrl }
                    ),
                  });
                  let data;
                  try {
                    data = await res.json();
                  } catch (jsonErr) {
                    // Could not parse server response
                    let errMsg = t("recipes.invalid_import");
                    setImportError(errMsg);
                    setImportLoading(false);
                    return;
                  }
                  if (!res.ok) {
                    let errMsg = t("recipes.invalid_import");
                    try {
                      if (
                        isInstagram &&
                        res.status === 402 &&
                        (data?.code === "ECON_NOT_ENOUGH_COOKIES" ||
                          data?.error === "insufficient_cookies")
                      ) {
                        setInstagramImportBalance(
                          typeof data?.remaining === "number" ? data.remaining : 0
                        );
                        await openInsufficientCookiesModal(
                          typeof data?.remaining === "number" ? data.remaining : 0
                        );
                        setImportLoading(false);
                        setImportUrlLoadingText(null);
                        return;
                      }
                      if (data && (data.errorCode || data.code)) {
                        if (
                          data.errorCode === "INVALID_RECIPE_STRUCTURE" ||
                          data.code === "INSTAGRAM_RECIPE_NOT_EXTRACTED"
                        ) {
                          errMsg =
                            data.code === "INSTAGRAM_RECIPE_NOT_EXTRACTED"
                              ? t("recipes.invalid_instagram_import", {
                                  defaultValue:
                                    "We could not build a reliable recipe draft from this Instagram Reel. Try another Reel or edit the recipe manually.",
                                })
                              : t("recipes.invalid_import");
                        } else if (data.code === "UNSUPPORTED_SOURCE_URL") {
                          errMsg = t("recipes.invalid_instagram_reel_url", {
                            defaultValue:
                              "This Instagram link is not a supported Reel URL.",
                          });
                        }
                      } else if (data && data.error) {
                        errMsg = data.error;
                      } else if (data && data.message) {
                        errMsg = data.message;
                      }
                    } catch (_) {
                      // ignore JSON parse errors
                    }
                    setImportError(errMsg);
                    setImportLoading(false);
                    setImportUrlLoadingText(null);
                    return;
                  }
                  if (!data || !data.recipe) {
                    let errMsg = t("recipes.invalid_import");
                    setImportError(errMsg);
                    setImportLoading(false);
                    setImportUrlLoadingText(null);
                    return;
                  }
                  // Validate minimal fields (title, ingredients, steps)
                  const r = data.recipe;
                  if (!r.title || !r.ingredients || !r.steps) {
                    let errMsg = t("recipes.invalid_import");
                    setImportError(errMsg);
                    setImportLoading(false);
                    setImportUrlLoadingText(null);
                    return;
                  }

                  if (isInstagram) {
                    setImportUrlLoadingText(
                      t("recipes.url_import_progress_opening_review", {
                        defaultValue: "Opening recipe review...",
                      })
                    );
                    const draftKey = "pending_import_recipe_draft";
                    await AsyncStorage.setItem(draftKey, JSON.stringify(r));
                    try {
                      if (backendUrl) {
                        await claimEconomyReward({
                          backendUrl,
                          appEnv,
                          auth,
                          rewardKey: "first_instagram_reel_import_v1",
                        });
                      }
                    } catch (rewardErr) {
                      console.warn("[Cookbook] Instagram Reel reward claim failed", rewardErr);
                    }
                    setImportLoading(false);
                    setImportUrlVisible(false);
                    setImportUrl("");
                    setImportError("");
                    router.push({
                      pathname: "/add-recipe",
                      params: { draftKey, cookbookId: String(id) },
                    } as any);
                    return;
                  }

                  // Save to AsyncStorage
                  const storedRecipes = await AsyncStorage.getItem("recipes");
                  const recipesArr = storedRecipes ? JSON.parse(storedRecipes) : [];
                  // Add cookbook id to cookbooks array
                  const now = Date.now();
                  const newRecipe = {
                    ...r,
                    id:
                      r.id ||
                      "r-" +
                        Math.random().toString(36).slice(2) +
                        Date.now().toString(36),
                    cookbooks: [id],
                    createdAt: now,
                    updatedAt: now,
                    isDeleted: false,
                  };
                  recipesArr.unshift(newRecipe);

                  // Persist legacy snapshot for UI screens
                  await AsyncStorage.setItem("recipes", JSON.stringify(recipesArr));

                  // Save via sync engine + mark dirty + trigger remote sync
                  const anyEngine = syncEngine as any;
                  try {
                    if (typeof anyEngine.saveLocalRecipesSnapshot === "function") {
                      await anyEngine.saveLocalRecipesSnapshot(recipesArr);
                    }
                    if (typeof anyEngine.markRecipeDirty === "function") {
                      await anyEngine.markRecipeDirty(newRecipe);
                    }
                    // Trigger a full sync NOW.
                    if (typeof anyEngine.forceSyncNow === "function") {
                      await anyEngine.forceSyncNow("manual");
                    } else if (typeof anyEngine.syncAll === "function") {
                      try {
                        await anyEngine.syncAll("manual", { bypassThrottle: true });
                      } catch {
                        await anyEngine.syncAll("manual");
                      }
                    } else if (typeof anyEngine.requestSync === "function") {
                      anyEngine.requestSync("manual");
                    }
                  } catch (syncErr) {
                    console.warn(
                      "[Cookbook] sync after import-from-URL create failed",
                      syncErr
                    );
                  }

                  try {
                    if (backendUrl) {
                      const activeRecipeCount = Array.isArray(recipesArr)
                        ? recipesArr.filter((item: any) => !item?.isDeleted).length
                        : 0;
                      await claimRewardKeysSequentially(
                        {
                          backendUrl,
                          appEnv,
                          auth,
                        },
                        getRecipeRewardKeysForCount(activeRecipeCount)
                      );
                    }
                  } catch (rewardErr) {
                    console.warn("[Cookbook] imported recipe reward claim failed", rewardErr);
                  }

                  setRecipes((prev) => [newRecipe, ...prev]);
                  setImportLoading(false);
                  setImportUrlVisible(false);
                  setImportUrl("");
                  setImportError("");
                  setImportedRecipe(newRecipe);
                  setSuccessVisible(true);
                } catch (err: any) {
                  setImportLoading(false);
                  setImportUrlLoadingText(null);
                  let msg = t("recipes.invalid_import");
                  if (err && err.message) msg = err.message;
                  setImportError(msg);
                  return;
                } finally {
                  setImportLoading(false);
                  setImportUrlLoadingText(null);
                }
              }}
            >
              {importLoading ? (
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
                    ? t("common.proceed", { defaultValue: "Proceed" })
                    : t("recipes.import_button")}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
      <InsufficientCookiesModal
        visible={insufficientModalVisible}
        isDark={isDark}
        title={t("economy.insufficient_title", "Not enough Eggs")}
        body={`You need ${INSTAGRAM_REEL_IMPORT_COST} Eggs to import a recipe from Instagram Reel. Currently, you have ${insufficientCookiesRemaining} Eggs.`}
        featuredOffer={featuredOffer}
        availableRewardsCount={availableRewardsCount}
        onClose={() => setInsufficientModalVisible(false)}
        onBuyOffer={() => {
          setInsufficientModalVisible(false);
          router.push({
            pathname: "/economy/store",
            params: { highlight: "cookies_15", autoBuy: "1" },
          } as any);
        }}
        onOpenStore={() => {
          setInsufficientModalVisible(false);
          router.push({
            pathname: "/economy/store",
            params: { highlight: "cookies_15" },
          } as any);
        }}
        onOpenRewards={() => {
          setInsufficientModalVisible(false);
          router.push("/economy/store" as any);
        }}
      />
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
                <MaterialIcons name="close" size={24} color="#293a53" />
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
                      pathname: "/recipe/[id]",
                      params: { id: importedRecipe.id, from: `cookbook:${id}` },
                    });
                  }
                }}
                style={{ paddingHorizontal: 8, paddingVertical: 6 }}
              >
                <Text style={{ color: "#3b4a6b", fontWeight: "bold", fontSize: 15, textTransform: "uppercase" }}>
                  {t("recipes.open_recipe")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
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
                  {
                    color: text,
                    flex: 1,
                    paddingRight: 12,
                  },
                ]}
                numberOfLines={2}
                ellipsizeMode="tail"
              >
                {t("recipes.delete_recipe_confirm")}
              </Text>
              <TouchableOpacity onPress={() => setDeleteTarget(null)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  color={text}
                />
              </TouchableOpacity>
            </View>
            <Text style={{ color: subText, marginBottom: 18, fontSize: 15 }}>
              {t("recipes.delete_recipe_desc")}
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
  recipeCard: { flexDirection: "row", padding: 10 },
  recipeImage: { width: 80, height: 80, borderRadius: 12, marginRight: 12 },
  cardTitle: {
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
    flexShrink: 1,
    marginBottom: 4,
    paddingRight: 10,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: 12,
    rowGap: 4,
    marginBottom: 8,
  },
  metaText: {
    fontSize: 13,
    lineHeight: 18,
  },
  metaCalories: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  deleteButton: {
    paddingLeft: 6,
    paddingTop: 2,
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
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center" },
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
  filterSearchInput: {
    marginBottom: 10,
  },
  filterEmptyText: {
    fontSize: 13,
    marginTop: 2,
    marginBottom: 4,
  },
  filterMoreButton: {
    alignSelf: "flex-start",
    paddingVertical: 6,
  },
  filterMoreText: {
    fontSize: 13,
    fontWeight: "700",
  },
  filterOption: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
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
    marginBottom: 12,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "#F5F5F5",
  },
  resultMetaText: {
    fontSize: 13,
    fontWeight: "600",
  },
  sortSummaryButton: {
    alignSelf: "flex-start",
    marginTop: 2,
    marginBottom: 6,
    marginHorizontal: 16,
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingRight: 3, // small right padding so last tag doesn't touch the edge
  },
  tagChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    marginRight: 8,
    marginBottom: 8,
  },
  tagText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#fff",
  },
  filterSectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginTop: 10,
    marginBottom: 6,
  },
  addOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: "#ececec",
    backgroundColor: "transparent",
  },
  addOptionEmoji: {
    fontSize: 26,
    marginRight: 14,
  },
  addOptionText: {
    fontSize: 16,
    fontWeight: "600",
  },
  addOptionSub: {
    fontSize: 13,
    color: "#888",
    marginTop: 2,
  },
});
