// lib/sync/PreferencesSync.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth } from "../../firebaseConfig";
import type { PreferencesDoc } from "./types";

// Canonical AsyncStorage key for locally cached preferences used by the sync engine.
// Legacy keys (dietary, avoid, theme, language, etc.) are migrated into this structure
// by lib/sync/migrations.ts, so from this point on we only read/write via AS_KEY_PREFS.
const AS_KEY_PREFS = "sync_prefs";

// Separate metadata key so we don’t change the existing prefs JSON shape.
const AS_KEY_PREFS_META = "sync_prefs_meta";

type PrefsSyncMeta = {
  dirty: boolean;
  lastSyncedAt: number | null;
  lastSyncedUid: string | null;
};

/**
 * Sync user-level preferences between AsyncStorage and Firestore.
 * Note: this is separate from your existing saveUserPrefs helper,
 * but you can integrate them later.
 */
export class PreferencesSync {
  async getLocalPrefs(): Promise<PreferencesDoc | null> {
    const raw = await AsyncStorage.getItem(AS_KEY_PREFS);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PreferencesDoc;
    } catch {
      return null;
    }
  }

  async setLocalPrefs(prefs: PreferencesDoc): Promise<void> {
    await AsyncStorage.setItem(AS_KEY_PREFS, JSON.stringify(prefs));
    // Dirtiness is handled elsewhere.
  }

  private async getMeta(): Promise<PrefsSyncMeta> {
    const raw = await AsyncStorage.getItem(AS_KEY_PREFS_META);
    if (!raw) return { dirty: false, lastSyncedAt: null, lastSyncedUid: null };
    try {
      const parsed = JSON.parse(raw);
      return {
        dirty: !!parsed?.dirty,
        lastSyncedAt:
          typeof parsed?.lastSyncedAt === "number" ? parsed.lastSyncedAt : null,
        lastSyncedUid:
          typeof parsed?.lastSyncedUid === "string" ? parsed.lastSyncedUid : null,
      };
    } catch {
      return { dirty: false, lastSyncedAt: null, lastSyncedUid: null };
    }
  }

  private async setMeta(meta: Partial<PrefsSyncMeta>): Promise<void> {
    const current = await this.getMeta();
    const next: PrefsSyncMeta = {
      dirty: meta.dirty ?? current.dirty,
      lastSyncedAt: meta.lastSyncedAt ?? current.lastSyncedAt,
      lastSyncedUid: meta.lastSyncedUid ?? current.lastSyncedUid,
    };
    await AsyncStorage.setItem(AS_KEY_PREFS_META, JSON.stringify(next));
  }

  async pullFromRemote(uid: string): Promise<void> {
    if (!uid) return;

    const user = auth.currentUser;
    if (!user || user.uid !== uid) {
      console.log("[PreferencesSync] pullFromRemote skipped: no auth user or uid mismatch", {
        requestedUid: uid,
        currentUid: user?.uid,
      });
      return;
    }

    console.log("[PreferencesSync] pullFromRemote for uid", uid);

    const apiBase = process.env.EXPO_PUBLIC_API_URL;
    if (!apiBase) {
      console.log("[PreferencesSync] pullFromRemote skipped: EXPO_PUBLIC_API_URL not set");
      return;
    }

    let idToken: string;
    try {
      idToken = await user.getIdToken();
    } catch (err) {
      console.warn("[PreferencesSync] pullFromRemote getIdToken failed", err);
      return;
    }

    try {
      const res = await fetch(`${apiBase}/sync/preferences`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });

      if (!res.ok) {
        console.warn(
          "[PreferencesSync] pullFromRemote non-200 response",
          res.status
        );
        return;
      }

      const payload = (await res.json().catch(() => null)) as any;
      if (!payload || !payload.doc) {
        // No remote prefs yet → keep local as-is.
        // If we already have local prefs, make sure they can be pushed for this uid
        // (important when switching from anonymous -> existing account).
        const local = await this.getLocalPrefs();
        if (local) {
          await this.setMeta({ dirty: true });
        }
        return;
      }

      const data = payload.doc as any;

      const allowedThemeModes: Array<PreferencesDoc["themeMode"]> = [
        "light",
        "dark",
        "system",
      ];

      const remote: PreferencesDoc = {
        userDietary: Array.isArray(data.userDietary) ? data.userDietary : [],
        userAvoid: Array.isArray(data.userAvoid) ? data.userAvoid : [],
        userAvoidOther:
          typeof data.userAvoidOther === "string" ? data.userAvoidOther : "",
        userMeasurement:
          data.userMeasurement === "imperial" ? "imperial" : "metric",
        themeMode: allowedThemeModes.includes(data.themeMode)
          ? data.themeMode
          : "light",
        userLanguage:
          typeof data.userLanguage === "string" ? data.userLanguage : "en",
        updatedAt:
          typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
      };

      const local = await this.getLocalPrefs();

      // If no local prefs, or remote is newer, override
      if (!local || remote.updatedAt >= (local.updatedAt ?? 0)) {
        await this.setLocalPrefs(remote);
        // Remote won – ensure we don't immediately re-push the same data.
        await this.setMeta({ dirty: false });
      } else {
        // Local is newer → keep local.
        // IMPORTANT: when switching accounts, local may have been previously synced
        // for a different uid (dirty=false), so force it dirty so it gets pushed.
        await this.setMeta({ dirty: true });
      }
    } catch (err) {
      console.warn("[PreferencesSync] pullFromRemote error", err);
    }
  }

  async pushToRemote(uid: string): Promise<void> {
    if (!uid) return;

    const user = auth.currentUser;
    if (!user || user.uid !== uid) {
      console.log("[PreferencesSync] pushToRemote skipped: no auth user or uid mismatch", {
        requestedUid: uid,
        currentUid: user?.uid,
      });
      return;
    }

    console.log("[PreferencesSync] pushToRemote for uid", uid);

    const prefs = await this.getLocalPrefs();
    if (!prefs) {
      console.log("[PreferencesSync] pushToRemote skipped: no local prefs");
      return;
    }

    const meta = await this.getMeta();
    const uidChanged = !!meta.lastSyncedUid && meta.lastSyncedUid !== uid;
    if (!meta.dirty && !uidChanged) {
      // Nothing changed locally since last successful push for this uid.
      return;
    }

    const apiBase = process.env.EXPO_PUBLIC_API_URL;
    if (!apiBase) {
      console.log("[PreferencesSync] pushToRemote skipped: EXPO_PUBLIC_API_URL not set");
      return;
    }

    let idToken: string;
    try {
      idToken = await user.getIdToken();
    } catch (err) {
      console.warn("[PreferencesSync] pushToRemote getIdToken failed", err);
      return;
    }

    const payloadToSend = {
      ...prefs,
      updatedAt: prefs.updatedAt ?? Date.now(),
    };

    try {
      const res = await fetch(`${apiBase}/sync/preferences`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ doc: payloadToSend }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(
          "[PreferencesSync] pushToRemote non-200 response",
          res.status,
          text
        );
        return;
      }

      console.log("[PreferencesSync] pushToRemote success for uid", uid);
      await this.setMeta({ dirty: false, lastSyncedAt: Date.now(), lastSyncedUid: uid });
    } catch (err) {
      console.warn("[PreferencesSync] pushToRemote error", err);
    }
  }

  /**
   * Full sync for preferences (pull + push).
   * Called by SyncEngine.
   */
  async syncAll(forcedUid?: string): Promise<void> {
    const user = auth.currentUser;
    const uid = forcedUid ?? user?.uid ?? null;

    if (!uid) {
      console.log("[PreferencesSync] syncAll skipped: no uid");
      return;
    }

    // If a uid was provided but it doesn't match the current auth user, skip.
    if (user?.uid && user.uid !== uid) {
      console.log("[PreferencesSync] syncAll skipped: uid mismatch", {
        requestedUid: uid,
        currentUid: user.uid,
      });
      return;
    }

    console.log("[PreferencesSync] syncAll start", { uid });
    const meta = await this.getMeta();
    console.log("[PreferencesSync] meta", meta);

    try {
      // 1) Pull remote → merge into local
      await this.pullFromRemote(uid);
      // 2) Push any dirty local changes back to remote
      await this.pushToRemote(uid);

      console.log("[PreferencesSync] syncAll done", { uid });
    } catch (err) {
      console.warn("[PreferencesSync] syncAll error", { uid, err });
      throw err;
    }
  }

  /**
   * Helper to update local prefs and mark updatedAt.
   * Call this when user changes preferences in Profile.
   */
  async updateLocalPrefs(partial: Partial<PreferencesDoc>): Promise<void> {
    const current = (await this.getLocalPrefs()) || {
      userDietary: [],
      userAvoid: [],
      userAvoidOther: "",
      userMeasurement: "metric" as const,
      themeMode: "light" as const,
      userLanguage: "en",
      updatedAt: 0,
    };

    const next: PreferencesDoc = {
      ...current,
      ...partial,
      updatedAt: Date.now(),
    };

    await this.setLocalPrefs(next);
    await this.setMeta({ dirty: true });
    console.log("[PreferencesSync] updateLocalPrefs", {
      updatedAt: next.updatedAt,
      keys: Object.keys(partial),
    });
  }

  /**
   * Backwards-compatible name used by SyncEngine.markPreferencesDirty.
   * Accepts either a full PreferencesDoc or a partial.
   */
  async upsertLocalPreferences(input: Partial<PreferencesDoc> | PreferencesDoc): Promise<void> {
    // If the caller provided a full doc, keep it but always bump updatedAt.
    const partial: Partial<PreferencesDoc> = { ...(input as any) };
    // Avoid accidentally persisting undefined over existing values
    Object.keys(partial).forEach((k) => {
      if ((partial as any)[k] === undefined) delete (partial as any)[k];
    });

    await this.updateLocalPrefs(partial);
  }

  /**
   * Older alias that some code paths may still call.
   */
  async saveLocalPreferences(input: Partial<PreferencesDoc> | PreferencesDoc): Promise<void> {
    await this.upsertLocalPreferences(input);
  }
}