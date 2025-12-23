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
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { getDeviceId } from "../utils/deviceId";
import { useSyncEngine } from "../lib/sync/SyncEngine";

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
}

interface Cookbook {
  id: string;
  name: string;
}

export default function AddRecipe() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ edit?: string; editId?: string; cookbookId?: string }>();
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);

  const [title, setTitle] = useState("");
  const [cookingTime, setCookingTime] = useState("");
  const [difficulty, setDifficulty] = useState<"Easy" | "Moderate" | "Challenging">("Easy");
  const [servings, setServings] = useState("");
  const [cost, setCost] = useState<"Cheap" | "Medium" | "Expensive">("Cheap");
  const [ingredients, setIngredients] = useState("");
  const [steps, setSteps] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [allTags, setAllTags] = useState<string[]>([]);
  const [image, setImage] = useState<string | undefined>(undefined); // 🔹 imagem escolhida

  const [cookbooks, setCookbooks] = useState<Cookbook[]>([]);
  const [selectedCookbooks, setSelectedCookbooks] = useState<string[]>([]);
  const [newCookbookName, setNewCookbookName] = useState("");

  const [saving, setSaving] = useState(false);

  const router = useRouter();
  const { bg, text, border, card, isDark } = useThemeColors();
  const syncEngine = useSyncEngine();
  const backendUrl = process.env.EXPO_PUBLIC_API_URL;
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  console.log("Using backend URL:", backendUrl, "env:", appEnv);

  // --- Insufficient cookies modal (cookbooks) ---
  const [insufficientModal, setInsufficientModal] = useState<{
    visible: boolean;
    remaining: number;
  }>({ visible: false, remaining: 0 });

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

  // --- Economy: fetch cookie balance and pre-check before cookbook creation ---
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

  // Helper to normalize and apply a recipe object to state for editing
  function normalizeAndApplyRecipe(raw: Recipe) {
    const allowedDifficulties = ["Easy", "Moderate", "Challenging"];
    const allowedCosts = ["Cheap", "Medium", "Expensive"];
    const normalizedDifficulty: "Easy" | "Moderate" | "Challenging" =
      allowedDifficulties.includes(raw.difficulty) ? (raw.difficulty as any) : "Easy";
    const normalizedCost: "Cheap" | "Medium" | "Expensive" =
      allowedCosts.includes(raw.cost) ? (raw.cost as any) : "Cheap";

    const recipe: Recipe = {
      ...raw,
      difficulty: normalizedDifficulty,
      cost: normalizedCost,
    };

    setEditingRecipe(recipe);
    setTitle(recipe.title || "");
    setCookingTime(String(recipe.cookingTime || ""));
    setDifficulty(normalizedDifficulty);
    setServings(String(recipe.servings || ""));
    setCost(normalizedCost);
    setIngredients((recipe.ingredients || []).join("\n"));
    setSteps((recipe.steps || []).join("\n"));
    setTags(recipe.tags || []);
    setImage(recipe.image || (recipe as any).imageUrl);

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
      } catch (err) {
        console.error("❌ Failed to initialize edit recipe", err);
      }
    };
    loadForEdit();
  }, [params.editId, params.edit]);

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
      Alert.alert("Permission required", "We need access to your gallery!");
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
      Alert.alert("Validation", "Cookbook name cannot be empty.");
      return;
    }
    // Check if cookbook with same name exists
    if (cookbooks.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      Alert.alert("Validation", "Cookbook with this name already exists.");
      return;
    }
    // Economy gate: ALWAYS ask the backend to consume (or allow for free) before creating locally.
    // This avoids relying on local cookbook counts (defaults/deletions) and guarantees correctness.
    // Backend may allow for free (default cookbooks + 1 free user-created), or charge 1 Cookie.
    // If insufficient, it returns 402 and we show the shared Insufficient Cookies modal.
    const allowed = await consumeCookbookCookieIfNeeded();
    if (!allowed) {
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

  /**
   * Economy: attempt to consume cookies for creating an additional cookbook.
   * Backend decides whether this action costs 0 or 1 cookie based on limits.
   *
   * IMPORTANT:
   * - We must send auth headers; otherwise backend may not be able to identify the user/balance.
   * - If backend returns 402, we show the shared Insufficient Cookies modal (same UX as History).
   */
  const consumeCookbookCookieIfNeeded = async (): Promise<boolean> => {
    try {
      // If backend URL is missing, do not block cookbook creation.
      if (!backendUrl) {
        console.warn("[AddRecipe] No backend URL configured; skipping economy consume for cookbook");
        return true;
      }

      // Ensure we have an authenticated user (anonymous is OK) so the backend can attribute the consume.
      const authInfo = await ensureAuthUid();
      if (!authInfo?.token) {
        // If we can't identify the user, we should not allow a paid action.
        // This was a major bypass path.
        console.warn("[AddRecipe] Missing auth token for economy consume; blocking cookbook creation");
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

      // If the backend doesn't implement /economy/consume in this environment,
      // fall back to a balance pre-check so we *still* block and show the modal when needed.
      // If even the balance endpoint is missing/unavailable, we avoid blocking.
      if (res.status === 404) {
        const ok = await ensureHasCookiesOrPrompt(1);
        return ok;
      }

      // Insufficient cookies
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

      // If unauthorized/forbidden, do NOT allow cookbook creation.
      // Allowing here creates an economy bypass (exactly what you're seeing).
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
        // Some deployments may return 200 with a structured payload indicating
        // the action was NOT allowed (instead of using 402). Handle both.
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

          // If the backend explicitly says it's not allowed, treat it as insufficient.
          if (allowedFlag === false || successFlag === false) {
            await openInsufficientCookiesModal(remaining);
            return false;
          }

          // Cache remaining balance if provided
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

      // Unexpected non-OK
      let message: string | null = null;
      try {
        const data = await res.json().catch(() => null);
        if (typeof (data as any)?.message === "string") message = (data as any).message;
        if (!message && typeof (data as any)?.error === "string") message = (data as any).error;
      } catch {
        // ignore
      }

      // Do not hard-block on unexpected backend failures; show a friendly error.
      Alert.alert(
        t("common.error", "Error"),
        message || t("wizard.error_generate", "Something went wrong. Please try again.")
      );
      return false;
    } catch (err) {
      console.warn("[AddRecipe] economy/consume exception; blocking cookbook creation to avoid bypass", err);
      Alert.alert(
        t("common.error", "Error"),
        t("economy.try_again", "Couldn't verify your Cookie balance. Please try again.")
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

      const info = await ImageManipulator.getInfoAsync(uri, { size: true } as any);
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
      Alert.alert("Validation", "Title is required.");
      return;
    }
    if (!ingredients.trim()) {
      Alert.alert("Validation", "At least one ingredient is required.");
      return;
    }
    if (!steps.trim()) {
      Alert.alert("Validation", "At least one preparation step is required.");
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

      // Build the complete recipe object with all fields
      const newRecipe: Recipe = {
        id: editingRecipe ? editingRecipe.id : `${Date.now()}`,
        title: title.trim(),
        cookingTime: parseInt(cookingTime) || 30,
        difficulty,
        servings: parseInt(servings) || 2,
        cost,
        ingredients: ingredients.split("\n").map((i) => i.trim()).filter(Boolean),
        steps: steps.split("\n").map((s) => s.trim()).filter(Boolean),
        tags: [...tags],
        cookbooks: selectedCookbookObjs,
        createdAt: editingRecipe ? editingRecipe.createdAt : new Date().toISOString(),
        image: finalImageUri,
        imageUrl: finalImageUri,
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

      router.back();
    } catch (err) {
      console.error("Error saving recipe:", err);
      Alert.alert("Error", "Failed to save recipe.");
    } finally {
      setSaving(false);
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

          {/* Cost */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.cost")}</Text>
          <View style={styles.row}>
            {([
              { label: t("cost.cheap"), value: "Cheap" },
              { label: t("cost.medium"), value: "Medium" },
              { label: t("cost.expensive"), value: "Expensive" },
            ] as const).map(({ label, value }) => (
              <AppButton
                key={value}
                label={label}
                onPress={() => setCost(value)}
                variant={cost === value ? "primary" : "secondary"}
                fullWidth={false}
                style={{
                  flex: 1,
                  marginHorizontal: 4,
                  ...(cost === value && bg !== "#fff" ? { backgroundColor: "#E27D60" } : {}),
                }}
              />
            ))}
          </View>

          {/* Ingredients */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.ingredients_line")} *</Text>
          <AppCard>
            <AutoExpandingTextInput
              style={[
                styles.input,
                {
                  textAlignVertical: "top",
                  color: text,
                  borderColor: border,
                  backgroundColor: card,
                },
              ]}
              value={ingredients}
              onChangeText={(text) => setIngredients(sanitizeInput(text, true))}
              placeholder={t("recipes.ingredients_placeholder")}
              placeholderTextColor="#888"
              multiline
              minHeight={80}
              maxHeight={180}
            />
          </AppCard>

          {/* Preparation */}
          <Text style={[styles.label, { color: text }]}>{t("recipes.preparation_line")} *</Text>
          <AppCard>
            <AutoExpandingTextInput
              style={[
                styles.input,
                {
                  textAlignVertical: "top",
                  color: text,
                  borderColor: border,
                  backgroundColor: card,
                },
              ]}
              value={steps}
              onChangeText={(text) => setSteps(sanitizeInput(text, true))}
              placeholder={t("recipes.preparation_placeholder")}
              placeholderTextColor="#888"
              multiline
              minHeight={120}
              maxHeight={240}
            />
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
                style={[
                  styles.inputRowButton,
                  bg !== "#fff" ? { backgroundColor: "#E27D60" } : {},
                ]}
              />
            </View>
            <Text
              style={[
                styles.cookbookPricingNote,
                { color: isDark ? "#bbb" : "#666" },
              ]}
            >
              {t(
                "economy.cookbook_pricing_note_short",
                "New cookbooks deduct 1 Cookie from your balance."
              )}
            </Text>
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
                style={[
                  styles.inputRowButton,
                  bg !== "#fff" ? { backgroundColor: "#E27D60" } : {},
                ]}
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
            style={[
              { marginTop: 10, opacity: saving ? 0.7 : 1 },
              bg !== "#fff" ? { backgroundColor: "#E27D60" } : {},
            ]}
          />
        </KeyboardAwareScrollView>
      </TouchableWithoutFeedback>

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
  input: {
    borderWidth: 1,
    padding: 12,
    borderRadius: 10,
    fontSize: 16,
    marginBottom: 10,
    minHeight: 44,
  },
  row: { flexDirection: "row", marginBottom: 10 },
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
  ...props
}) => {
  const [inputHeight, setInputHeight] = useState(minHeight);
  const inputRef = useRef<RNTextInput>(null);

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