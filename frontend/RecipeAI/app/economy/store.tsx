import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Alert, Platform, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import { useThemeColors } from "../../context/ThemeContext";
import { getApiBaseUrl } from "../../lib/config/api";
import { useTranslation } from "react-i18next";
import { getAuth } from "firebase/auth";
import { getDeviceId } from "../../utils/deviceId";
import AsyncStorage from "@react-native-async-storage/async-storage";
import EconomyActivityModal from "../../components/EconomyActivityModal";
import EggIcon from "../../components/EggIcon";
import { fetchEconomyHistory, type EconomyLedgerEntry } from "../../lib/economy/client";
import {
  initConnection,
  endConnection,
  fetchProducts,
  requestPurchase,
  purchaseUpdatedListener,
  purchaseErrorListener,
  finishTransaction,
  type Product,
  type Purchase,
} from "react-native-iap";

type Offer = {
  id: string;
  productId?: string; // Google Play product id (SKU)
  title: string;
  subtitle?: string;
  price: number;
  currency: string;
  cookies: number;
  badges?: string[]; // e.g. ["🔥", "🎄", "💸"]
  isPromo?: boolean;
  sortOrder?: number;
  bonusCookies?: number;
  mostPurchased?: boolean;
};

type BonusOffer = {
  id: string;
  title: string;
  subtitle?: string;
  cookies: number;
  status?: "available" | "redeemed" | "locked";
  badges?: string[];
  action?: string;
  reason?: string;
};

const toNumber = (v: any, fallback = 0) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};
const toString = (v: any, fallback = "") => (typeof v === "string" ? v : fallback);
const pickFirstArray = (...candidates: any[]): any[] => {
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
};

const formatPrice = (price: number, currency: string) => {
  // Keep it simple and deterministic for now (no Intl surprises across JS engines)
  const p = Math.round(price * 100) / 100;
  const cur = (currency || "").toUpperCase();
  return `${p.toFixed(2)} ${cur}`;
};

const parseCookiesFromTitle = (title: string): number | null => {
  // Examples: "15 Eggs", "50 Eggs" -> 15/50
  const m = String(title || "").match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
};

const rewardCopyById: Record<string, { descriptionKey: string; highlightKey: string; defaultHighlight: string }> = {
  signup_bonus_v1: {
    descriptionKey: "economy.reward_signup_bonus_description",
    highlightKey: "economy.reward_signup_bonus_highlight",
    defaultHighlight: "Create an account",
  },
  profile_health_goals_v1: {
    descriptionKey: "economy.reward_profile_health_goals_description",
    highlightKey: "economy.reward_profile_health_goals_highlight",
    defaultHighlight: "profile and Health & Goals",
  },
  first_recipe_saved_v1: {
    descriptionKey: "economy.reward_first_recipe_description",
    highlightKey: "economy.reward_first_recipe_highlight",
    defaultHighlight: "first recipe",
  },
  recipes_10_v1: {
    descriptionKey: "economy.reward_recipes_10_description",
    highlightKey: "economy.reward_recipes_10_highlight",
    defaultHighlight: "10 recipes",
  },
  recipes_25_v1: {
    descriptionKey: "economy.reward_recipes_25_description",
    highlightKey: "economy.reward_recipes_25_highlight",
    defaultHighlight: "25 recipes",
  },
  first_meal_logged_v1: {
    descriptionKey: "economy.reward_first_meal_description",
    highlightKey: "economy.reward_first_meal_highlight",
    defaultHighlight: "first meal",
  },
  meals_10_v1: {
    descriptionKey: "economy.reward_meals_10_description",
    highlightKey: "economy.reward_meals_10_highlight",
    defaultHighlight: "10 meals",
  },
  meals_25_v1: {
    descriptionKey: "economy.reward_meals_25_description",
    highlightKey: "economy.reward_meals_25_highlight",
    defaultHighlight: "25 meals",
  },
  first_cookbook_created_v1: {
    descriptionKey: "economy.reward_first_cookbook_description",
    highlightKey: "economy.reward_first_cookbook_highlight",
    defaultHighlight: "first cookbook",
  },
  first_instagram_reel_import_v1: {
    descriptionKey: "economy.reward_first_instagram_description",
    highlightKey: "economy.reward_first_instagram_highlight",
    defaultHighlight: "first recipe from an Instagram Reel",
  },
};

const renderRewardSubtitle = (bonus: BonusOffer, color: string, t: (key: string, options?: any) => string) => {
  const copy = rewardCopyById[bonus.id];
  const subtitle = copy
    ? t(copy.descriptionKey, { defaultValue: bonus.subtitle || "" })
    : bonus.subtitle || "";
  const highlight = copy
    ? t(copy.highlightKey, { defaultValue: copy.defaultHighlight })
    : "";
  if (!subtitle || !highlight) return subtitle;

  const index = subtitle.toLowerCase().indexOf(highlight.toLowerCase());
  if (index < 0) return subtitle;

  const before = subtitle.slice(0, index);
  const match = subtitle.slice(index, index + highlight.length);
  const after = subtitle.slice(index + highlight.length);

  return (
    <>
      {before}
      <Text style={[styles.offerSubtitleStrong, { color }]}>{match}</Text>
      {after}
    </>
  );
};

export default function EconomyStoreScreen() {
  const { t, i18n } = useTranslation();
  const { bg, text, card, border, isDark } = useThemeColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ highlight?: string; autoBuy?: string }>();

  const backendUrl = getApiBaseUrl()!;
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  const isLocalDev = __DEV__;

  // ✅ auth.currentUser isn't reactive; track uid in state so balance refreshes on login/logout.
  const auth = getAuth();
  const [economyUid, setEconomyUid] = useState<string | null>(auth.currentUser?.uid ?? null);
  const isAnon = !!auth.currentUser?.isAnonymous;

  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState<number | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [bonuses, setBonuses] = useState<BonusOffer[]>([]);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [activityVisible, setActivityVisible] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityEntries, setActivityEntries] = useState<EconomyLedgerEntry[]>([]);

  const availableBonuses = useMemo(
    () => bonuses.filter((b) => b.status !== "redeemed"),
    [bonuses]
  );
  const redeemedBonuses = useMemo(
    () => bonuses.filter((b) => b.status === "redeemed"),
    [bonuses]
  );

  const openBonusAction = useCallback((bonus: BonusOffer) => {
    switch (bonus.action) {
      case "create_account":
        router.push("/auth/signup");
        return;
      case "open_my_day_health_goals":
        router.push({ pathname: "/my-day", params: { openHealthGoals: "1" } } as any);
        return;
      case "open_recipe_picker":
        router.push({ pathname: "/history", params: { openNewRecipe: "1" } } as any);
        return;
      case "open_my_day":
        router.push("/my-day" as any);
        return;
      case "open_history_cookbooks":
        router.push({ pathname: "/history", params: { tab: "cookbooks" } } as any);
        return;
      default:
        return;
    }
  }, [router]);

  // --- Google Play Billing (Android) ---
  // IMPORTANT: We NEVER grant cookies on-device. The backend must verify the purchase token
  // with Google Play and then credit the user's balance. Only after backend success do we
  // finish/acknowledge the transaction.
  const [iapReady, setIapReady] = useState(false);
  const [iapProducts, setIapProducts] = useState<Record<string, Product>>({});
  const purchaseInFlightRef = useRef(false);
  const autoBuyAttemptedRef = useRef(false);

  const offerSkus = useMemo(() => {
    const skus = offers
      .map((o) => String(o.productId || o.id || "").trim())
      .filter(Boolean);
    // Unique + stable
    return Array.from(new Set(skus));
  }, [offers]);

  const verifyPurchaseWithBackend = useCallback(
    async (
      purchase: Purchase
    ): Promise<{ ok: boolean; message?: string; balance?: number | null }> => {
      if (!backendUrl) {
        return { ok: false, message: "Backend URL is not configured." };
      }

      // We must be able to authenticate the user so the backend can credit the correct wallet.
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken().catch(() => null) : null;
      if (!idToken) {
        return { ok: false, message: "Missing auth token. Please sign in again and retry." };
      }

      const deviceId = await getDeviceId().catch(() => null);
      const userId = auth.currentUser?.uid ?? null;

      // Android: purchaseToken is the key value the backend verifies with Google.
      const purchaseToken = (purchase as any)?.purchaseToken;
      const productId = (purchase as any)?.productId || (purchase as any)?.sku;

      if (!purchaseToken || !productId) {
        return { ok: false, message: "Missing purchase token/product id." };
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
        "x-app-env": appEnv,
      };
      if (deviceId) headers["x-device-id"] = deviceId;
      if (userId) headers["x-user-id"] = userId;

      // NOTE: Backend must implement this endpoint.
      // It should:
      // 1) verify purchaseToken with Google Play Developer API
      // 2) grant cookies (idempotently)
      // 3) return updated balance
      // If not implemented, keep the purchase un-finished so it can be retried.
      const res = await fetch(`${backendUrl}/economy/verify-play`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          productId,
          purchaseToken,
          platform: "android",
          env: appEnv,
          uid: userId,
        }),
      });

      if (res.status === 404) {
        return { ok: false, message: "Purchase verification endpoint is not implemented on the backend." };
      }

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!res.ok) {
        const msg =
          toString(data?.message) ||
          toString(data?.error) ||
          `Purchase verification failed (${res.status})`;
        return { ok: false, message: msg };
      }

      const nextBalance =
        typeof data?.balance === "number"
          ? data.balance
          : typeof data?.remaining === "number"
            ? data.remaining
            : null;

      return { ok: true, balance: nextBalance };
    },
    [backendUrl, auth, appEnv]
  );


  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => {
      setEconomyUid(u?.uid ?? null);
      setIsLoggedIn(!!u);
    });
    return () => unsub();
  }, [auth]);

  const loadBalance = useCallback(async () => {
    const cacheKey = `economy_cookie_balance_${economyUid || "anon"}`;

    // If backend is not configured, fallback to cached value only.
    if (!backendUrl) {
      try {
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached != null && !Number.isNaN(Number(cached))) {
          setBalance(Number(cached));
        }
      } catch {
        // ignore
      }
      return;
    }

    try {
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : undefined;
      const headers: Record<string, string> = {};
      if (idToken) headers.Authorization = `Bearer ${idToken}`;

      // Try GET first; fallback to POST if GET is not supported.
      let res: Response | null = null;
      try {
        const qs = `?env=${encodeURIComponent(appEnv)}`;
        res = await fetch(`${backendUrl}/economy/balance${qs}`, {
          method: "GET",
          headers,
        });
      } catch {
        res = null;
      }

      if (!res || res.status === 404 || res.status === 405) {
        res = await fetch(`${backendUrl}/economy/balance`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ env: appEnv }),
        });
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(`economy/balance status ${res.status} ${bodyText}`);
      }

      const data = await res.json().catch(() => ({}));
      const next =
        typeof (data as any)?.balance === "number"
          ? (data as any).balance
          : typeof (data as any)?.remaining === "number"
            ? (data as any).remaining
            : null;

      if (typeof next === "number") {
        setBalance(next);
        try {
          await AsyncStorage.setItem(cacheKey, String(next));
        } catch {
          // ignore
        }
      }
    } catch {
      // fallback to cache
      try {
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached != null && !Number.isNaN(Number(cached))) {
          setBalance(Number(cached));
        }
      } catch {
        // ignore
      }
    }
  }, [backendUrl, appEnv, auth, economyUid]);

  const loadActivity = useCallback(async () => {
    if (!backendUrl) return;
    setActivityLoading(true);
    try {
      const entries = await fetchEconomyHistory({
        backendUrl,
        appEnv,
        auth,
        limit: 50,
      });
      setActivityEntries(entries);
    } catch {
      setActivityEntries([]);
    } finally {
      setActivityLoading(false);
    }
  }, [backendUrl, appEnv, auth]);

  // --- IAP Android: Init connection and listeners ---
  useEffect(() => {
    if (Platform.OS !== "android") return;

    let purchaseSub: any;
    let errorSub: any;
    let mounted = true;

    (async () => {
      try {
        if (typeof initConnection !== "function") {
          console.warn("[IAP] Native module not available: initConnection is not a function. Are you running a build that includes react-native-iap?");
          setIapReady(false);
          return;
        }

        const ok = await initConnection();
        if (!mounted) return;
        setIapReady(!!ok);

        purchaseSub = purchaseUpdatedListener(async (purchase) => {
          try {
            // Guard against parallel callbacks
            if (purchaseInFlightRef.current) return;
            purchaseInFlightRef.current = true;

            const result = await verifyPurchaseWithBackend(purchase);
            if (!result.ok) {
              // Do NOT finishTransaction here, otherwise we could lose the ability to re-verify.
              Alert.alert(
                t("economy.purchase_pending_title"),
                result.message || t("economy.purchase_pending_body")
              );
              return;
            }

            // Backend verified + granted. Now acknowledge/finish the consumable.
            await finishTransaction({ purchase, isConsumable: true });

            // Refresh balance UI.
            await loadBalance();
          } catch (e: any) {
            console.warn("[IAP] purchaseUpdatedListener error", e);
            Alert.alert(t("economy.purchase_error_title"), t("economy.purchase_error_body"));
          } finally {
            purchaseInFlightRef.current = false;
          }
        });

        errorSub = purchaseErrorListener((err) => {
          console.warn("[IAP] purchaseError", err);
        });
      } catch (e) {
        console.warn("[IAP] initConnection failed", e);
        if (!mounted) return;
        setIapReady(false);
      }
    })();

    return () => {
      mounted = false;
      try {
        purchaseSub?.remove?.();
      } catch {}
      try {
        errorSub?.remove?.();
      } catch {}
      try {
        endConnection();
      } catch {}
    };
  }, [verifyPurchaseWithBackend, loadBalance]);

  // --- IAP Android: Refresh Play product cache when offers change ---
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!iapReady) return;
    if (!offerSkus || offerSkus.length === 0) return;
    // In some dev builds (or Expo Go / stale dev client), the native IAP module isn't present.
    // In that case, `fetchProducts` will be undefined. Don't spam warnings or break the store UI.
    if (typeof fetchProducts !== "function") {
      console.warn(
        "[IAP] fetchProducts is not available (native module missing). Rebuild your dev client after installing react-native-iap, or test with a Play-installed build."
      );
      setIapProducts({});
      return;
    }

    (async () => {
      try {
        let prods: any[] = [];
        try {
          // v14+ expects a product type; these are one-time (consumable) in-app products.
          prods = (await fetchProducts({ skus: offerSkus, type: "in-app" } as any)) ?? [];
        } catch (e1) {
          try {
            prods = (await fetchProducts({ skus: offerSkus, type: "in-app" } as any)) ?? [];
          } catch (e2) {
            // Older versions accept an array
            prods = await (fetchProducts as any)(offerSkus);
          }
        }
        const map: Record<string, Product> = {};
        for (const p of prods) {
          const sku = String((p as any)?.productId || (p as any)?.sku || "").trim();
          if (sku) map[sku] = p;
        }
        setIapProducts(map);
      } catch (e) {
        console.warn("[IAP] fetchProducts failed", e);
      }
    })();
  }, [iapReady, offerSkus]);

  const loadCatalog = useCallback(async () => {
    if (!backendUrl) {
      setOffers([]);
      return;
    }

    const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
    const deviceId = await getDeviceId().catch(() => null);
    const userId = auth.currentUser?.uid ?? null;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-app-env": appEnv,
    };
    if (idToken) headers.Authorization = `Bearer ${idToken}`;
    if (deviceId) headers["x-device-id"] = deviceId;
    if (userId) headers["x-user-id"] = userId;

    const res = await fetch(`${backendUrl}/economy/catalog`, { headers });

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      const msg = toString(data?.message) || toString(data?.error) || `Failed to load store (${res.status})`;
      throw new Error(msg);
    }

    const root = data?.data ?? data;
    const catalogCurrency =
      toString(root?.catalog?.currency) ||
      toString(root?.currency) ||
      "USD";

    const rawBonuses: any[] = pickFirstArray(
      root?.catalog?.bonuses,
      root?.bonuses,
      data?.catalog?.bonuses,
      data?.bonuses
    );

    const rawOffers: any[] = pickFirstArray(
      root?.catalog?.offers,
      root?.offers,
      data?.catalog?.offers,
      data?.offers
    );

    const nextOffers: Offer[] = rawOffers
      .map((o: any) => {
        const currency = toString(o?.currency) || catalogCurrency;
        const id = String(o?.id ?? o?.offerId ?? o?.productId ?? "").trim();
        const productId = toString(o?.productId) || undefined;
        const title = String(o?.title ?? o?.name ?? o?.label ?? "").trim();
        const subtitle = toString(o?.subtitle) || toString(o?.description) || undefined;
        const price = toNumber(o?.price, toNumber(o?.amount, 0));
        const cookies = Math.max(
          0,
          Math.floor(toNumber(o?.cookies, toNumber(o?.cookieAmount, toNumber(o?.qty, 0))))
        );
        const bonusCookies = Math.max(0, Math.floor(toNumber(o?.bonusCookies, 0)));
        const mostPurchased = typeof o?.mostPurchased === "boolean" ? o.mostPurchased : undefined;
        const badges = Array.isArray(o?.badges)
          ? o.badges.filter((b: any) => typeof b === "string")
          : undefined;
        const isPromo = typeof o?.isPromo === "boolean" ? o.isPromo : undefined;
        const sortOrder = typeof o?.sortOrder === "number" ? o.sortOrder : undefined;

        return {
          id,
          productId,
          title,
          subtitle,
          price,
          currency,
          cookies,
          bonusCookies,
          mostPurchased,
          badges,
          isPromo,
          sortOrder,
        } as Offer;
      })
      .filter((o) => !!o.id && !!o.title && o.cookies > 0)
      .sort((a, b) => {
        const sa = typeof a.sortOrder === "number" ? a.sortOrder : 9999;
        const sb = typeof b.sortOrder === "number" ? b.sortOrder : 9999;
        if (sa !== sb) return sa - sb;
        return a.cookies - b.cookies;
      });

    setOffers(nextOffers);

    const nextBonuses: BonusOffer[] = rawBonuses
      .map((b: any) => {
        const id = String(b?.id ?? b?.bonusId ?? "").trim();
        const title = String(b?.title ?? b?.name ?? "").trim();
        const subtitle = toString(b?.subtitle) || toString(b?.description) || undefined;
        const cookies = Math.max(0, Math.floor(toNumber(b?.cookies, toNumber(b?.amount, 0))));
        const status = toString(b?.status) as any;
        const action = toString(b?.action) || undefined;
        const reason = toString(b?.reason) || undefined;
        const badges = Array.isArray(b?.badges) ? b.badges.filter((x: any) => typeof x === "string") : undefined;
        return { id, title, subtitle, cookies, status, badges, action, reason } as BonusOffer;
      })
      .filter((b) => !!b.id && !!b.title && b.cookies > 0)
      .sort((a, b) => {
        // Stable, deterministic ordering (render layer will reposition redeemed bonuses to the bottom)
        if (a.cookies !== b.cookies) return a.cookies - b.cookies;
        return a.id.localeCompare(b.id);
      });

    setBonuses(nextBonuses);
  }, [backendUrl, appEnv, auth]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadCatalog(), loadBalance()]);
    } finally {
      setLoading(false);
    }
  }, [loadCatalog, loadBalance]);

  // Refresh balance when auth uid changes (e.g., user logs in after using app anonymously)
  useEffect(() => {
    loadBalance();
  }, [economyUid, loadBalance]);

  useFocusEffect(
    useCallback(() => {
      load();
      return undefined;
    }, [load])
  );

  const onPressSignup = () => {
    router.push("/auth/signup");
  };

  const renderBadges = (badges?: string[]) => {
    const arr = Array.isArray(badges) ? badges.filter(Boolean) : [];
    if (arr.length === 0) return null;

    // Badges look good on light mode already; only tweak in dark mode for contrast.
    const chipStyle = isDark
      ? { backgroundColor: "#FFFFFF1A", borderColor: "#FFFFFF2A", borderWidth: 1 }
      : undefined;

    const chipTextStyle = isDark
      ? { color: "#F5F5F5" }
      : undefined;

    return (
      <View style={styles.badgeRow}>
        {arr.map((b, idx) => (
          <View key={`${b}-${idx}`} style={[styles.badgeChip, chipStyle]}>
            <Text style={[styles.badgeChipText, chipTextStyle]}>{b}</Text>
          </View>
        ))}
      </View>
    );
  };

  const onBuy = async (offer: Offer) => {
    // Android-only
    if (Platform.OS !== "android") {
      Alert.alert(t("economy.not_available_title"), t("economy.not_available_body"));
      return;
    }

    const sku = String(offer.productId || offer.id || "").trim();
    if (!sku) {
      Alert.alert(t("economy.offer_missing_title"), t("economy.offer_missing_body"));
      return;
    }

    // Local/dev builds cannot reliably use Google Play Billing unless the app is installed from Play
    // (internal/closed testing or internal app sharing). Otherwise Billing returns "service unavailable".
    if (isLocalDev) {
      Alert.alert(
        t("economy.local_dev_purchase_title"),
        t("economy.local_dev_purchase_body")
      );
      return;
    }

    // Google Play Billing is not ready yet.
    if (!iapReady) {
      Alert.alert(t("economy.billing_not_ready_title"), t("economy.billing_not_ready_body"));
      return;
    }

    // If the native purchase function isn't available, we can't proceed.
    if (typeof requestPurchase !== "function") {
      Alert.alert(
        t("economy.billing_not_available_title"),
        t("economy.billing_not_available_body")
      );
      return;
    }

    // `getProducts` is used only to show localized pricing. Some builds can still purchase even if
    // product fetching isn't available (or fails). Don't hard-block the purchase flow.
    if (typeof fetchProducts !== "function") {
      console.warn(
        "[IAP] fetchProducts is not available in this build. Prices may be shown from backend fallback. Attempting purchase anyway."
      );
    }

    // If Play doesn't know this SKU yet, the purchase flow will usually fail.
    // On local/dev builds, `getProducts` may not run (native module missing) so we don't hard-block.
    if (!iapProducts[sku]) {
      console.warn(
        `[IAP] SKU '${sku}' not found in product cache. Attempting purchase anyway (this may fail if the product isn't active/available for this build).`
      );
    }

    // Must be logged in (or anonymous) so we have an idToken to let the backend grant cookies.
    if (!auth.currentUser) {
      Alert.alert(t("economy.login_required"), t("economy.sign_in_required_body"));
      return;
    }

    try {
      // Launch Google Play purchase flow.
      // react-native-iap v14.6+ (OpenIAP) expects a structured request.
      // Using the wrong shape produces: "Missing purchase request configuration".
      const fn: any = requestPurchase as any;

      try {
        // Preferred v14+ shape (OpenIAP): google/apple keys
        await fn({
          type: "in-app",
          request: {
            google: {
              skus: [sku],
            },
          },
        });
      } catch (err1: any) {
        // Some builds/docs also accept `android` instead of `google`.
        try {
          await fn({
            type: "in-app",
            request: {
              android: {
                skus: [sku],
              },
            },
          });
        } catch (err2) {
          // Last-resort legacy signature (older native module)
          // (kept to avoid breaking older installs)
          await fn({ sku });
        }
      }

      // The rest continues in purchaseUpdatedListener:
      // - backend verifies & grants
      // - finishTransaction after success
      // - refresh balance
    } catch (e: any) {
      console.warn("[IAP] requestPurchase failed", e);
      const msg =
        (e && typeof e === "object" && (e.message || (e as any).debugMessage))
          ? String(e.message || (e as any).debugMessage)
          : "Couldn't start the purchase. Please try again.";
      const code = e && typeof e === "object" && (e as any).code ? String((e as any).code) : "";
      const lowerMsg = msg.toLowerCase();
      const isMissingConfig =
        lowerMsg.includes("missing purchase request configuration") ||
        lowerMsg.includes("missing purchase request") ||
        lowerMsg.includes("invalid purchase request") ||
        lowerMsg.includes("invalid argument") ||
        lowerMsg.includes("must be a string") ||
        lowerMsg.includes("must be an object");

      const isBillingUnavailable =
        lowerMsg.includes("billing service is unavailable") ||
        lowerMsg.includes("service unavailable") ||
        lowerMsg.includes("service-error") ||
        lowerMsg.includes("billing is unavailable");

      Alert.alert(
        t("economy.purchase_failed_title"),
        isBillingUnavailable
          ? t("economy.purchase_failed_billing_unavailable")
          : isMissingConfig
            ? t("economy.purchase_failed_iap_mismatch")
            : (code ? t("economy.purchase_failed_with_code", { message: msg, code }) : msg)
      );
    }
  };

  useEffect(() => {
    if (params.autoBuy !== "1") return;
    if (autoBuyAttemptedRef.current) return;
    if (loading) return;
    const targetId = String(params.highlight || "").trim();
    if (!targetId) return;
    const offer = offers.find((item) => String(item.id).trim() === targetId);
    if (!offer) return;
    autoBuyAttemptedRef.current = true;
    void onBuy(offer);
  }, [loading, offers, onBuy, params.autoBuy, params.highlight]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: isDark ? bg : "#F5F5F5" }} edges={["top", "left", "right", "bottom"]}>
      <ScrollView
        style={{ flex: 1, backgroundColor: isDark ? bg : "#F5F5F5" }}
        contentContainerStyle={[styles.container, { paddingBottom: 28 }]}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" />
            <Text style={[styles.muted, { color: isDark ? "#ddd" : "#666", marginTop: 10 }]}>
              {t("common.loading", "Loading...")}
            </Text>
          </View>
        ) : (
          <>
            <Text style={[styles.sectionTitle, { color: isDark ? "#f5f5f5" : "#293a53" }]}>
              {t("economy.cookies_balance", "Balance")}
            </Text>
            <View style={[styles.balanceCard, { backgroundColor: card, borderColor: border }]}>
              <View style={styles.balanceValueRow}>
                <EggIcon size={24} />
                <Text style={[styles.balanceValue, { color: text }]}>{balance === null ? "—" : balance} Eggs</Text>
              </View>
            </View>
            {isLoggedIn && !isAnon ? (
              <View style={styles.activityLinkRow}>
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => {
                    setActivityVisible(true);
                    loadActivity();
                  }}
                >
                  <Text style={styles.activityLinkText}>
                    {t("economy.cookies_activity", { defaultValue: "Activity" })}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <Text style={[styles.sectionTitle, { color: isDark ? "#f5f5f5" : "#293a53" }]}>
              {t("economy.free_cookies", "Earn free")}
            </Text>

            {offers.length === 0 && bonuses.length === 0 ? (
              <Text style={[styles.muted, { color: isDark ? "#ddd" : "#666" }]}>
                {t("economy.no_offers", "No offers available right now.")}
              </Text>
            ) : (
              <>
                {availableBonuses.length === 0 ? (
                  <View style={[styles.emptyState, { backgroundColor: card, borderColor: border }]}>
                    <Text style={[styles.emptyStateTitle, { color: text }]}>
                      {t(
                        "economy.no_available_rewards_title",
                        "You’ve claimed all available free Egg rewards for now."
                      )}
                    </Text>
                    <Text style={[styles.emptyStateBody, { color: isDark ? "#ddd" : "#666" }]}>
                      {t(
                        "economy.no_available_rewards_body",
                        "We may add new rewards from time to time, so keep an eye on this space."
                      )}
                    </Text>
                  </View>
                ) : null}

                {availableBonuses
                  .filter((b) => b.status !== "redeemed")
                  .map((b) => {
                    const redeemed = b.status === "redeemed";
                    const locked = b.status === "locked";
                    const ctaLabel = redeemed
                      ? t("economy.redeemed", "Redeemed")
                      : locked
                        ? t("economy.login_required", "Sign in required")
                        : b.action === "create_account"
                          ? t("economy.signup", "Sign up")
                          : t("economy.open", "Open");

                    const ctaDisabled = redeemed || locked;

                    return (
                      <View key={b.id} style={[styles.offerCard, { backgroundColor: card, borderColor: border }]}>
                        <View style={styles.offerLeft}>
                          <View style={styles.offerMainRow}>
                            <MaterialIcons name="card-giftcard" size={22} color="#E27D60" style={styles.cookieImageIcon} />
                            <Text style={[styles.offerMainTitle, { color: text }]}>
                              +{b.cookies} {t("economy.cookies", "Eggs")}
                            </Text>
                            <View style={[styles.freeChip, isDark ? styles.freeChipDark : null]}>
                              <Text style={[styles.freeChipText, isDark ? styles.freeChipTextDark : null]}>
                                {t("economy.free", "Free")}
                              </Text>
                            </View>
                          </View>

                          {/* For bonus offers, hide the title and show only the description */}
                          {!!b.subtitle && (
                            <Text style={[styles.offerSubtitle, { color: isDark ? "#ddd" : "#666" }]}>
                              {renderRewardSubtitle(b, text, t)}
                            </Text>
                          )}

                        </View>

                        <View style={styles.offerRight}>
                          <TouchableOpacity
                            style={[styles.buyBtn, { opacity: ctaDisabled ? 0.55 : 1 }]}
                            disabled={ctaDisabled}
                            onPress={() => {
                              if (!ctaDisabled) {
                                if (b.action === "create_account") {
                                  onPressSignup();
                                } else {
                                  openBonusAction(b);
                                }
                              }
                            }}
                            activeOpacity={0.8}
                          >
                            <Text style={styles.buyBtnText}>{ctaLabel}</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })}

                <Text style={[styles.sectionTitle, { color: isDark ? "#f5f5f5" : "#293a53", marginTop: 8 }]}>
                  {t("economy.cookie_plans", "Plans")}
                </Text>

                {offers.map((o) => {
                  const isHighlighted = params.highlight === o.id;
                  const bonus = o.bonusCookies || 0;

                  // Prefer parsing the base from the title (e.g. "15 Eggs") to keep UI consistent,
                  // and to avoid double-counting when `o.cookies` already includes the bonus.
                  const parsedBase = parseCookiesFromTitle(o.title);

                  const inferredBase =
                    typeof parsedBase === "number" && parsedBase > 0
                      ? parsedBase
                      : bonus > 0 && o.cookies > bonus
                        ? o.cookies - bonus
                        : o.cookies;

                  const baseCookies = Math.max(0, Math.floor(inferredBase));
                  const totalCookies = baseCookies + bonus;

                  const showPromo = (o.isPromo || bonus > 0) && baseCookies > 0;

                  return (
                    <View
                      key={o.id}
                      style={[
                        styles.offerCard,
                        {
                          backgroundColor: card,
                          borderColor: isHighlighted ? "#E27D60" : border,
                          borderWidth: isHighlighted ? 2 : 1,
                        },
                      ]}
                    >
                      <View style={styles.offerLeft}>
                        {/* Top row: icon + title/promo on the left, and "Most purchased" chip on the right */}
                        <View style={styles.offerTopRow}>
                          <View style={styles.offerTopLeft}>
                            <EggIcon size={22} style={styles.cookieImageIcon} />

                            {showPromo ? (
                              <View style={styles.promoTitleRow}>
                                <Text style={[styles.offerBaseCookies, { color: isDark ? "#bbb" : "#7a7a7a" }]}>
                                  {baseCookies} {t("economy.cookies", "Eggs")}
                                </Text>
                                <Text style={[styles.promoArrow, { color: isDark ? "#bbb" : "#7a7a7a" }]}>→</Text>
                                <Text style={[styles.offerPromoCookies, { color: text }]}>
                                  {totalCookies} {t("economy.cookies", "Eggs")}
                                </Text>
                              </View>
                            ) : (
                              <Text style={[styles.offerMainTitle, { color: text }]}>
                                {Math.max(0, Math.floor(o.cookies))} {t("economy.cookies", "Eggs")}
                              </Text>
                            )}
                          </View>

                          {o.mostPurchased ? (
                            <View style={styles.highlightChip}>
                              <Text style={styles.highlightChipText}>{t("economy.most_purchased", "Most purchased")}</Text>
                            </View>
                          ) : null}
                        </View>

                        {/* Second row: subtitle and price on the same line */}
                        <Text style={[styles.offerPriceLine, { color: isDark ? "#ddd" : "#666" }]}>
                          {(() => {
                            const sku = String(o.productId || o.id || "").trim();
                            const nativePrice = sku && iapProducts[sku] ? (iapProducts[sku] as any)?.localizedPrice : null;
                            const priceText = typeof nativePrice === "string" && nativePrice.trim() ? nativePrice : formatPrice(o.price, o.currency);
                            return o.subtitle ? `${o.subtitle} | ${priceText}` : priceText;
                          })()}
                        </Text>

                        {/* Badges belong with the details (left), not next to the Buy button */}
                        {renderBadges(o.badges)}
                      </View>

                      <View style={styles.offerRight}>
                        <TouchableOpacity
                          style={[styles.buyBtn, { opacity: 1 }]}
                          onPress={() => onBuy(o)}
                          activeOpacity={0.8}
                        >
                          <Text style={styles.buyBtnText}>{t("economy.buy", "Buy")}</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}

                {redeemedBonuses.length > 0 ? (
                  <Text style={[styles.sectionTitle, { color: isDark ? "#f5f5f5" : "#293a53", marginTop: 8 }]}>
                    {t("economy.completed_rewards", "Completed rewards")}
                  </Text>
                ) : null}

                {redeemedBonuses.map((b) => {
                    const ctaLabel = t("economy.redeemed", "Redeemed");
                    const ctaDisabled = true;

                    return (
                      <View key={b.id} style={[styles.offerCard, { backgroundColor: card, borderColor: border }]}>
                        <View style={styles.offerLeft}>
                          <View style={styles.offerMainRow}>
                            <MaterialIcons name="card-giftcard" size={22} color="#E27D60" style={styles.cookieImageIcon} />
                            <Text style={[styles.offerMainTitle, { color: text }]}>
                              +{b.cookies} {t("economy.cookies", "Eggs")}
                            </Text>
                            <View style={[styles.freeChip, isDark ? styles.freeChipDark : null]}>
                              <Text style={[styles.freeChipText, isDark ? styles.freeChipTextDark : null]}>
                                {t("economy.free", "Free")}
                              </Text>
                            </View>
                          </View>

                          {!!b.subtitle && (
                            <Text style={[styles.offerSubtitle, { color: isDark ? "#ddd" : "#666" }]}>
                              {renderRewardSubtitle(b, text, t)}
                            </Text>
                          )}

                        </View>

                        <View style={styles.offerRight}>
                          <TouchableOpacity
                            style={[styles.buyBtn, { opacity: ctaDisabled ? 0.55 : 1 }]}
                            disabled={ctaDisabled}
                            onPress={() => {}}
                            activeOpacity={0.8}
                          >
                            <Text style={styles.buyBtnText}>{ctaLabel}</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })}
              </>
            )}

            <Text style={[styles.footnote, { color: isDark ? "#ddd" : "#666" }]}>
              {isLoggedIn
                  ? t(
                    "economy.cookies_what_body_logged_in_v2",
                    "Eggs are used for premium AI features after your free premium actions are used up. You can buy more at any time, and you can also earn free Eggs by completing key milestones in the app."
                  )
                  : t(
                    "economy.cookies_what_body_logged_out_v2",
                    "Eggs are used for premium AI features after your free premium actions are used up. Create an account and sign in to unlock your account bonus, and you can also earn free Eggs by completing key milestones in the app."
                  )}
            </Text>
          </>
        )}
      </ScrollView>
      <EconomyActivityModal
        visible={activityVisible}
        isDark={isDark}
        card={card}
        border={border}
        text={text}
        subText={isDark ? "#ddd" : "#666"}
        backdrop={isDark ? "rgba(0,0,0,0.56)" : "rgba(0,0,0,0.28)"}
        title={t("economy.cookies_history_title", { defaultValue: "Egg activity" })}
        loadingText={t("economy.loading_history", { defaultValue: "Loading history..." })}
        emptyText={t("economy.history_empty", { defaultValue: "No Egg activity yet." })}
        balanceAfterLabel={String(t("economy.balance_after_short", {
          count: "{{count}}",
          defaultValue: "Balance {{count}}",
        } as any))}
        locale={i18n.language}
        entries={activityEntries}
        loading={activityLoading}
        onClose={() => setActivityVisible(false)}
        t={t as any}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screenTitle: { fontSize: 28, fontWeight: "900", marginBottom: 12 },
  container: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  balanceCard: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 16 },
  activityLinkRow: {
    marginTop: -6,
    marginBottom: 10,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  activityLinkText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#E27D60",
  },
  emptyState: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  emptyStateTitle: { fontSize: 15, fontWeight: "800", marginBottom: 6 },
  emptyStateBody: { fontSize: 14, lineHeight: 20 },
  balanceLabel: { fontSize: 14, opacity: 0.8 },
  balanceValueRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  balanceValue: { fontSize: 19, fontWeight: "800"},
  sectionTitle: { fontSize: 17, fontWeight: "800", marginBottom: 10, marginTop: 6 },
  offerCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  offerMainRow: { flexDirection: "row", alignItems: "center" },
  cookieImageIcon: { marginRight: 8 },
  offerMainTitle: { fontSize: 18, fontWeight: "900" },
  promoTitleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  offerBaseCookies: { fontSize: 16, fontWeight: "900", textDecorationLine: "line-through" },
  promoArrow: { fontSize: 14, fontWeight: "900", marginHorizontal: 2 },
  offerPromoCookies: { fontSize: 18, fontWeight: "900" },
  offerPriceLine: { fontSize: 16, marginTop: 8,fontWeight: "600", marginBottom: 4},
  offerBonusLine: { fontSize: 14, marginTop: 6 },
  offerSubtitle: { fontSize: 14, marginTop: 6 },
  offerSubtitleStrong: { fontWeight: "900" },
  muted: { fontSize: 14 },
  buyBtn: { backgroundColor: "#E27D60", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, marginLeft: 12 },
  buyBtnText: { color: "#fff", fontWeight: "800" },
  offerRight: { justifyContent: "center", alignItems: "flex-end", gap: 8 },
  offerLeft: { flex: 1, paddingRight: 12 },
  footnote: { fontSize: 12, marginTop: 10, opacity: 0.85 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  badgeChip: { backgroundColor: "#00000010", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeChipText: { fontSize: 13, fontWeight: "800" },
  freeChip: {
    marginLeft: 10,
    backgroundColor: "#00000010",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  freeChipText: {
    fontSize: 13,
    fontWeight: "900",
    color: "#293a53",
  },
  freeChipDark: {
    backgroundColor: "#ffbd80aa",
    borderColor: "#ffbd80",
    borderWidth: 1,
  },
  freeChipTextDark: {
    color: "#293a53",
  },
  highlightChip: {
    backgroundColor: "#ffbd80aa",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  highlightChipText: { fontSize: 13, fontWeight: "900", color: "#293a53" },

  offerTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  offerTopLeft: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
  },
});
