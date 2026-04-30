import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth } from "../../firebaseConfig";
import { getApiBaseUrl } from "../config/api";
import type { MyDayProfileDoc } from "./types";

const API_BASE_URL = getApiBaseUrl() || "http://10.0.2.2:3000";
const LEGACY_KEY = "myDayProfile";
const SYNC_KEY = "sync_myday_profile";
const META_KEY = "sync_myday_profile_meta";
const SCHEMA_VERSION = 1;

type SyncMeta = {
  dirty: boolean;
  lastSyncedAt: number | null;
  lastSyncedUid: string | null;
};

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

function normalizeProfileDoc(raw: any): MyDayProfileDoc {
  const updatedAt = toTimestamp(raw?.updatedAt);
  const plan =
    raw?.plan && typeof raw.plan === "object"
      ? {
          calories: Number(raw.plan.calories) || 0,
          protein: Number(raw.plan.protein) || 0,
          carbs: Number(raw.plan.carbs) || 0,
          fat: Number(raw.plan.fat) || 0,
        }
      : null;

  return {
    age: typeof raw?.age === "string" ? raw.age : "",
    height: typeof raw?.height === "string" ? raw.height : "",
    heightCm: Number.isFinite(raw?.heightCm) ? Number(raw.heightCm) : null,
    currentWeight: typeof raw?.currentWeight === "string" ? raw.currentWeight : "",
    targetWeight: typeof raw?.targetWeight === "string" ? raw.targetWeight : "",
    currentWeightKg: Number.isFinite(raw?.currentWeightKg) ? Number(raw.currentWeightKg) : null,
    targetWeightKg: Number.isFinite(raw?.targetWeightKg) ? Number(raw.targetWeightKg) : null,
    gender: typeof raw?.gender === "string" ? raw.gender : "",
    goalType: typeof raw?.goalType === "string" ? raw.goalType : "track",
    pace: typeof raw?.pace === "string" ? raw.pace : "balanced",
    plan,
    isCustomizedPlan: raw?.isCustomizedPlan === true,
    updatedAt,
    schemaVersion:
      typeof raw?.schemaVersion === "number" && Number.isFinite(raw.schemaVersion)
        ? raw.schemaVersion
        : SCHEMA_VERSION,
  };
}

function toLegacyProfile(doc: MyDayProfileDoc) {
  return {
    ...doc,
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

export class MyDayProfileSync {
  private async getMeta(): Promise<SyncMeta> {
    try {
      const raw = await AsyncStorage.getItem(META_KEY);
      if (!raw) return { dirty: false, lastSyncedAt: null, lastSyncedUid: null };
      const parsed = JSON.parse(raw);
      return {
        dirty: parsed?.dirty === true,
        lastSyncedAt:
          typeof parsed?.lastSyncedAt === "number" ? parsed.lastSyncedAt : null,
        lastSyncedUid:
          typeof parsed?.lastSyncedUid === "string" ? parsed.lastSyncedUid : null,
      };
    } catch {
      return { dirty: false, lastSyncedAt: null, lastSyncedUid: null };
    }
  }

  private async setMeta(partial: Partial<SyncMeta>) {
    const current = await this.getMeta();
    const next: SyncMeta = {
      dirty: partial.dirty ?? current.dirty,
      lastSyncedAt: partial.lastSyncedAt ?? current.lastSyncedAt,
      lastSyncedUid: partial.lastSyncedUid ?? current.lastSyncedUid,
    };
    await AsyncStorage.setItem(META_KEY, JSON.stringify(next));
  }

  async getLocalProfile(): Promise<MyDayProfileDoc | null> {
    let base: MyDayProfileDoc | null = null;

    try {
      const syncRaw = await AsyncStorage.getItem(SYNC_KEY);
      if (syncRaw) {
        base = normalizeProfileDoc(JSON.parse(syncRaw));
      }
    } catch (err) {
      console.warn("[MyDayProfileSync] failed to parse sync profile", err);
      base = null;
    }

    try {
      const legacyRaw = await AsyncStorage.getItem(LEGACY_KEY);
      if (!legacyRaw) return base;
      const legacy = normalizeProfileDoc(JSON.parse(legacyRaw));

      if (!base) {
        await this.setLocalProfile(legacy);
        await this.setMeta({ dirty: true });
        return legacy;
      }

      if (legacy.updatedAt > base.updatedAt) {
        await this.setLocalProfile(legacy);
        await this.setMeta({ dirty: true });
        return legacy;
      }

      return base;
    } catch {
      return base;
    }
  }

  async setLocalProfile(profile: MyDayProfileDoc): Promise<void> {
    const normalized = normalizeProfileDoc(profile);
    await AsyncStorage.setItem(SYNC_KEY, JSON.stringify(normalized));
    await AsyncStorage.setItem(LEGACY_KEY, JSON.stringify(toLegacyProfile(normalized)));
  }

  async pullFromRemote(uid: string): Promise<void> {
    if (!uid) return;

    const headers = {
      "Content-Type": "application/json",
      ...(await getAuthHeaders()),
    };

    try {
      const res = await fetch(`${API_BASE_URL}/sync/myday/profile`, {
        method: "GET",
        headers,
      });

      if (!res.ok) {
        console.warn("[MyDayProfileSync] pullFromRemote non-200", res.status);
        return;
      }

      const payload = (await res.json().catch(() => null)) as any;
      const remote = payload?.doc ? normalizeProfileDoc(payload.doc) : null;
      const local = await this.getLocalProfile();

      if (!remote) {
        if (local) await this.setMeta({ dirty: true });
        return;
      }

      if (!local || remote.updatedAt >= local.updatedAt) {
        await this.setLocalProfile(remote);
        await this.setMeta({ dirty: false, lastSyncedUid: uid });
      } else {
        await this.setMeta({ dirty: true, lastSyncedUid: uid });
      }
    } catch (err) {
      console.warn("[MyDayProfileSync] pullFromRemote error", err);
    }
  }

  async pushToRemote(uid: string): Promise<void> {
    if (!uid) return;
    const local = await this.getLocalProfile();
    if (!local) return;

    const meta = await this.getMeta();
    const uidChanged = !!meta.lastSyncedUid && meta.lastSyncedUid !== uid;
    if (!meta.dirty && !uidChanged) return;

    const headers = {
      "Content-Type": "application/json",
      ...(await getAuthHeaders()),
    };

    try {
      const res = await fetch(`${API_BASE_URL}/sync/myday/profile`, {
        method: "POST",
        headers,
        body: JSON.stringify({ uid, doc: local }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn("[MyDayProfileSync] pushToRemote non-200", res.status, text);
        return;
      }

      await this.setMeta({
        dirty: false,
        lastSyncedAt: Date.now(),
        lastSyncedUid: uid,
      });
    } catch (err) {
      console.warn("[MyDayProfileSync] pushToRemote error", err);
    }
  }

  async syncAll(uid: string | null): Promise<void> {
    if (!uid) return;
    await this.pullFromRemote(uid);
    await this.pushToRemote(uid);
  }

  async upsertLocalProfile(profile: Partial<MyDayProfileDoc> | MyDayProfileDoc): Promise<void> {
    const current = (await this.getLocalProfile()) ?? normalizeProfileDoc({});
    const next = normalizeProfileDoc({
      ...current,
      ...profile,
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    });
    await this.setLocalProfile(next);
    await this.setMeta({ dirty: true });
  }
}
