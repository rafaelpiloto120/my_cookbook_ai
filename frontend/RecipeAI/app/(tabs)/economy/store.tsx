import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Alert, Platform, ScrollView, Animated, Easing } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import { useThemeColors } from "../../../context/ThemeContext";
import { getApiBaseUrl } from "../../../lib/config/api";
import { useTranslation } from "react-i18next";
import { getAuth } from "firebase/auth";
import { getDeviceId } from "../../../utils/deviceId";
import AsyncStorage from "@react-native-async-storage/async-storage";
import EconomyActivityModal from "../../../components/EconomyActivityModal";
import EggIcon from "../../../components/EggIcon";
import { claimEconomyReward, fetchEconomyHistory, type EconomyLedgerEntry } from "../../../lib/economy/client";
import { emitClaimableRewardsChanged } from "../../../lib/economy/claimableRewardsEvents";
import { formatEconomyUnits } from "../../../lib/economy/format";
import { trackActivityEventBestEffort } from "../../../lib/activity/client";
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
  rewardKey?: string;
  title: string;
  subtitle?: string;
  cookies: number;
  status?: "available" | "redeemed" | "locked" | "hidden";
  badges?: string[];
  action?: string;
  reason?: string;
  progress?: number | null;
  target?: number | null;
};

type MissionReward = {
  id: string;
  rewardKey?: string;
  title: string;
  description?: string;
  cookies: number;
  status?: "available" | "redeemed" | "locked" | "hidden";
  reason?: string;
  action?: string | null;
  progress: number;
  target: number;
};

type MissionBoard = {
  unlocked: boolean;
  reason?: string;
  freePremiumActionsRemaining?: number | null;
  cycleStart?: number | null;
  cycleEnd?: number | null;
  dayOfCycle?: number | null;
  actionsCompleted: number;
  actionsTarget: number;
  rewards: MissionReward[];
};

const toNumber = (v: any, fallback = 0) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};
const isProgressComplete = (progress?: number | null, target?: number | null) => {
  if (typeof target !== "number" || !Number.isFinite(target)) return true;
  if (typeof progress !== "number" || !Number.isFinite(progress)) return false;
  return progress >= Math.max(1, Math.floor(target));
};
const toString = (v: any, fallback = "") => (typeof v === "string" ? v : fallback);
const pickFirstArray = (...candidates: any[]): any[] => {
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
};

const formatPrice = (price: number, currency: string) => {
  const p = Math.round(price * 100) / 100;
  const cur = (currency || "").toUpperCase();

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cur || "USD",
      currencyDisplay: "narrowSymbol",
    }).format(p);
  } catch {
    const symbols: Record<string, string> = {
      AUD: "A$",
      BRL: "R$",
      CAD: "C$",
      CHF: "CHF",
      EUR: "€",
      GBP: "£",
      JPY: "¥",
      MXN: "MX$",
      NZD: "NZ$",
      USD: "$",
    };
    const symbol = symbols[cur] || cur || "";
    return symbol ? `${symbol}${p.toFixed(2)}` : p.toFixed(2);
  }
};

const parseCookiesFromTitle = (title: string): number | null => {
  // Examples: "15 Eggs", "50 Eggs" -> 15/50
  const m = String(title || "").match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
};

const rewardCopyById: Record<string, { titleKey: string; defaultTitle: string }> = {
  signup_bonus_v1: {
    titleKey: "economy.reward_signup_bonus_title",
    defaultTitle: "Create an account",
  },
  profile_health_goals_v1: {
    titleKey: "economy.reward_profile_health_goals_title",
    defaultTitle: "Complete Health & Goals",
  },
  first_recipe_saved_v1: {
    titleKey: "economy.reward_first_recipe_title",
    defaultTitle: "Save your first recipe",
  },
  recipes_10_v1: {
    titleKey: "economy.reward_recipes_10_title",
    defaultTitle: "Save 10 recipes",
  },
  recipes_25_v1: {
    titleKey: "economy.reward_recipes_25_title",
    defaultTitle: "Save 25 recipes",
  },
  first_meal_logged_v1: {
    titleKey: "economy.reward_first_meal_title",
    defaultTitle: "Log your first meal",
  },
  meals_10_v1: {
    titleKey: "economy.reward_meals_10_title",
    defaultTitle: "Log 10 meals",
  },
  meals_25_v1: {
    titleKey: "economy.reward_meals_25_title",
    defaultTitle: "Log 25 meals",
  },
  first_cookbook_created_v1: {
    titleKey: "economy.reward_first_cookbook_title",
    defaultTitle: "Create your first cookbook",
  },
  first_instagram_reel_import_v1: {
    titleKey: "economy.reward_first_instagram_title",
    defaultTitle: "Import your first Reel recipe",
  },
};

const getRewardActionTitle = (bonus: BonusOffer, t: (key: string, options?: any) => string) => {
  const copy = rewardCopyById[bonus.id];
  return copy ? t(copy.titleKey, { defaultValue: copy.defaultTitle }) : bonus.title;
};

const missionCopyKeyByRewardKey: Record<string, { titleKey: string; descriptionKey: string }> = {
  mission_meals_3_days_v1: {
    titleKey: "economy.mission_meals_3_days_title",
    descriptionKey: "economy.mission_meals_3_days_description",
  },
  mission_weight_once_v1: {
    titleKey: "economy.mission_weight_once_title",
    descriptionKey: "economy.mission_weight_once_description",
  },
  mission_add_recipe_v1: {
    titleKey: "economy.mission_add_recipe_title",
    descriptionKey: "economy.mission_add_recipe_description",
  },
  mission_ai_kitchen_full_recipe_v1: {
    titleKey: "economy.mission_ai_kitchen_full_recipe_title",
    descriptionKey: "economy.mission_ai_kitchen_full_recipe_description",
  },
  mission_ai_kitchen_suggestions_v1: {
    titleKey: "economy.mission_ai_kitchen_full_recipe_title",
    descriptionKey: "economy.mission_ai_kitchen_full_recipe_description",
  },
  mission_complete_3_actions_v1: {
    titleKey: "economy.mission_complete_3_actions_title",
    descriptionKey: "economy.mission_complete_3_actions_description",
  },
  mission_complete_all_actions_v1: {
    titleKey: "economy.mission_complete_all_actions_title",
    descriptionKey: "economy.mission_complete_all_actions_description",
  },
};

const getMissionTitle = (reward: MissionReward, t: (key: string, options?: any) => string) => {
  const keys = missionCopyKeyByRewardKey[reward.rewardKey || reward.id];
  return keys ? t(keys.titleKey, { defaultValue: reward.title }) : reward.title;
};

export default function EconomyStoreScreen() {
  const { t, i18n } = useTranslation();
  const {
    bg,
    text,
    card,
    border,
    cta,
    isDark,
    mutedText,
    softText,
    accentText,
    success,
    softAccentBg,
    softAccentBorder,
    sectionTitle,
    onCta,
    headerBg,
    headerText,
  } = useThemeColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ highlight?: string; autoBuy?: string; focusClaim?: string }>();
  const scrollRef = useRef<ScrollView | null>(null);
  const lastFocusClaimTokenRef = useRef<string | null>(null);
  const rewardPositionsRef = useRef<Record<string, number>>({});
  const balanceAnimRef = useRef(new Animated.Value(0));
  const floatAnimRef = useRef(new Animated.Value(0));
  const highlightAnimRef = useRef(new Animated.Value(0));

  const backendUrl = getApiBaseUrl()!;
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  const isLocalDev = __DEV__;

  // ✅ auth.currentUser isn't reactive; track uid in state so balance refreshes on login/logout.
  const auth = getAuth();

  const trackPurchaseActivity = useCallback(
    (
      action: "purchase_started" | "purchase_granted" | "purchase_failed",
      productId: string | null,
      status: "started" | "succeeded" | "failed",
      metadata: Record<string, unknown> = {}
    ) => {
      trackActivityEventBestEffort({
        auth,
        backendUrl,
        appEnv,
        type: "purchase",
        action,
        source: "google_play",
        status,
        objectId: productId,
        metadata: {
          platform: Platform.OS,
          productId,
          ...metadata,
        },
      });
    },
    [appEnv, auth, backendUrl]
  );
  const [economyUid, setEconomyUid] = useState<string | null>(auth.currentUser?.uid ?? null);

  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState<number | null>(null);
  const [displayBalance, setDisplayBalance] = useState<number | null>(null);
  const [balanceAnimationPending, setBalanceAnimationPending] = useState(false);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [bonuses, setBonuses] = useState<BonusOffer[]>([]);
  const [missions, setMissions] = useState<MissionBoard | null>(null);
  const [claimingMissionKey, setClaimingMissionKey] = useState<string | null>(null);
  const [claimingBonusKey, setClaimingBonusKey] = useState<string | null>(null);
  const [floatingReward, setFloatingReward] = useState<{ amount: number; key: number } | null>(null);
  const [highlightedRewardKey, setHighlightedRewardKey] = useState<string | null>(null);
  const [activityVisible, setActivityVisible] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityEntries, setActivityEntries] = useState<EconomyLedgerEntry[]>([]);

  const availableBonuses = useMemo(
    () => bonuses.filter((b) => b.status !== "redeemed" && b.status !== "hidden"),
    [bonuses]
  );
  const firstClaimableRewardKey = useMemo(() => {
    const missionReward = missions?.rewards?.find(
      (item) => item.status === "available" && isProgressComplete(item.progress, item.target)
    );
    if (missionReward) return missionReward.rewardKey || missionReward.id;
    const milestoneReward = availableBonuses.find(
      (item) =>
        item.status === "available" &&
        isProgressComplete(item.progress, item.target) &&
        (item.rewardKey || item.id) !== "signup_bonus_v1"
    );
    return milestoneReward ? milestoneReward.rewardKey || milestoneReward.id : null;
  }, [availableBonuses, missions]);
  const inlineAccentColor = accentText;
  const positiveDeltaColor = success;
  const softAccentChip = isDark
    ? {
        backgroundColor: softAccentBg,
        borderColor: softAccentBorder,
        borderWidth: 1,
      }
    : null;
  const softAccentChipText = { color: inlineAccentColor };

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

  const openMissionAction = useCallback((action?: string | null) => {
    switch (action) {
      case "open_my_day":
        router.push({ pathname: "/my-day", params: { openAddMeal: "1" } } as any);
        return;
      case "open_my_day_weight":
        router.push({ pathname: "/my-day", params: { openLogWeight: "1", notificationNonce: String(Date.now()) } } as any);
        return;
      case "open_recipe_picker":
        router.push({ pathname: "/history", params: { openNewRecipe: "1" } } as any);
        return;
      case "open_ai_kitchen":
        router.push("/" as any);
        return;
      case "open_my_day_health_goals":
        router.push({ pathname: "/my-day", params: { openHealthGoals: "1" } } as any);
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
            const productId = (purchase as any)?.productId || (purchase as any)?.sku || null;
            if (!result.ok) {
              trackPurchaseActivity("purchase_failed", productId, "failed", {
                reason: "backend_verification_failed",
                message: result.message ?? null,
              });
              // Do NOT finishTransaction here, otherwise we could lose the ability to re-verify.
              Alert.alert(
                t("economy.purchase_pending_title"),
                result.message || t("economy.purchase_pending_body")
              );
              return;
            }

            // Backend verified + granted. Now acknowledge/finish the consumable.
            await finishTransaction({ purchase, isConsumable: true });
            trackPurchaseActivity("purchase_granted", productId, "succeeded", {
              balance: result.balance ?? null,
            });

            // Refresh balance UI.
            await loadBalance();
          } catch (e: any) {
            console.warn("[IAP] purchaseUpdatedListener error", e);
            trackPurchaseActivity("purchase_failed", null, "failed", {
              reason: "purchase_update_error",
              message: e?.message ? String(e.message) : null,
            });
            Alert.alert(t("economy.purchase_error_title"), t("economy.purchase_error_body"));
          } finally {
            purchaseInFlightRef.current = false;
          }
        });

        errorSub = purchaseErrorListener((err) => {
          console.warn("[IAP] purchaseError", err);
          trackPurchaseActivity("purchase_failed", null, "failed", {
            reason: "purchase_error_listener",
            message: (err as any)?.message ? String((err as any).message) : null,
            code: (err as any)?.code ? String((err as any).code) : null,
          });
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
  }, [verifyPurchaseWithBackend, loadBalance, trackPurchaseActivity]);

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
    const rawMissions = root?.catalog?.missions || root?.missions || data?.catalog?.missions || data?.missions || null;

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
        const rewardKey = String(b?.rewardKey ?? id).trim();
        const title = String(b?.title ?? b?.name ?? "").trim();
        const subtitle = toString(b?.subtitle) || toString(b?.description) || undefined;
        const cookies = Math.max(0, Math.floor(toNumber(b?.cookies, toNumber(b?.amount, 0))));
        const status = toString(b?.status) as any;
        const action = toString(b?.action) || undefined;
        const reason = toString(b?.reason) || undefined;
        const progress = typeof b?.progress === "number" && Number.isFinite(b.progress) ? Math.max(0, Math.floor(b.progress)) : null;
        const target = typeof b?.target === "number" && Number.isFinite(b.target) ? Math.max(1, Math.floor(b.target)) : null;
        const badges = Array.isArray(b?.badges) ? b.badges.filter((x: any) => typeof x === "string") : undefined;
        return { id, rewardKey, title, subtitle, cookies, status, badges, action, reason, progress, target } as BonusOffer;
      })
      .filter((b) => !!b.id && !!b.title && b.cookies > 0)
      .sort((a, b) => {
        // Stable, deterministic ordering (render layer will reposition redeemed bonuses to the bottom)
        if (a.cookies !== b.cookies) return a.cookies - b.cookies;
        return a.id.localeCompare(b.id);
      });

    setBonuses(nextBonuses);

    const missionRewards: MissionReward[] = Array.isArray(rawMissions?.rewards)
      ? rawMissions.rewards
          .map((reward: any) => {
            const id = String(reward?.id ?? reward?.rewardKey ?? "").trim();
            const title = String(reward?.title ?? "").trim();
            const description = toString(reward?.description) || undefined;
            const cookies = Math.max(0, Math.floor(toNumber(reward?.cookies, toNumber(reward?.amount, 0))));
            const progress = Math.max(0, Math.floor(toNumber(reward?.progress, 0)));
            const target = Math.max(1, Math.floor(toNumber(reward?.target, 1)));
            return {
              id,
              rewardKey: toString(reward?.rewardKey) || id,
              title,
              description,
              cookies,
              status: toString(reward?.status) as any,
              reason: toString(reward?.reason) || undefined,
              action: toString(reward?.action) || undefined,
              progress,
              target,
            } as MissionReward;
          })
          .filter((reward: MissionReward) => !!reward.id && !!reward.title && reward.cookies > 0)
      : [];

    setMissions({
      unlocked: rawMissions?.unlocked === true,
      reason: toString(rawMissions?.reason) || undefined,
      freePremiumActionsRemaining: toNumber(rawMissions?.freePremiumActionsRemaining, 0),
      cycleStart: toNumber(rawMissions?.cycleStart, 0) || null,
      cycleEnd: toNumber(rawMissions?.cycleEnd, 0) || null,
      dayOfCycle: toNumber(rawMissions?.dayOfCycle, 0) || null,
      actionsCompleted: Math.max(0, Math.floor(toNumber(rawMissions?.actionsCompleted, 0))),
      actionsTarget: Math.max(1, Math.floor(toNumber(rawMissions?.actionsTarget, 4))),
      rewards: missionRewards,
    });
  }, [backendUrl, appEnv, auth]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadCatalog(), loadBalance()]);
    } finally {
      setLoading(false);
    }
  }, [loadCatalog, loadBalance]);

  useEffect(() => {
    if (balance === null) {
      setDisplayBalance(null);
      return;
    }
    if (!claimingMissionKey && !claimingBonusKey && !balanceAnimationPending) {
      setDisplayBalance(balance);
    }
  }, [balance, balanceAnimationPending, claimingBonusKey, claimingMissionKey]);

  const animateBalanceChange = useCallback((from: number, to: number, onDone?: () => void) => {
    balanceAnimRef.current.stopAnimation();
    balanceAnimRef.current.removeAllListeners();
    balanceAnimRef.current.setValue(from);
    const listenerId = balanceAnimRef.current.addListener(({ value }) => {
      setDisplayBalance(Math.round(value));
    });

    Animated.timing(balanceAnimRef.current, {
      toValue: to,
      duration: 650,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(() => {
      balanceAnimRef.current.removeListener(listenerId);
      setDisplayBalance(to);
      onDone?.();
    });
  }, []);

  const pulseRewardHighlight = useCallback((rewardKey: string, duration = 1200) => {
    setHighlightedRewardKey(rewardKey);
    highlightAnimRef.current.stopAnimation();
    highlightAnimRef.current.setValue(0);
    Animated.sequence([
      Animated.timing(highlightAnimRef.current, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.delay(duration),
      Animated.timing(highlightAnimRef.current, {
        toValue: 0,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
    ]).start(() => {
      setHighlightedRewardKey((current) => (current === rewardKey ? null : current));
    });
  }, []);

  const playClaimFeedback = useCallback((amount: number, rewardKey: string, previousBalance?: number | null, nextBalance?: number | null) => {
    const shouldAnimateBalance =
      typeof previousBalance === "number" &&
      Number.isFinite(previousBalance) &&
      typeof nextBalance === "number" &&
      Number.isFinite(nextBalance) &&
      nextBalance !== previousBalance;
    if (shouldAnimateBalance) {
      setBalanceAnimationPending(true);
      setDisplayBalance(previousBalance);
    }
    scrollRef.current?.scrollTo({ y: 0, animated: true });
    pulseRewardHighlight(rewardKey, 850);
    floatAnimRef.current.stopAnimation();
    floatAnimRef.current.setValue(0);
    setTimeout(() => {
      if (shouldAnimateBalance) {
        animateBalanceChange(previousBalance, nextBalance, () => {
          setBalanceAnimationPending(false);
        });
      }
      setFloatingReward({ amount, key: Date.now() });
      Animated.timing(floatAnimRef.current, {
        toValue: 1,
        duration: 900,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        setFloatingReward(null);
      });
    }, 420);
  }, [animateBalanceChange, pulseRewardHighlight]);

  const claimMissionReward = useCallback(async (reward: MissionReward) => {
    const rewardKey = reward.rewardKey || reward.id;
    if (!backendUrl || !rewardKey || claimingMissionKey || !isProgressComplete(reward.progress, reward.target)) return;
    const previousBalance = typeof balance === "number" ? balance : null;
    setClaimingMissionKey(rewardKey);
    try {
      const result = await claimEconomyReward({
        backendUrl,
        appEnv,
        auth,
        rewardKey,
      });
      if (typeof result?.cookies === "number") {
        setBalance(result.cookies);
        if (previousBalance !== null && result.cookies !== previousBalance) {
          playClaimFeedback(Math.max(1, result.cookies - previousBalance), rewardKey, previousBalance, result.cookies);
        } else {
          playClaimFeedback(reward.cookies, rewardKey);
        }
      }
      await Promise.all([loadCatalog(), loadBalance()]);
      emitClaimableRewardsChanged();
    } catch (err) {
      console.warn("[EconomyStore] mission claim failed", err);
      Alert.alert(
        t("common.error", { defaultValue: "Error" }),
        t("economy.reward_claim_failed", { defaultValue: "We couldn't claim this reward right now." })
      );
    } finally {
      setClaimingMissionKey(null);
    }
  }, [appEnv, auth, backendUrl, balance, claimingMissionKey, loadBalance, loadCatalog, playClaimFeedback, t]);

  const claimBonusReward = useCallback(async (bonus: BonusOffer) => {
    const rewardKey = bonus.rewardKey || bonus.id;
    if (!backendUrl || !rewardKey || claimingBonusKey || !isProgressComplete(bonus.progress, bonus.target)) return;
    const previousBalance = typeof balance === "number" ? balance : null;
    setClaimingBonusKey(rewardKey);
    try {
      const result = await claimEconomyReward({
        backendUrl,
        appEnv,
        auth,
        rewardKey,
      });
      if (typeof result?.cookies === "number") {
        setBalance(result.cookies);
        if (previousBalance !== null && result.cookies !== previousBalance) {
          playClaimFeedback(Math.max(1, result.cookies - previousBalance), rewardKey, previousBalance, result.cookies);
        } else {
          playClaimFeedback(bonus.cookies, rewardKey);
        }
      }
      await Promise.all([loadCatalog(), loadBalance()]);
      emitClaimableRewardsChanged();
    } catch (err) {
      console.warn("[EconomyStore] bonus claim failed", err);
      Alert.alert(
        t("common.error", { defaultValue: "Error" }),
        t("economy.reward_claim_failed", { defaultValue: "We couldn't claim this reward right now." })
      );
    } finally {
      setClaimingBonusKey(null);
    }
  }, [appEnv, auth, backendUrl, balance, claimingBonusKey, loadBalance, loadCatalog, playClaimFeedback, t]);

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

  useEffect(() => {
    const focusToken = Array.isArray(params.focusClaim)
      ? params.focusClaim[0] || ""
      : typeof params.focusClaim === "string"
        ? params.focusClaim
        : "";
    if (loading || !focusToken || lastFocusClaimTokenRef.current === focusToken || !firstClaimableRewardKey) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const scrollToClaimableReward = (attempt: number) => {
      const y = rewardPositionsRef.current[firstClaimableRewardKey];
      if (typeof y !== "number" && attempt < 4) {
        timers.push(setTimeout(() => scrollToClaimableReward(attempt + 1), 180));
        return;
      }
      scrollRef.current?.scrollTo({
        y: typeof y === "number" ? Math.max(0, y - 110) : 190,
        animated: true,
      });
      lastFocusClaimTokenRef.current = focusToken;
      pulseRewardHighlight(firstClaimableRewardKey, 1500);
    };

    timers.push(setTimeout(() => scrollToClaimableReward(0), 350));
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [firstClaimableRewardKey, loading, params.focusClaim, pulseRewardHighlight]);

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
      ? { color: text }
      : undefined;

    return (
      <View style={styles.badgeRow}>
        {arr.map((b, idx) => (
          <View key={`${b}-${idx}`} style={[styles.badgeChip, chipStyle]}>
            <Text numberOfLines={1} style={[styles.badgeChipText, chipTextStyle]}>{b}</Text>
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
      trackPurchaseActivity("purchase_started", sku, "started");
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
      trackPurchaseActivity("purchase_failed", sku, "failed", {
        reason: "request_purchase_failed",
        message: msg,
        code: code || null,
      });
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
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={["left", "right", "bottom"]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t("economy.manage_cookies_title", { defaultValue: "Manage Eggs" }),
          headerStyle: { backgroundColor: headerBg },
          headerTintColor: headerText,
          headerTitleAlign: "center",
          headerLeft: () => (
            <TouchableOpacity activeOpacity={0.8} onPress={() => router.replace("/profile")} style={styles.backButton}>
              <MaterialIcons name="arrow-back" size={26} color={headerText} />
            </TouchableOpacity>
          ),
        }}
      />
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, backgroundColor: bg }}
        contentContainerStyle={[styles.container, { paddingBottom: 28 }]}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={inlineAccentColor} />
            <Text style={[styles.muted, { color: mutedText, marginTop: 10 }]}>
              {t("common.loading", "Loading...")}
            </Text>
          </View>
        ) : (
          <>
            <View style={[styles.balanceHero, { borderBottomColor: border }]}>
              <View style={styles.balanceHeroMain}>
                <EggIcon size={44} />
                <View style={styles.balanceHeroCopy}>
                  <Text style={[styles.balanceLabel, { color: mutedText }]}>
                    {t("economy.cookies_balance", "Balance")}
                  </Text>
                  <View style={styles.balanceValueWrap}>
                    <Text style={[styles.balanceValue, { color: text }]}>
                      {balance === null ? "—" : formatEconomyUnits(t, displayBalance ?? balance)}
                    </Text>
                    {floatingReward ? (
                      <Animated.Text
                        key={floatingReward.key}
                        style={[
                          styles.floatingReward,
                          {
                            color: success,
                            opacity: floatAnimRef.current.interpolate({
                              inputRange: [0, 0.2, 1],
                              outputRange: [0, 1, 0],
                            }),
                            transform: [
                              {
                                translateY: floatAnimRef.current.interpolate({
                                  inputRange: [0, 1],
                                  outputRange: [8, -18],
                                }),
                              },
                            ],
                          },
                        ]}
                      >
                        +{formatEconomyUnits(t, floatingReward.amount)}
                      </Animated.Text>
                    ) : null}
                  </View>
                </View>
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[styles.activityPill, { borderColor: border }]}
                  onPress={() => {
                    setActivityVisible(true);
                    loadActivity();
                  }}
                >
                  <Text style={[styles.activityLinkText, { color: inlineAccentColor }]}>
                    {t("economy.cookies_activity", { defaultValue: "Activity" })}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={[styles.balanceIntro, { color: mutedText }]}>
                {t("economy.economy_explainer", {
                  defaultValue: "Eggs are used for premium AI features.",
                })}
              </Text>
            </View>

            <View style={[styles.sectionHeader, styles.sectionHeaderFirst]}>
              <Text style={[styles.sectionTitle, { color: sectionTitle }]}>
                {t("economy.weekly_mission_title", { defaultValue: "7-day mission" })}
              </Text>
              <Text style={[styles.sectionDescription, { color: mutedText }]}>
                {missions?.unlocked
                  ? t("economy.weekly_mission_description", {
                      defaultValue: "Complete actions during your 7-day cycle and claim rewards.",
                    })
                  : t("economy.weekly_mission_locked", {
                      count: missions?.freePremiumActionsRemaining ?? 0,
                      defaultValue: "Missions unlock after your free AI actions are complete.",
                    })}
              </Text>
            </View>

            {missions ? (
              <View style={[styles.missionPanel, { borderColor: border, backgroundColor: isDark ? "#2A221B" : "#FFF7E6" }]}>
                <View style={styles.missionTopRow}>
                  <View>
                    <Text style={[styles.missionMeta, { color: mutedText }]}>
                      {missions.unlocked
                        ? t("economy.weekly_mission_day", {
                            count: missions.dayOfCycle || 1,
                            defaultValue: "Day {{count}} of 7",
                          })
                        : t("economy.weekly_mission_not_started", { defaultValue: "Not started yet" })}
                    </Text>
                    <Text style={[styles.missionProgressText, { color: text }]}>
                      {t("economy.weekly_mission_progress", {
                        completed: missions.actionsCompleted,
                        target: missions.actionsTarget,
                        defaultValue: "{{completed}} / {{target}} actions completed",
                      })}
                    </Text>
                  </View>
                  {missions.unlocked && missions.cycleEnd ? (
                    <Text style={[styles.missionMeta, { color: mutedText }]}>
                      {t("economy.weekly_mission_refreshes", {
                        date: new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }).format(new Date(missions.cycleEnd)),
                        defaultValue: "Refreshes {{date}}",
                      })}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.missionProgressTrack, { backgroundColor: isDark ? "#3A3027" : "#F3E6CF" }]}>
                  <View
                    style={[
                      styles.missionProgressFill,
                      {
                        backgroundColor: inlineAccentColor,
                        width: `${Math.min(100, Math.max(0, (missions.actionsCompleted / Math.max(1, missions.actionsTarget)) * 100))}%`,
                      },
                    ]}
                  />
                </View>
              </View>
            ) : null}

            {missions?.rewards?.filter((reward) => reward.status !== "redeemed").map((reward, index, list) => {
              const available = reward.status === "available" && isProgressComplete(reward.progress, reward.target);
              const claimed = reward.status === "redeemed";
              const rewardKey = reward.rewardKey || reward.id;
              const claiming = claimingMissionKey === rewardKey;
              const highlighted = highlightedRewardKey === rewardKey;
              const missionTitle = getMissionTitle(reward, t);
              const rewardAmount = formatEconomyUnits(t, reward.cookies);
              const progressRatio = Math.min(1, Math.max(0, reward.progress / Math.max(1, reward.target)));
              const showProgress = !claimed && reward.target > 1;
              const hasAction = Boolean(reward.action);
              const highlightBg = highlightAnimRef.current.interpolate({
                inputRange: [0, 1],
                outputRange: ["rgba(0,0,0,0)", isDark ? "rgba(246,178,26,0.14)" : "rgba(246,178,26,0.2)"],
              });
              const ctaLabel = claimed
                ? t("economy.redeemed", { defaultValue: "Redeemed" })
                : available
                  ? claiming
                    ? t("common.loading", { defaultValue: "Loading..." })
                    : t("economy.claim_reward_amount", {
                        amount: rewardAmount,
                        defaultValue: "Claim {{amount}}",
                      })
                  : t("economy.get_reward_amount", {
                      amount: rewardAmount,
                      defaultValue: "Get {{amount}}",
                    });

              return (
                <Animated.View
                  key={reward.id}
                  onLayout={(event) => {
                    rewardPositionsRef.current[rewardKey] = event.nativeEvent.layout.y;
                  }}
                  style={[
                    styles.offerCard,
                    index === list.length - 1 && styles.offerCardLast,
                    {
                      borderColor: highlighted ? inlineAccentColor : border,
                      backgroundColor: highlighted ? highlightBg : "transparent",
                    },
                  ]}
                >
                  <TouchableOpacity
                    activeOpacity={reward.action ? 0.75 : 1}
                    disabled={!reward.action}
                    onPress={() => openMissionAction(reward.action)}
                    style={styles.offerLeft}
                  >
                    <View style={styles.offerMainRow}>
                      <MaterialIcons name="flag" size={21} color={inlineAccentColor} style={styles.cookieImageIcon} />
                      <Text style={[styles.offerMainTitle, { color: text }]}>{missionTitle}</Text>
                    </View>
                    {showProgress ? (
                      <View style={styles.rewardProgressRow}>
                        <View style={[styles.rewardProgressTrack, styles.rewardProgressTrackInRow, { backgroundColor: isDark ? "#3A3027" : "#F3E6CF" }]}>
                          <View style={[styles.rewardProgressFill, { backgroundColor: inlineAccentColor, width: `${progressRatio * 100}%` }]} />
                        </View>
                        <Text style={[styles.rewardProgressLabel, { color: mutedText }]}>
                          {t("economy.reward_progress", {
                            current: Math.min(reward.progress, reward.target),
                            target: reward.target,
                            defaultValue: "{{current}} / {{target}}",
                          })}
                        </Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                  <View style={styles.offerRight}>
                    <TouchableOpacity
                      style={[styles.buyBtn, { backgroundColor: available ? cta : "transparent", borderColor: available ? cta : border, borderWidth: available ? 0 : 1, opacity: claimed ? 0.55 : 1 }]}
                      disabled={claiming || (!available && !hasAction)}
                      onPress={() => {
                        if (available) {
                          claimMissionReward(reward);
                        } else if (reward.action) {
                          openMissionAction(reward.action);
                        }
                      }}
                      activeOpacity={0.8}
                    >
                      {claiming ? (
                        <ActivityIndicator size="small" color={available ? onCta : mutedText} />
                      ) : (
                        <Text style={[styles.buyBtnText, { color: available ? onCta : mutedText }]}>{ctaLabel}</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </Animated.View>
              );
            })}

            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: sectionTitle }]}>
                {t("economy.milestones_title", { defaultValue: "Milestones" })}
              </Text>
              <Text style={[styles.sectionDescription, { color: mutedText }]}>
                {t("economy.milestones_description", {
                  defaultValue: "One-time rewards for exploring the app.",
                })}
              </Text>
            </View>

            {offers.length === 0 && bonuses.length === 0 ? (
              <Text style={[styles.muted, { color: mutedText }]}>
                {t("economy.no_offers", "No offers available right now.")}
              </Text>
            ) : (
              <>
                {availableBonuses.length === 0 ? (
                  <View style={[styles.emptyState, styles.emptyStateNoBottomDivider, { borderColor: border }]}>
                    <Text style={[styles.emptyStateTitle, { color: text }]}>
                      {t(
                        "economy.no_available_rewards_title",
                        "You’ve claimed all available free rewards for now."
                      )}
                    </Text>
                    <Text style={[styles.emptyStateBody, { color: mutedText }]}>
                      {t(
                        "economy.no_available_rewards_body",
                        "We may add new rewards from time to time, so keep an eye on this space."
                      )}
                    </Text>
                  </View>
                ) : null}

                {availableBonuses
                  .filter((b) => b.status !== "redeemed")
                  .map((b, index, list) => {
                    const redeemed = b.status === "redeemed";
                    const complete = isProgressComplete(b.progress, b.target);
                    const locked = b.status === "locked" || !complete;
                    const available = b.status === "available" && complete;
                    const rewardKey = b.rewardKey || b.id;
                    const claiming = claimingBonusKey === rewardKey;
                    const highlighted = highlightedRewardKey === rewardKey;
                    const highlightBg = highlightAnimRef.current.interpolate({
                      inputRange: [0, 1],
                      outputRange: ["rgba(0,0,0,0)", isDark ? "rgba(246,178,26,0.14)" : "rgba(246,178,26,0.2)"],
                    });
                    const isSignupBonus = rewardKey === "signup_bonus_v1";
                    const rewardAmount = formatEconomyUnits(t, b.cookies);
                    const rewardTitle = getRewardActionTitle(b, t);
                    const buttonClaimable = available && !isSignupBonus;
                    const ctaLabel = redeemed
                      ? t("economy.redeemed", "Redeemed")
                      : isSignupBonus
                        ? t("economy.get_reward_amount", { amount: rewardAmount, defaultValue: "Get {{amount}}" })
                      : locked
                        ? t("economy.get_reward_amount", { amount: rewardAmount, defaultValue: "Get {{amount}}" })
                      : claiming
                        ? t("common.loading", { defaultValue: "Loading..." })
                        : t("economy.claim_reward_amount", {
                            amount: rewardAmount,
                            defaultValue: "Claim {{amount}}",
                          });

                    const ctaDisabled = redeemed || claiming || (!buttonClaimable && !b.action);

                    return (
                      <Animated.View
                        key={b.id}
                        onLayout={(event) => {
                          rewardPositionsRef.current[rewardKey] = event.nativeEvent.layout.y;
                        }}
                        style={[
                          styles.offerCard,
                          index === list.length - 1 && styles.offerCardLast,
                          {
                            borderColor: highlighted ? inlineAccentColor : border,
                            backgroundColor: highlighted ? highlightBg : "transparent",
                          },
                        ]}
                      >
                        <TouchableOpacity
                          activeOpacity={b.action ? 0.75 : 1}
                          disabled={!b.action}
                          onPress={() => openBonusAction(b)}
                          style={styles.offerLeft}
                        >
                          <View style={styles.offerMainRow}>
                            <MaterialIcons name="card-giftcard" size={22} color={inlineAccentColor} style={styles.cookieImageIcon} />
                            <Text style={[styles.offerMainTitle, { color: text }]}>
                              {rewardTitle}
                            </Text>
                          </View>
                        </TouchableOpacity>

                        <View style={styles.offerRight}>
                          <TouchableOpacity
                            style={[
                              styles.buyBtn,
                              {
                                backgroundColor: buttonClaimable ? cta : "transparent",
                                borderColor: buttonClaimable ? cta : border,
                                borderWidth: buttonClaimable ? 0 : 1,
                                opacity: redeemed ? 0.55 : 1,
                              },
                            ]}
                            disabled={ctaDisabled}
                            onPress={() => {
                              if (buttonClaimable) {
                                claimBonusReward(b);
                              } else if (!ctaDisabled) {
                                if (b.action === "create_account") {
                                  onPressSignup();
                                } else {
                                  openBonusAction(b);
                                }
                              }
                            }}
                            activeOpacity={0.8}
                          >
                            {claiming ? (
                              <ActivityIndicator size="small" color={buttonClaimable ? onCta : mutedText} />
                            ) : (
                              <Text style={[styles.buyBtnText, { color: buttonClaimable ? onCta : mutedText }]}>{ctaLabel}</Text>
                            )}
                          </TouchableOpacity>
                        </View>
                      </Animated.View>
                    );
                  })}

                <View style={[styles.sectionHeader, styles.sectionHeaderSeparated, { borderTopColor: border }]}>
                  <Text style={[styles.sectionTitle, { color: sectionTitle }]}>
                    {t("economy.cookie_plans", "Plans")}
                  </Text>
                  <Text style={[styles.sectionDescription, { color: mutedText }]}>
                    {t("economy.plans_description", {
                      defaultValue: "Buy more Eggs at any time to unlock AI features.",
                    })}
                  </Text>
                </View>

                {offers.map((o, index) => {
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
                  const sku = String(o.productId || o.id || "").trim();
                  const nativePrice = sku && iapProducts[sku] ? (iapProducts[sku] as any)?.localizedPrice : null;
                  const priceText = typeof nativePrice === "string" && nativePrice.trim() ? nativePrice : formatPrice(o.price, o.currency);

                  return (
                    <View
                      key={o.id}
                      style={[
                        styles.offerCard,
                        index === offers.length - 1 && styles.offerCardLast,
                        {
                          backgroundColor: isHighlighted ? softAccentBg : "transparent",
                          borderColor: isHighlighted ? inlineAccentColor : border,
                          borderLeftWidth: isHighlighted ? 3 : 0,
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
                                <Text style={[styles.offerPromoCookies, { color: text }]}>
                                  {formatEconomyUnits(t, totalCookies)}
                                </Text>
                                <Text style={[styles.promoParen, { color: softText }]}>
                                  (
                                </Text>
                                <Text style={[styles.offerBaseCookies, { color: softText }]}>
                                  {formatEconomyUnits(t, baseCookies)}
                                </Text>
                                <Text style={[styles.promoParen, { color: softText }]}>
                                  )
                                </Text>
                              </View>
                            ) : (
                              <Text style={[styles.offerMainTitle, { color: text }]}>
                                {formatEconomyUnits(t, Math.max(0, Math.floor(o.cookies)))}
                              </Text>
                            )}
                          </View>

                          {o.mostPurchased ? (
                            <View style={[styles.highlightChip, softAccentChip]}>
                              <Text numberOfLines={1} style={[styles.highlightChipText, softAccentChipText]}>{t("economy.most_purchased", "Most purchased")}</Text>
                            </View>
                          ) : null}
                        </View>

                        {o.subtitle ? (
                          <Text style={[styles.offerPriceLine, { color: mutedText }]}>
                            {o.subtitle}
                          </Text>
                        ) : null}

                        {/* Badges belong with the details (left), not next to the Buy button */}
                        {renderBadges(o.badges)}
                      </View>

                      <View style={styles.offerRight}>
                        <TouchableOpacity
                          style={[styles.buyBtn, { backgroundColor: cta, opacity: 1 }]}
                          onPress={() => onBuy(o)}
                          activeOpacity={0.8}
                        >
                          <Text style={[styles.buyBtnText, { color: onCta }]}>{`${t("economy.buy", "Buy")} ${priceText}`}</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </>
            )}

          </>
        )}
      </ScrollView>
      <EconomyActivityModal
        visible={activityVisible}
        isDark={isDark}
        card={card}
        border={border}
        text={text}
        subText={mutedText}
        backdrop={isDark ? "rgba(0,0,0,0.56)" : "rgba(0,0,0,0.28)"}
        positiveDeltaColor={positiveDeltaColor}
        negativeDeltaColor={inlineAccentColor}
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
  container: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 10 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  backButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  balanceHero: {
    paddingTop: 10,
    paddingBottom: 18,
    marginBottom: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  balanceHeroMain: {
    flexDirection: "row",
    alignItems: "center",
  },
  balanceHeroCopy: {
    marginLeft: 12,
    flex: 1,
    minWidth: 0,
  },
  balanceIntro: {
    marginTop: 12,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "400",
  },
  activityLinkText: {
    fontSize: 13,
    fontWeight: "700",
  },
  activityPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginLeft: 12,
  },
  emptyState: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    marginBottom: 8,
  },
  emptyStateNoBottomDivider: {
    borderBottomWidth: 0,
  },
  emptyStateTitle: { fontSize: 15, fontWeight: "700", marginBottom: 6 },
  emptyStateBody: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  balanceLabel: { fontSize: 12, opacity: 0.85, fontWeight: "700", textTransform: "uppercase" },
  balanceValue: { fontSize: 26, fontWeight: "800" },
  balanceValueWrap: {
    alignSelf: "flex-start",
    position: "relative",
  },
  floatingReward: {
    position: "absolute",
    right: -52,
    top: -2,
    fontSize: 14,
    fontWeight: "800",
  },
  sectionHeader: {
    marginTop: 22,
    marginBottom: 8,
  },
  sectionHeaderFirst: {
    marginTop: 14,
  },
  sectionHeaderSeparated: {
    borderTopWidth: 1.5,
    paddingTop: 18,
    marginTop: 28,
  },
  sectionTitle: { fontSize: 18, fontWeight: "700" },
  sectionDescription: {
    marginTop: 5,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "400",
  },
  offerCard: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 15,
    paddingLeft: 10,
    paddingRight: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 0,
  },
  offerCardLast: {
    borderBottomWidth: 0,
  },
  missionPanel: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 4,
  },
  missionTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  missionMeta: {
    fontSize: 12,
    fontWeight: "600",
  },
  missionProgressText: {
    marginTop: 4,
    fontSize: 16,
    fontWeight: "800",
  },
  missionProgressTrack: {
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
    marginTop: 12,
  },
  missionProgressFill: {
    height: "100%",
    borderRadius: 999,
  },
  rewardProgressTrack: {
    height: 5,
    borderRadius: 999,
    overflow: "hidden",
    marginTop: 8,
    maxWidth: 220,
  },
  rewardProgressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
    maxWidth: 230,
  },
  rewardProgressTrackInRow: {
    flex: 1,
    marginTop: 0,
  },
  rewardProgressLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
  },
  rewardProgressFill: {
    height: "100%",
    borderRadius: 999,
  },
  offerMainRow: { flexDirection: "row", alignItems: "center", minWidth: 0 },
  cookieImageIcon: { marginRight: 8 },
  offerMainTitle: { flex: 1, flexShrink: 1, fontSize: 18, fontWeight: "700" },
  promoTitleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  offerBaseCookies: { fontSize: 14, fontWeight: "700", textDecorationLine: "line-through" },
  promoParen: { fontSize: 14, fontWeight: "700" },
  offerPromoCookies: { fontSize: 18, fontWeight: "700" },
  offerPriceLine: { fontSize: 14, lineHeight: 20, marginTop: 7, fontWeight: "400", marginBottom: 4 },
  offerBonusLine: { fontSize: 14, lineHeight: 20, marginTop: 6 },
  offerSubtitle: { fontSize: 14, lineHeight: 20, marginTop: 6, fontWeight: "400" },
  offerSubtitleStrong: { fontWeight: "700" },
  muted: { fontSize: 14 },
  buyBtn: {
    width: 98,
    minHeight: 34,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 11,
    marginLeft: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  buyBtnText: { fontWeight: "700", fontSize: 12, textAlign: "center" },
  offerRight: { justifyContent: "center", alignItems: "flex-end", gap: 8 },
  offerLeft: { flex: 1, minWidth: 0, paddingRight: 12 },
  footnote: { fontSize: 13, lineHeight: 19, marginTop: 10, opacity: 0.85 },
  badgeRow: { flexDirection: "row", flexWrap: "nowrap", gap: 6, marginTop: 8, overflow: "hidden" },
  badgeChip: { backgroundColor: "#00000010", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, maxWidth: 132 },
  badgeChipText: { fontSize: 13, fontWeight: "500" },
  freeChip: {
    marginLeft: 10,
    backgroundColor: "#00000010",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  freeChipText: {
    fontSize: 13,
    fontWeight: "700",
  },
  freeChipDark: {
    backgroundColor: "#ffbd80aa",
    borderColor: "#ffbd80",
    borderWidth: 1,
  },
  freeChipTextDark: {},
  highlightChip: {
    backgroundColor: "#ffbd80aa",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: "flex-start",
    maxWidth: 132,
  },
  highlightChipText: { fontSize: 13, fontWeight: "500" },

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
