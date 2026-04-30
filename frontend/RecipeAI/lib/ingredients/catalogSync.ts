import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  INGREDIENT_CATALOG_ITEMS_KEY,
  INGREDIENT_CATALOG_LAST_SYNC_AT_KEY,
  INGREDIENT_CATALOG_MANIFEST_KEY,
  IngredientCatalogEntry,
  IngredientCatalogManifest,
  setIngredientCatalogCache,
} from "./catalog";
import { getApiBaseUrl } from "../config/api";

const API_BASE_URL = getApiBaseUrl() || "http://10.0.2.2:3000";
const INGREDIENT_CATALOG_REFRESH_INTERVAL_MS = 1000 * 60 * 60 * 24;
const INGREDIENT_CATALOG_MIN_EXPECTED_ITEMS = 1000;

type StoredIngredientCatalogMap = Record<string, IngredientCatalogEntry>;

function toCatalogMap(items: IngredientCatalogEntry[]): StoredIngredientCatalogMap {
  return items.reduce<StoredIngredientCatalogMap>((acc, item) => {
    if (item?.id) acc[item.id] = item;
    return acc;
  }, {});
}

export async function loadIngredientCatalogManifest(): Promise<IngredientCatalogManifest | null> {
  try {
    const raw = await AsyncStorage.getItem(INGREDIENT_CATALOG_MANIFEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as IngredientCatalogManifest;
  } catch {
    return null;
  }
}

export async function loadIngredientCatalogItems(): Promise<StoredIngredientCatalogMap> {
  try {
    const raw = await AsyncStorage.getItem(INGREDIENT_CATALOG_ITEMS_KEY);
    if (!raw) {
      setIngredientCatalogCache({});
      return {};
    }
    const parsed = JSON.parse(raw);
    const next =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    setIngredientCatalogCache(next);
    return next;
  } catch {
    setIngredientCatalogCache({});
    return {};
  }
}

async function saveIngredientCatalogState(
  manifest: IngredientCatalogManifest,
  itemsMap: StoredIngredientCatalogMap
) {
  setIngredientCatalogCache(itemsMap);
  await Promise.all([
    AsyncStorage.setItem(INGREDIENT_CATALOG_MANIFEST_KEY, JSON.stringify(manifest)),
    AsyncStorage.setItem(INGREDIENT_CATALOG_ITEMS_KEY, JSON.stringify(itemsMap)),
    AsyncStorage.setItem(INGREDIENT_CATALOG_LAST_SYNC_AT_KEY, String(Date.now())),
  ]);
}

export async function upsertIngredientCatalogItemsLocally(
  items: IngredientCatalogEntry[]
): Promise<StoredIngredientCatalogMap> {
  const current = await loadIngredientCatalogItems();
  const next = {
    ...current,
    ...toCatalogMap(items.filter((item) => item?.id)),
  };
  setIngredientCatalogCache(next);
  await AsyncStorage.setItem(INGREDIENT_CATALOG_ITEMS_KEY, JSON.stringify(next));
  return next;
}

async function fetchCatalogManifest(): Promise<IngredientCatalogManifest | null> {
  const res = await fetch(`${API_BASE_URL}/ingredients/catalog/manifest`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.manifest ?? null;
}

async function fetchCatalogItems(updatedAfter?: number | null): Promise<IngredientCatalogEntry[]> {
  const params = new URLSearchParams();
  params.set("limit", "5000");
  if (typeof updatedAfter === "number" && Number.isFinite(updatedAfter) && updatedAfter > 0) {
    params.set("updatedAfter", String(updatedAfter));
  }

  const items: IngredientCatalogEntry[] = [];
  let cursor: number | null = updatedAfter ?? null;

  while (true) {
    if (typeof cursor === "number" && cursor > 0) {
      params.set("updatedAfter", String(cursor));
    }
    const res = await fetch(`${API_BASE_URL}/ingredients/catalog/items?${params.toString()}`);
    if (!res.ok) break;
    const data = await res.json().catch(() => null);
    const batch = Array.isArray(data?.items) ? data.items : [];
    items.push(...batch);
    if (batch.length < 500) break;
    const nextCursor = data?.cursor;
    if (!Number.isFinite(nextCursor) || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return items;
}

export async function syncIngredientCatalog(options?: { force?: boolean }) {
  try {
    const force = options?.force === true;
    const [localManifest, localItemsMap, lastSyncRaw] = await Promise.all([
      loadIngredientCatalogManifest(),
      loadIngredientCatalogItems(),
      AsyncStorage.getItem(INGREDIENT_CATALOG_LAST_SYNC_AT_KEY),
    ]);

    const lastSyncAt = Number(lastSyncRaw || 0);
    const shouldSkip =
      !force &&
      Number.isFinite(lastSyncAt) &&
      lastSyncAt > 0 &&
      Date.now() - lastSyncAt < INGREDIENT_CATALOG_REFRESH_INTERVAL_MS &&
      Object.keys(localItemsMap).length >= INGREDIENT_CATALOG_MIN_EXPECTED_ITEMS;

    if (shouldSkip) {
      return {
        updated: false,
        manifest: localManifest,
        itemCount: Object.keys(localItemsMap).length,
      };
    }

    const remoteManifest = await fetchCatalogManifest();
    if (!remoteManifest) {
      return {
        updated: false,
        manifest: localManifest,
        itemCount: Object.keys(localItemsMap).length,
      };
    }

    const localUpdatedAt = typeof localManifest?.updatedAt === "number" ? localManifest.updatedAt : 0;
    const needsFullSync = !localManifest || localUpdatedAt <= 0 || remoteManifest.updatedAt < localUpdatedAt;
    const fetchedItems = await fetchCatalogItems(needsFullSync ? null : localUpdatedAt);

    const nextItemsMap = needsFullSync
      ? toCatalogMap(fetchedItems)
      : {
          ...localItemsMap,
          ...toCatalogMap(fetchedItems),
        };

    await saveIngredientCatalogState(remoteManifest, nextItemsMap);

    return {
      updated: true,
      manifest: remoteManifest,
      itemCount: Object.keys(nextItemsMap).length,
    };
  } catch (err) {
    console.warn("[IngredientCatalog] sync failed", err);
    return { updated: false, manifest: null, itemCount: 0 };
  }
}
