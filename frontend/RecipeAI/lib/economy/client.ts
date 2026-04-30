import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Auth } from "firebase/auth";
import { getDeviceId } from "../../utils/deviceId";

export type EconomySnapshot = {
  balance: number | null;
  freePremiumActionsRemaining: number | null;
};

export type EconomyLedgerEntry = {
  id?: string;
  delta?: number | null;
  balanceAfter?: number | null;
  freePremiumActionsAfter?: number | null;
  kind?: string | null;
  reason?: string | null;
  actionKey?: string | null;
  source?: string | null;
  createdAt?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type EconomyCatalogOffer = {
  id: string;
  productId?: string;
  title: string;
  subtitle?: string;
  price: number;
  currency: string;
  cookies: number;
  badges?: string[];
  isPromo?: boolean;
  bonusCookies?: number;
  mostPurchased?: boolean;
};

export type EconomyCatalogBonus = {
  id: string;
  rewardKey?: string;
  title?: string;
  description?: string;
  cookies: number;
  status?: "available" | "redeemed" | "locked" | "hidden";
  reason?: string;
  action?: string | null;
  badges?: string[];
};

export type EconomyCatalogBundle = {
  offers: EconomyCatalogOffer[];
  bonuses: EconomyCatalogBonus[];
};

export async function claimEconomyReward({
  backendUrl,
  appEnv = "local",
  auth,
  rewardKey,
}: EconomyRequestParams & { rewardKey: string }) {
  if (!backendUrl || !rewardKey) return null;
  const headers = await buildEconomyHeaders({ auth, appEnv });
  const res = await fetch(`${backendUrl}/economy/rewards/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ rewardKey }),
  });
  if (!res.ok) return null;
  return await res.json().catch(() => null);
}

type EconomyRequestParams = {
  backendUrl?: string | null;
  appEnv?: string;
  auth: Auth;
};

const snapshotCacheKey = (uid: string | null | undefined) => `economy_snapshot_${uid || "anon"}`;
const legacyBalanceCacheKey = (uid: string | null | undefined) => `economy_cookie_balance_${uid || "anon"}`;

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

async function buildEconomyHeaders({ auth, appEnv = "local" }: Pick<EconomyRequestParams, "auth" | "appEnv">) {
  const currentUser = auth.currentUser;
  const idToken = currentUser ? await currentUser.getIdToken().catch(() => null) : null;
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
}

export async function readCachedEconomySnapshot(uid?: string | null): Promise<EconomySnapshot | null> {
  try {
    const cached = await AsyncStorage.getItem(snapshotCacheKey(uid));
    if (cached) {
      const parsed = JSON.parse(cached);
      return {
        balance: toNumberOrNull(parsed?.balance),
        freePremiumActionsRemaining: toNumberOrNull(parsed?.freePremiumActionsRemaining),
      };
    }
  } catch {
    // ignore and try legacy cache next
  }

  try {
    const cachedBalance = await AsyncStorage.getItem(legacyBalanceCacheKey(uid));
    if (cachedBalance != null && !Number.isNaN(Number(cachedBalance))) {
      return {
        balance: Number(cachedBalance),
        freePremiumActionsRemaining: null,
      };
    }
  } catch {
    // ignore
  }

  return null;
}

export async function writeCachedEconomySnapshot(uid: string | null | undefined, snapshot: EconomySnapshot) {
  const normalized: EconomySnapshot = {
    balance: toNumberOrNull(snapshot.balance),
    freePremiumActionsRemaining: toNumberOrNull(snapshot.freePremiumActionsRemaining),
  };

  try {
    await AsyncStorage.setItem(snapshotCacheKey(uid), JSON.stringify(normalized));
    if (typeof normalized.balance === "number") {
      await AsyncStorage.setItem(legacyBalanceCacheKey(uid), String(normalized.balance));
    }
  } catch {
    // ignore
  }
}

export async function fetchEconomySnapshot({
  backendUrl,
  appEnv = "local",
  auth,
}: EconomyRequestParams): Promise<EconomySnapshot | null> {
  if (!backendUrl) return null;
  const headers = await buildEconomyHeaders({ auth, appEnv });
  const res = await fetch(`${backendUrl}/economy/balance`, { method: "GET", headers });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return {
    balance: toNumberOrNull(data?.balance ?? data?.remaining ?? data?.cookies),
    freePremiumActionsRemaining: toNumberOrNull(data?.freePremiumActionsRemaining),
  };
}

export async function fetchEconomyHistory({
  backendUrl,
  appEnv = "local",
  auth,
  limit = 50,
}: EconomyRequestParams & { limit?: number }): Promise<EconomyLedgerEntry[]> {
  if (!backendUrl) return [];
  const headers = await buildEconomyHeaders({ auth, appEnv });
  const qs = limit > 0 ? `?limit=${encodeURIComponent(String(limit))}` : "";
  const res = await fetch(`${backendUrl}/economy/history${qs}`, { method: "GET", headers });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return Array.isArray(data?.entries) ? data.entries : [];
}

export async function fetchEconomyCatalog({
  backendUrl,
  appEnv = "local",
  auth,
}: EconomyRequestParams): Promise<EconomyCatalogOffer[]> {
  const bundle = await fetchEconomyCatalogBundle({ backendUrl, appEnv, auth });
  return bundle.offers;
}

export async function fetchEconomyCatalogBundle({
  backendUrl,
  appEnv = "local",
  auth,
}: EconomyRequestParams): Promise<EconomyCatalogBundle> {
  if (!backendUrl) return { offers: [], bonuses: [] };
  const headers = await buildEconomyHeaders({ auth, appEnv });
  const res = await fetch(`${backendUrl}/economy/catalog`, { method: "GET", headers });
  if (!res.ok) return { offers: [], bonuses: [] };
  const data = await res.json().catch(() => null);
  if (Array.isArray(data)) return { offers: data, bonuses: [] };
  const offers = Array.isArray(data?.catalog?.offers)
    ? data.catalog.offers
    : Array.isArray(data?.offers)
      ? data.offers
      : [];
  const bonuses = Array.isArray(data?.catalog?.bonuses)
    ? data.catalog.bonuses
    : Array.isArray(data?.bonuses)
      ? data.bonuses
      : [];
  return { offers, bonuses };
}

export function shouldHidePremiumPricing(freePremiumActionsRemaining: number | null | undefined) {
  return typeof freePremiumActionsRemaining === "number" && freePremiumActionsRemaining > 0;
}
