import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth } from "../../firebaseConfig";
import { getApiBaseUrl } from "../config/api";
import type { LocalEntity, MyDayWeightLogDoc } from "./types";
import { resolveByUpdatedAt } from "./conflictStrategy";

const API_BASE_URL = getApiBaseUrl() || "http://10.0.2.2:3000";
const LEGACY_KEY = "myDayWeightLogs";
const SYNC_KEY = "sync_myday_weights";
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

function normalizeWeightDoc(raw: any): MyDayWeightLogDoc {
  const createdAt = typeof raw?.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const dayKey = typeof raw?.dayKey === "string" ? raw.dayKey : createdAt.slice(0, 10);
  const normalizedWeightKg =
    Number.isFinite(raw?.normalizedWeightKg) ? Number(raw.normalizedWeightKg) :
    Number.isFinite(raw?.valueKg) ? Number(raw.valueKg) : null;

  return {
    id: String(raw?.id ?? ""),
    createdAt,
    dayKey,
    weight:
      typeof raw?.weight === "string"
        ? raw.weight
        : Number.isFinite(raw?.value)
          ? String(raw.value)
          : "",
    normalizedWeightKg,
    note: typeof raw?.note === "string" ? raw.note : undefined,
    updatedAt: toTimestamp(raw?.updatedAt ?? raw?.createdAt),
    schemaVersion:
      typeof raw?.schemaVersion === "number" && Number.isFinite(raw.schemaVersion)
        ? raw.schemaVersion
        : SCHEMA_VERSION,
    isDeleted: raw?.isDeleted === true,
  };
}

function toLegacyWeights(items: LocalEntity<MyDayWeightLogDoc>[]) {
  return items
    .map((item) => item.data)
    .filter((item) => item && item.isDeleted !== true)
    .map(({ updatedAt, schemaVersion, isDeleted, normalizedWeightKg, weight, ...rest }) => ({
      ...rest,
      value: Number(weight) || 0,
      valueKg: normalizedWeightKg,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export class MyDayWeightSync {
  async getLocalWeights(): Promise<LocalEntity<MyDayWeightLogDoc>[]> {
    let base: LocalEntity<MyDayWeightLogDoc>[] = [];
    try {
      const syncRaw = await AsyncStorage.getItem(SYNC_KEY);
      if (syncRaw) {
        const parsed = JSON.parse(syncRaw);
        if (Array.isArray(parsed)) {
          base = parsed.map((item: any) => ({
            id: String(item?.id ?? item?.data?.id ?? ""),
            data: normalizeWeightDoc(item?.data ?? item),
            sync: {
              dirty: item?.sync?.dirty === true,
              lastSyncedAt:
                typeof item?.sync?.lastSyncedAt === "number" ? item.sync.lastSyncedAt : null,
            },
          }));
        }
      }
    } catch (err) {
      console.warn("[MyDayWeightSync] failed to parse sync weights", err);
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
        const normalized = normalizeWeightDoc(raw);
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
        await this.setLocalWeights(merged);
      }
      return merged;
    } catch {
      return base;
    }
  }

  async setLocalWeights(items: LocalEntity<MyDayWeightLogDoc>[]): Promise<void> {
    await AsyncStorage.setItem(SYNC_KEY, JSON.stringify(items));
    await AsyncStorage.setItem(LEGACY_KEY, JSON.stringify(toLegacyWeights(items)));
  }

  async pullFromRemote(uid: string): Promise<void> {
    if (!uid) return;
    const local = await this.getLocalWeights();
    let remoteItems: MyDayWeightLogDoc[] = [];

    try {
      const res = await fetch(`${API_BASE_URL}/sync/myday/weights/pull`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await getAuthHeaders()),
        },
        body: JSON.stringify({ uid }),
      });
      if (!res.ok) {
        console.warn("[MyDayWeightSync] pullFromRemote non-200", res.status);
      } else {
        const json = await res.json().catch(() => null);
        if (Array.isArray(json?.items)) {
          remoteItems = json.items.map((item: any) => normalizeWeightDoc(item));
        }
      }
    } catch (err) {
      console.warn("[MyDayWeightSync] pullFromRemote error", err);
    }

    const localMap = new Map(local.map((item) => [item.id, item]));
    const remoteMap = new Map(remoteItems.map((item) => [item.id, item]));
    const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
    const merged: LocalEntity<MyDayWeightLogDoc>[] = [];

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
      merged.push({ id, data: mergedData as MyDayWeightLogDoc, sync: syncMeta });
    }

    await this.setLocalWeights(merged);
  }

  async pushToRemote(uid: string): Promise<void> {
    if (!uid) return;
    const local = await this.getLocalWeights();
    const dirtyItems = local.filter((item) => item.sync.dirty);
    if (!dirtyItems.length) return;

    try {
      const res = await fetch(`${API_BASE_URL}/sync/myday/weights/push`, {
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
        console.warn("[MyDayWeightSync] pushToRemote non-200", res.status, text);
        return;
      }

      const now = Date.now();
      for (const item of dirtyItems) {
        item.sync.dirty = false;
        item.sync.lastSyncedAt = now;
        item.data.updatedAt = now;
      }
      await this.setLocalWeights(local);
    } catch (err) {
      console.warn("[MyDayWeightSync] pushToRemote error", err);
    }
  }

  async syncAll(uid: string | null): Promise<void> {
    if (!uid) return;
    await this.pullFromRemote(uid);
    await this.pushToRemote(uid);
  }

  async upsertLocalWeight(log: Partial<MyDayWeightLogDoc> & { id: string }): Promise<void> {
    const local = await this.getLocalWeights();
    const idx = local.findIndex((item) => item.id === log.id);
    const nextDoc = normalizeWeightDoc({
      ...(idx >= 0 ? local[idx].data : {}),
      ...log,
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    });

    const payload: LocalEntity<MyDayWeightLogDoc> = {
      id: nextDoc.id,
      data: nextDoc,
      sync: {
        dirty: true,
        lastSyncedAt: idx >= 0 ? local[idx].sync.lastSyncedAt ?? null : null,
      },
    };

    if (idx >= 0) local[idx] = payload;
    else local.push(payload);
    await this.setLocalWeights(local);
  }

  async markLocalWeightDeleted(id: string): Promise<void> {
    const local = await this.getLocalWeights();
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
    }
    await this.setLocalWeights(local);
  }
}
