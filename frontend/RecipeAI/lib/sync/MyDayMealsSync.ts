import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth } from "../../firebaseConfig";
import { getApiBaseUrl } from "../config/api";
import type { LocalEntity, MyDayMealDoc } from "./types";
import { resolveByUpdatedAt } from "./conflictStrategy";

const API_BASE_URL = getApiBaseUrl() || "http://10.0.2.2:3000";
const LEGACY_KEY = "myDayMeals";
const SYNC_KEY = "sync_myday_meals";
const SCHEMA_VERSION = 1;

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const user = auth.currentUser;
    if (!user) return {};
    const token = await user.getIdToken();
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

function toTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const direct = Number(value);
    if (Number.isFinite(direct)) return direct;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeMealDoc(raw: any): MyDayMealDoc {
  const createdAt = typeof raw?.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  return {
    id: String(raw?.id ?? ""),
    title: typeof raw?.title === "string" ? raw.title : "Meal",
    source:
      raw?.source === "photo" || raw?.source === "text" || raw?.source === "recipe" || raw?.source === "manual"
        ? raw.source
        : "manual",
    createdAt,
    dayKey: typeof raw?.dayKey === "string" ? raw.dayKey : createdAt.slice(0, 10),
    calories: Number(raw?.calories) || 0,
    protein: Number(raw?.protein) || 0,
    carbs: Number(raw?.carbs) || 0,
    fat: Number(raw?.fat) || 0,
    rawInput: typeof raw?.rawInput === "string" ? raw.rawInput : undefined,
    photoUri: typeof raw?.photoUri === "string" ? raw.photoUri : undefined,
    recipeId: typeof raw?.recipeId === "string" ? raw.recipeId : undefined,
    servingMultiplier: Number.isFinite(raw?.servingMultiplier) ? Number(raw.servingMultiplier) : undefined,
    nutritionMode: raw?.nutritionMode === "manual" ? "manual" : raw?.nutritionMode === "auto" ? "auto" : undefined,
    automaticNutrition:
      raw?.automaticNutrition && typeof raw.automaticNutrition === "object"
        ? {
            calories: Number(raw.automaticNutrition.calories) || 0,
            protein: Number(raw.automaticNutrition.protein) || 0,
            carbs: Number(raw.automaticNutrition.carbs) || 0,
            fat: Number(raw.automaticNutrition.fat) || 0,
          }
        : undefined,
    ingredients: Array.isArray(raw?.ingredients)
      ? raw.ingredients
          .filter((item: any) => item && typeof item === "object")
          .map((item: any) => ({
            name: typeof item.name === "string" ? item.name : "",
            quantity: typeof item.quantity === "string" ? item.quantity : String(item.quantity ?? ""),
            unit: typeof item.unit === "string" ? item.unit : "",
          }))
      : undefined,
    updatedAt: toTimestamp(raw?.updatedAt ?? raw?.createdAt),
    schemaVersion:
      typeof raw?.schemaVersion === "number" && Number.isFinite(raw.schemaVersion)
        ? raw.schemaVersion
        : SCHEMA_VERSION,
    isDeleted: raw?.isDeleted === true,
  };
}

function toLegacyMeals(items: LocalEntity<MyDayMealDoc>[]) {
  return items
    .map((item) => item.data)
    .filter((item) => item && item.isDeleted !== true)
    .map(({ updatedAt, schemaVersion, isDeleted, ...rest }) => rest)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export class MyDayMealsSync {
  async getLocalMeals(): Promise<LocalEntity<MyDayMealDoc>[]> {
    let base: LocalEntity<MyDayMealDoc>[] = [];
    try {
      const syncRaw = await AsyncStorage.getItem(SYNC_KEY);
      if (syncRaw) {
        const parsed = JSON.parse(syncRaw);
        if (Array.isArray(parsed)) {
          base = parsed.map((item: any) => ({
            id: String(item?.id ?? item?.data?.id ?? ""),
            data: normalizeMealDoc(item?.data ?? item),
            sync: {
              dirty: item?.sync?.dirty === true,
              lastSyncedAt:
                typeof item?.sync?.lastSyncedAt === "number" ? item.sync.lastSyncedAt : null,
            },
          }));
        }
      }
    } catch (err) {
      console.warn("[MyDayMealsSync] failed to parse sync meals", err);
      base = [];
    }

    try {
      const legacyRaw = await AsyncStorage.getItem(LEGACY_KEY);
      if (!legacyRaw) return base;
      const legacyParsed = JSON.parse(legacyRaw);
      if (!Array.isArray(legacyParsed)) return base;

      const baseMap = new Map(base.map((item) => [item.id, item]));
      let changed = false;

      for (const raw of legacyParsed) {
        const normalized = normalizeMealDoc(raw);
        if (!normalized.id) continue;
        const existing = baseMap.get(normalized.id);
        if (!existing) {
          baseMap.set(normalized.id, {
            id: normalized.id,
            data: normalized,
            sync: { dirty: true, lastSyncedAt: null },
          });
          changed = true;
          continue;
        }

        if (normalized.updatedAt > (existing.data.updatedAt ?? 0)) {
          baseMap.set(normalized.id, {
            id: normalized.id,
            data: normalized,
            sync: {
              dirty: true,
              lastSyncedAt: existing.sync.lastSyncedAt ?? null,
            },
          });
          changed = true;
        }
      }

      const merged = Array.from(baseMap.values());
      if (changed) {
        await this.setLocalMeals(merged);
      }
      return merged;
    } catch {
      return base;
    }
  }

  async setLocalMeals(items: LocalEntity<MyDayMealDoc>[]): Promise<void> {
    await AsyncStorage.setItem(SYNC_KEY, JSON.stringify(items));
    await AsyncStorage.setItem(LEGACY_KEY, JSON.stringify(toLegacyMeals(items)));
  }

  async pullFromRemote(uid: string): Promise<void> {
    if (!uid) return;
    const local = await this.getLocalMeals();
    let remoteItems: MyDayMealDoc[] = [];

    try {
      const res = await fetch(`${API_BASE_URL}/sync/myday/meals/pull`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await getAuthHeaders()),
        },
        body: JSON.stringify({ uid }),
      });
      if (!res.ok) {
        console.warn("[MyDayMealsSync] pullFromRemote non-200", res.status);
      } else {
        const json = await res.json().catch(() => null);
        if (Array.isArray(json?.items)) {
          remoteItems = json.items.map((item: any) => normalizeMealDoc(item));
        }
      }
    } catch (err) {
      console.warn("[MyDayMealsSync] pullFromRemote error", err);
    }

    const localMap = new Map(local.map((item) => [item.id, item]));
    const remoteMap = new Map(remoteItems.map((item) => [item.id, item]));
    const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
    const merged: LocalEntity<MyDayMealDoc>[] = [];

    for (const id of allIds) {
      const localItem = localMap.get(id) || null;
      const remoteItem = remoteMap.get(id) || null;
      const { winner, merged: mergedData } = resolveByUpdatedAt(localItem, remoteItem);
      if (winner === "none" || !mergedData) continue;
      let syncMeta;
      if (!localItem && remoteItem) {
        syncMeta = { dirty: false, lastSyncedAt: Date.now() };
      } else if (localItem && !remoteItem) {
        syncMeta = {
          dirty: localItem.sync?.dirty ?? true,
          lastSyncedAt: localItem.sync?.lastSyncedAt ?? null,
        };
      } else if (winner === "remote") {
        syncMeta = { dirty: false, lastSyncedAt: Date.now() };
      } else {
        syncMeta = {
          dirty: localItem?.sync?.dirty ?? true,
          lastSyncedAt: localItem?.sync?.lastSyncedAt ?? null,
        };
      }
      merged.push({ id, data: mergedData as MyDayMealDoc, sync: syncMeta });
    }

    await this.setLocalMeals(merged);
  }

  async pushToRemote(uid: string): Promise<void> {
    if (!uid) return;
    const local = await this.getLocalMeals();
    const dirtyItems = local.filter((item) => item.sync.dirty);
    if (!dirtyItems.length) return;

    try {
      const res = await fetch(`${API_BASE_URL}/sync/myday/meals/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await getAuthHeaders()),
        },
        body: JSON.stringify({
          uid,
          items: dirtyItems.map((item) => ({
            ...item.data,
            updatedAt: item.data.updatedAt || Date.now(),
          })),
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn("[MyDayMealsSync] pushToRemote non-200", res.status, text);
        return;
      }

      const now = Date.now();
      for (const item of dirtyItems) {
        item.sync.dirty = false;
        item.sync.lastSyncedAt = now;
        item.data.updatedAt = now;
      }
      await this.setLocalMeals(local);
    } catch (err) {
      console.warn("[MyDayMealsSync] pushToRemote error", err);
    }
  }

  async syncAll(uid: string | null): Promise<void> {
    if (!uid) return;
    await this.pullFromRemote(uid);
    await this.pushToRemote(uid);
  }

  async upsertLocalMeal(meal: Partial<MyDayMealDoc> & { id: string }): Promise<void> {
    const local = await this.getLocalMeals();
    const idx = local.findIndex((item) => item.id === meal.id);
    const nextDoc = normalizeMealDoc({
      ...(idx >= 0 ? local[idx].data : {}),
      ...meal,
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    });

    const payload: LocalEntity<MyDayMealDoc> = {
      id: nextDoc.id,
      data: nextDoc,
      sync: {
        dirty: true,
        lastSyncedAt: idx >= 0 ? local[idx].sync.lastSyncedAt ?? null : null,
      },
    };

    if (idx >= 0) local[idx] = payload;
    else local.push(payload);
    await this.setLocalMeals(local);
  }

  async markLocalMealDeleted(id: string): Promise<void> {
    const local = await this.getLocalMeals();
    const idx = local.findIndex((item) => item.id === id);
    if (idx >= 0) {
      local[idx] = {
        ...local[idx],
        data: {
          ...local[idx].data,
          isDeleted: true,
          updatedAt: Date.now(),
          schemaVersion: SCHEMA_VERSION,
        },
        sync: {
          dirty: true,
          lastSyncedAt: local[idx].sync.lastSyncedAt ?? null,
        },
      };
    } else {
      local.push({
        id,
        data: normalizeMealDoc({
          id,
          title: "Meal",
          source: "manual",
          createdAt: new Date().toISOString(),
          dayKey: new Date().toISOString().slice(0, 10),
          calories: 0,
          protein: 0,
          carbs: 0,
          fat: 0,
          isDeleted: true,
          updatedAt: Date.now(),
          schemaVersion: SCHEMA_VERSION,
        }),
        sync: { dirty: true, lastSyncedAt: null },
      });
    }
    await this.setLocalMeals(local);
  }
}
