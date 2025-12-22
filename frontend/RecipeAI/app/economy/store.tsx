import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Alert, Platform, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useThemeColors } from "../../context/ThemeContext";
import { useTranslation } from "react-i18next";
import { getAuth } from "firebase/auth";
import { getDeviceId } from "../../utils/deviceId";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as RNIap from "react-native-iap";

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
  // Examples: "15 Cookies", "50 cookies", "120 🍪" -> 15/50/120
  const m = String(title || "").match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
};

export default function EconomyStoreScreen() {
  const { t } = useTranslation();
  const { bg, text, card, border, isDark } = useThemeColors();
  const router = useRouter();

  const backendUrl = process.env.EXPO_PUBLIC_API_URL!;
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState<number | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [bonuses, setBonuses] = useState<BonusOffer[]>([]);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);

  // --- Google Play Billing (Android) ---
  // IMPORTANT: We NEVER grant cookies on-device. The backend must verify the purchase token
  // with Google Play and then credit the user's balance. Only after backend success do we
  // finish/acknowledge the transaction.
  const [iapReady, setIapReady] = useState(false);
  const [iapProducts, setIapProducts] = useState<Record<string, RNIap.Product>>({});
  const purchaseInFlightRef = useRef(false);

  const offerSkus = useMemo(() => {
    const skus = offers
      .map((o) => String(o.productId || o.id || "").trim())
      .filter(Boolean);
    // Unique + stable
    return Array.from(new Set(skus));
  }, [offers]);

  const verifyPurchaseWithBackend = useCallback(
    async (purchase: RNIap.Purchase): Promise<{ ok: boolean; message?: string; balance?: number | null }>
    => {
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
    if (Platform.OS !== "android") return;

    let purchaseSub: any;
    let errorSub: any;
    let mounted = true;

    (async () => {
      try {
        const ok = await RNIap.initConnection();
        if (!mounted) return;
        setIapReady(!!ok);

        // Recommended on Android to clear pending failed purchases cached as pending.
        try {
          await RNIap.flushFailedPurchasesCachedAsPendingAndroid();
        } catch {
          // ignore
        }

        purchaseSub = RNIap.purchaseUpdatedListener(async (purchase) => {
          try {
            // Guard against parallel callbacks
            if (purchaseInFlightRef.current) return;
            purchaseInFlightRef.current = true;

            const result = await verifyPurchaseWithBackend(purchase);
            if (!result.ok) {
              // Do NOT finishTransaction here, otherwise we could lose the ability to re-verify.
              Alert.alert("Purchase pending", result.message || "We couldn't verify your purchase yet. Please try again.");
              return;
            }

            // Backend verified + granted. Now acknowledge/finish the consumable.
            await RNIap.finishTransaction({ purchase, isConsumable: true });

            // Refresh balance UI.
            await loadBalance();
          } catch (e: any) {
            console.warn("[IAP] purchaseUpdatedListener error", e);
            Alert.alert("Purchase error", "Something went wrong while confirming your purchase.");
          } finally {
            purchaseInFlightRef.current = false;
          }
        });

        errorSub = RNIap.purchaseErrorListener((err) => {
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
      try { purchaseSub?.remove?.(); } catch {}
      try { errorSub?.remove?.(); } catch {}
      try { RNIap.endConnection(); } catch {}
    };
  }, [verifyPurchaseWithBackend, loadBalance]);

  // Refresh the Play product cache when offers change (so we can rely on native price strings if desired).
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!iapReady) return;
    if (!offerSkus || offerSkus.length === 0) return;

    (async () => {
      try {
        const prods = await RNIap.getProducts({ skus: offerSkus });
        const map: Record<string, RNIap.Product> = {};
        for (const p of prods) {
          const sku = String((p as any)?.productId || (p as any)?.sku || "").trim();
          if (sku) map[sku] = p;
        }
        setIapProducts(map);
      } catch (e) {
        console.warn("[IAP] getProducts failed", e);
      }
    })();
  }, [iapReady, offerSkus]);

  // ✅ auth.currentUser isn't reactive; track uid in state so balance refreshes on login/logout.
  const auth = getAuth();
  const [economyUid, setEconomyUid] = useState<string | null>(auth.currentUser?.uid ?? null);
  const isAnon = !!auth.currentUser?.isAnonymous;

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
        const badges = Array.isArray(b?.badges) ? b.badges.filter((x: any) => typeof x === "string") : undefined;
        return { id, title, subtitle, cookies, status, badges } as BonusOffer;
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
      Alert.alert("Not available", "Purchases are only available on Android for now.");
      return;
    }

    const sku = String(offer.productId || offer.id || "").trim();
    if (!sku) {
      Alert.alert("Unavailable", "This offer is missing a product id.");
      return;
    }

    // Google Play Billing is not ready yet. Make sure you uploaded an AAB with Play Billing enabled and try again.
    if (!iapReady) {
      Alert.alert(
        "Billing not ready",
        "Please try again later."
      );
      return;
    }

    // Must be logged in (or anonymous) so we have an idToken to let the backend grant cookies.
    if (!auth.currentUser) {
      Alert.alert("Sign in required", "Please sign in and try again.");
      return;
    }

    try {
      // Launch Play purchase flow.
      // For one-time consumables (cookies), requestPurchase is correct.
      await RNIap.requestPurchase({ sku });
      // The rest continues in purchaseUpdatedListener:
      // - backend verifies & grants
      // - finishTransaction after success
      // - refresh balance
    } catch (e: any) {
      console.warn("[IAP] requestPurchase failed", e);
      Alert.alert("Purchase failed", "Couldn't start the purchase. Please try again.");
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: isDark ? bg : "#F5F5F5" }} edges={["left", "right", "bottom"]}>
      <ScrollView
        style={{ flex: 1 }}
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
              {t("economy.cookies_balance:", "Balance")}
            </Text>
            <View style={[styles.balanceCard, { backgroundColor: card, borderColor: border }]}>
              <Text style={[styles.balanceValue, { color: text }]}>🍪 {balance === null ? "—" : balance}</Text>
            </View>

            <Text style={[styles.sectionTitle, { color: isDark ? "#f5f5f5" : "#293a53" }]}>
              {t("economy.offers", "Offers")}
            </Text>

            {offers.length === 0 && bonuses.length === 0 ? (
              <Text style={[styles.muted, { color: isDark ? "#ddd" : "#666" }]}>
                {t("economy.no_offers", "No offers available right now.")}
              </Text>
            ) : (
              <>
                {bonuses
                  .filter((b) => b.status !== "redeemed")
                  .map((b) => {
                    const redeemed = b.status === "redeemed";
                    const locked = b.status === "locked";

                    const ctaLabel = redeemed
                      ? t("economy.redeemed", "Redeemed")
                      : locked
                        ? t("economy.login_required", "Sign in required")
                        : (isLoggedIn && !isAnon)
                          ? t("economy.active", "Active")
                          : t("economy.signup", "Sign up");

                    const ctaDisabled = redeemed || locked || (isLoggedIn && !isAnon);

                    return (
                      <View key={b.id} style={[styles.offerCard, { backgroundColor: card, borderColor: border }]}>
                        <View style={styles.offerLeft}>
                          <View style={styles.offerMainRow}>
                            <Text style={[styles.cookieIcon, { color: text }]}>🎁</Text>
                            <Text style={[styles.offerMainTitle, { color: text }]}>
                              +{b.cookies} {t("economy.cookies", "Cookies")}
                            </Text>
                            <View style={styles.freeChip}>
                              <Text style={styles.freeChipText}>{t("economy.free", "Free")}</Text>
                            </View>
                          </View>

                          {/* For bonus offers, hide the title and show only the description */}
                          {!!b.subtitle && (
                            <Text style={[styles.offerSubtitle, { color: isDark ? "#ddd" : "#666" }]}>
                              {b.subtitle}
                            </Text>
                          )}

                          {renderBadges(b.badges)}
                        </View>

                        <View style={styles.offerRight}>
                          <TouchableOpacity
                            style={[styles.buyBtn, { opacity: ctaDisabled ? 0.55 : 1 }]}
                            disabled={ctaDisabled}
                            onPress={() => {
                              if (!ctaDisabled) onPressSignup();
                            }}
                            activeOpacity={0.8}
                          >
                            <Text style={styles.buyBtnText}>{ctaLabel}</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })}

                {offers.map((o) => {
                  const bonus = o.bonusCookies || 0;

                  // Prefer parsing the base from the title (e.g. "15 Cookies") to keep UI consistent,
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
                    <View key={o.id} style={[styles.offerCard, { backgroundColor: card, borderColor: border }]}>
                      <View style={styles.offerLeft}>
                        {/* Top row: icon + title/promo on the left, and "Most purchased" chip on the right */}
                        <View style={styles.offerTopRow}>
                          <View style={styles.offerTopLeft}>
                            <Text style={[styles.cookieIcon, { color: text }]}>🍪</Text>

                            {showPromo ? (
                              <View style={styles.promoTitleRow}>
                                <Text style={[styles.offerBaseCookies, { color: isDark ? "#bbb" : "#7a7a7a" }]}>
                                  {baseCookies} {t("economy.cookies", "Cookies")}
                                </Text>
                                <Text style={[styles.promoArrow, { color: isDark ? "#bbb" : "#7a7a7a" }]}>→</Text>
                                <Text style={[styles.offerPromoCookies, { color: text }]}>
                                  {totalCookies} {t("economy.cookies", "Cookies")}
                                </Text>
                              </View>
                            ) : (
                              <Text style={[styles.offerMainTitle, { color: text }]}>
                                {Math.max(0, Math.floor(o.cookies))} {t("economy.cookies", "Cookies")}
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

                {bonuses
                  .filter((b) => b.status === "redeemed")
                  .map((b) => {
                    const redeemed = true;
                    const locked = b.status === "locked";

                    const ctaLabel = t("economy.redeemed", "Redeemed");
                    const ctaDisabled = true;

                    return (
                      <View key={b.id} style={[styles.offerCard, { backgroundColor: card, borderColor: border }]}>
                        <View style={styles.offerLeft}>
                          <View style={styles.offerMainRow}>
                            <Text style={[styles.cookieIcon, { color: text }]}>🎁</Text>
                            <Text style={[styles.offerMainTitle, { color: text }]}>
                              +{b.cookies} {t("economy.cookies", "Cookies")}
                            </Text>
                            <View style={styles.freeChip}>
                              <Text style={styles.freeChipText}>{t("economy.free", "Free")}</Text>
                            </View>
                          </View>

                          {!!b.subtitle && (
                            <Text style={[styles.offerSubtitle, { color: isDark ? "#ddd" : "#666" }]}>
                              {b.subtitle}
                            </Text>
                          )}

                          {renderBadges(b.badges)}
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
                    "economy.cookies_what_body_logged_in",
                    "Cookies are credits used for AI-powered features and for creating additional cookbooks beyond the free limit. You can earn some for free (we run promotions from time to time) and top up at any time."
                  )
                : t(
                    "economy.cookies_what_body_logged_out",
                    "Cookies are credits used for AI-powered features and for creating additional cookbooks beyond the free limit. Create an account and sign in to earn extra cookies for free — and you can also top up at any time."
                  )}
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  balanceCard: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 16 },
  balanceLabel: { fontSize: 14, opacity: 0.8 },
  balanceValue: { fontSize: 22, fontWeight: "800"},
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
  cookieIcon: { fontSize: 18, marginRight: 8 },
  offerMainTitle: { fontSize: 18, fontWeight: "900" },
  promoTitleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  offerBaseCookies: { fontSize: 16, fontWeight: "900", textDecorationLine: "line-through" },
  promoArrow: { fontSize: 14, fontWeight: "900", marginHorizontal: 2 },
  offerPromoCookies: { fontSize: 18, fontWeight: "900" },
  offerPriceLine: { fontSize: 16, marginTop: 8,fontWeight: "600", marginBottom: 4},
  offerBonusLine: { fontSize: 14, marginTop: 6 },
  offerSubtitle: { fontSize: 14, marginTop: 6 },
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