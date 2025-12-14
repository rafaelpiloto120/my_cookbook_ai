// lib/sync/CookbookSync.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth } from "../../firebaseConfig";
import type { CookbookDoc, LocalEntity } from "./types";
import { resolveByUpdatedAt } from "./conflictStrategy";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || "http://10.0.2.2:3000";


const AS_KEY_COOKBOOKS = "sync_cookbooks";

function normalizeImageUrl(input: any): string | null {
  const v = input?.imageUrl ?? input?.image ?? null;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function normalizeCookbookDoc(raw: any, fallbackNow: number): CookbookDoc {
  const id = String(raw?.id ?? "");
  const createdAt = typeof raw?.createdAt === "number" ? raw.createdAt : fallbackNow;
  const updatedAt = typeof raw?.updatedAt === "number" ? raw.updatedAt : createdAt;

  return {
    ...(raw as Partial<CookbookDoc>),
    id,
    name: raw?.name ?? "",
    imageUrl: normalizeImageUrl(raw),
    createdAt,
    updatedAt,
    isDeleted: raw?.isDeleted ?? false,
  };
}

function stableComparableFields(doc: CookbookDoc) {
  return {
    id: doc.id,
    name: doc.name ?? "",
    imageUrl: doc.imageUrl ?? null,
    isDeleted: doc.isDeleted ?? false,
    createdAt: typeof doc.createdAt === "number" ? doc.createdAt : null,
    updatedAt: typeof doc.updatedAt === "number" ? doc.updatedAt : null,
  };
}

export class CookbookSync {
  /**
   * Full sync entry point used by SyncEngine.
   * Pulls from Firestore then pushes local dirty changes.
   */
  async syncAll(): Promise<void> {
    const user = auth.currentUser;
    const uid = user?.uid ?? null;

    if (!uid) {
      console.log("[CookbookSync] No authenticated user; skipping remote sync");
      return;
    }

    console.log("[CookbookSync] Syncing cookbooks for uid", uid);

    // 1) Pull remote and merge into local
    await this.pullFromRemote(uid);

    // 2) Push any local dirty changes back to remote
    await this.pushToRemote(uid);
  }

  /**
   * Load all local cookbooks from AsyncStorage.
   *
   * Priority:
   *  - Preferred: AS_KEY_COOKBOOKS ("sync_cookbooks") – canonical LocalEntity[] store
   *  - Also reads legacy "cookbooks" snapshot (used by UI screens like History.tsx)
   *
   * This ensures that:
   *  - new cookbooks created only in the legacy snapshot become dirty LocalEntity items
   *  - removed cookbooks in the snapshot are marked as deleted + dirty
   *  - we still support a one-time migration when only the legacy key exists
   */
  async getLocalCookbooks(): Promise<LocalEntity<CookbookDoc>[]> {
    // 1) Load the new-format local store first
    const raw = await AsyncStorage.getItem(AS_KEY_COOKBOOKS);
    let base: LocalEntity<CookbookDoc>[] | null = null;

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          base = parsed.map((item: any) => ({
            id: item.id,
            data: {
              ...(item.data ?? {}),
              imageUrl: normalizeImageUrl(item.data),
            },
            sync: {
              dirty: item.sync?.dirty ?? false,
              lastSyncedAt: item.sync?.lastSyncedAt ?? null,
            },
          })) as LocalEntity<CookbookDoc>[];

          console.log(
            "[CookbookSync] Normalized 'sync_cookbooks' into LocalEntity[]",
            { count: base.length }
          );
        } else {
          base = [];
        }
      } catch (err) {
        console.warn(
          "[CookbookSync] Failed to parse 'sync_cookbooks', falling back to legacy 'cookbooks'",
          err
        );
        base = null;
      }
    }

    // 2) Also load the legacy snapshot key used by existing screens
    const legacyRaw = await AsyncStorage.getItem("cookbooks");

    // Case A: no new-format and no legacy data at all
    if (!base && !legacyRaw) {
      console.log(
        "[CookbookSync] No 'sync_cookbooks' or legacy 'cookbooks' found"
      );
      return [];
    }

    // Case B: we don't have a new-format store yet, but we DO have legacy data
    //         => perform a one-time migration (previous behavior).
    if (!base && legacyRaw) {
      try {
        const legacy = JSON.parse(legacyRaw);
        if (!Array.isArray(legacy)) return [];

        const now = Date.now();

        const migrated: LocalEntity<CookbookDoc>[] = legacy.map((c: any) => {
          const data: CookbookDoc = normalizeCookbookDoc(c, now);
          return {
            id: data.id,
            data,
            sync: {
              dirty: true, // all migrated items start dirty so they get pushed
              lastSyncedAt: null,
            },
          };
        });

        console.log(
          "[CookbookSync] rebuilt LocalEntity[] from legacy 'cookbooks'",
          { count: migrated.length }
        );

        await AsyncStorage.setItem(AS_KEY_COOKBOOKS, JSON.stringify(migrated));
        // Also publish legacy snapshot so UI screens remain consistent.
        await this.publishLegacySnapshot(migrated);

        return migrated;
      } catch (err) {
        console.warn(
          "[CookbookSync] failed to migrate legacy cookbooks",
          err
        );
        return [];
      }
    }

    // From here on, we have a new-format store (`base`) and may or may not have a legacy snapshot.
    if (!legacyRaw) {
      // No legacy snapshot to merge; just return the normalized new-format data.
      return base as LocalEntity<CookbookDoc>[];
    }

    // Case C: both new-format and legacy snapshot exist
    //         => merge them so that:
    //            - new items in legacy => created as dirty LocalEntity items
    //            - items present only in base => KEEP (do NOT infer deletion from legacy)
    //              because legacy is a UI cache and may be stale (especially across auth changes)
    //            - items present in both => use the one with the latest updatedAt
    try {
      const legacy = JSON.parse(legacyRaw);
      if (!Array.isArray(legacy)) {
        return base as LocalEntity<CookbookDoc>[];
      }

      const now = Date.now();

      const legacyMap = new Map<string, CookbookDoc>();
      for (const c of legacy) {
        if (!c || typeof c !== "object") continue;
        const anyC: any = c;
        const id: string | undefined = anyC.id;
        if (!id) continue;

        const doc: CookbookDoc = normalizeCookbookDoc(anyC, now);
        legacyMap.set(id, doc);
      }

      const baseMap = new Map<string, LocalEntity<CookbookDoc>>();
      (base as LocalEntity<CookbookDoc>[]).forEach((item) => {
        baseMap.set(item.id, item);
      });

      const merged: LocalEntity<CookbookDoc>[] = [];

      const allIds = new Set<string>([
        ...Array.from(baseMap.keys()),
        ...Array.from(legacyMap.keys()),
      ]);

      allIds.forEach((id) => {
        const baseItem = baseMap.get(id) || null;
        const legacyDoc = legacyMap.get(id) || null;

        if (!baseItem && !legacyDoc) {
          return;
        }

        // New cookbook present only in legacy snapshot
        if (!baseItem && legacyDoc) {
          merged.push({
            id,
            data: legacyDoc,
            sync: {
              dirty: true,
              lastSyncedAt: null,
            },
          });
          return;
        }

        // Cookbook present only in base new-format store.
        // IMPORTANT: Do NOT auto-delete based on absence from the legacy snapshot.
        // The legacy snapshot is a UI cache and can be stale during auth switches
        // (e.g., anonymous -> existing account). Deletions should be explicit
        // (isDeleted=true) and/or recorded by UI actions via SyncEngine.
        if (baseItem && !legacyDoc) {
          merged.push(baseItem);
          return;
        }

        // Both exist => choose the more recent by updatedAt
        const legacyUpdated = legacyDoc!.updatedAt ?? 0;
        const baseUpdated = baseItem!.data.updatedAt ?? 0;

        if (legacyUpdated > baseUpdated) {
          // Legacy snapshot is newer => overwrite data, keep it dirty so it gets pushed.
          merged.push({
            id,
            data: legacyDoc!,
            sync: {
              dirty: true,
              lastSyncedAt: baseItem!.sync.lastSyncedAt ?? null,
            },
          });
        } else {
          // New-format store is equal or newer => keep as-is.
          merged.push(baseItem!);
        }
      });

      // Persist canonical store AND refresh legacy UI snapshot.
      await this.setLocalCookbooks(merged);

      console.log(
        "[CookbookSync] merged 'sync_cookbooks' with legacy 'cookbooks' snapshot",
        {
          legacyCount: legacyMap.size,
          beforeCount: (base as LocalEntity<CookbookDoc>[]).length,
          afterCount: merged.length,
        }
      );

      return merged;
    } catch (err) {
      console.warn(
        "[CookbookSync] failed to merge legacy cookbooks snapshot",
        err
      );
      // Fall back to the best we have: the base new-format store.
      return base as LocalEntity<CookbookDoc>[];
    }
  }

  /**
* Publish canonical sync-store cookbooks into the legacy UI snapshot key.
*
* Many UI screens still read AsyncStorage key "cookbooks".
* During auth switches (anonymous -> existing account) the legacy snapshot can be stale,
* causing the UI to show only anonymous data even though sync-store contains merged data.
*/
  private async publishLegacySnapshot(
    items: LocalEntity<CookbookDoc>[]
  ): Promise<void> {
    try {
      const snapshot = (items || [])
        .map((e) => e?.data)
        .filter(Boolean)
        .map((d) => ({
          ...d,
          imageUrl: normalizeImageUrl(d),
        }))
        .filter((d) => !d.isDeleted);

      await AsyncStorage.setItem("cookbooks", JSON.stringify(snapshot));
    } catch (err) {
      console.warn(
        "[CookbookSync] Failed to publish legacy 'cookbooks' snapshot",
        err
      );
    }
  }

  /**
 * Persist local cookbooks back to AsyncStorage.
 */
  async setLocalCookbooks(items: LocalEntity<CookbookDoc>[]): Promise<void> {
    await AsyncStorage.setItem(AS_KEY_COOKBOOKS, JSON.stringify(items));
    // Keep legacy UI snapshot in sync with the canonical store.
    await this.publishLegacySnapshot(items);
  }

  /**
   * Pull remote cookbooks for a given user via backend.
   * Merge with local using last-write-wins.
   */
  async pullFromRemote(uid: string): Promise<void> {
    if (!uid) return;

    console.log("[CookbookSync] pullFromRemote start", { uid });

    const local = await this.getLocalCookbooks();

    let remoteItems: any[] = [];

    try {
      const resp = await fetch(`${API_BASE_URL}/sync/cookbooks/pull`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uid }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "<no body>");
        console.warn("[CookbookSync] pullFromRemote backend error", {
          uid,
          status: resp.status,
          body: text,
        });
        return;
      }

      const json = await resp.json().catch(() => null);
      if (json && Array.isArray(json.items)) {
        remoteItems = json.items;
      } else {
        console.warn(
          "[CookbookSync] pullFromRemote: invalid payload from backend",
          json
        );
        remoteItems = [];
      }
    } catch (err) {
      console.warn("[CookbookSync] pullFromRemote network error", {
        uid,
        error:
          err instanceof Error
            ? { name: err.name, message: err.message }
            : err,
      });
      return;
    }

    const remoteMap = new Map<string, CookbookDoc>();

    for (const raw of remoteItems) {
      if (!raw || typeof raw !== "object") continue;
      const anyRaw: any = raw;
      const id: string =
        typeof anyRaw.id === "string" && anyRaw.id.trim()
          ? anyRaw.id.trim()
          : typeof anyRaw.docId === "string" && anyRaw.docId.trim()
            ? anyRaw.docId.trim()
            : "";

      if (!id) continue;

      const createdAt =
        typeof anyRaw.createdAt === "number"
          ? anyRaw.createdAt
          : typeof anyRaw.createdAt?.toMillis === "function"
            ? anyRaw.createdAt.toMillis()
            : Date.now();

      const updatedAt =
        typeof anyRaw.updatedAt === "number"
          ? anyRaw.updatedAt
          : typeof anyRaw.updatedAt?.toMillis === "function"
            ? anyRaw.updatedAt.toMillis()
            : createdAt;

      const cooked: CookbookDoc = {
        ...(anyRaw as Partial<CookbookDoc>),
        id,
        name: anyRaw.name ?? "",
        imageUrl: normalizeImageUrl(anyRaw),
        createdAt,
        updatedAt,
        isDeleted: anyRaw.isDeleted ?? false,
      };

      remoteMap.set(id, cooked);
    }

    const localMap = new Map<string, LocalEntity<CookbookDoc>>();
    local.forEach((item) => {
      localMap.set(item.id, item);
    });

    const allIds = new Set<string>([
      ...Array.from(remoteMap.keys()),
      ...Array.from(localMap.keys()),
    ]);

    const merged: LocalEntity<CookbookDoc>[] = [];

    allIds.forEach((id) => {
      const localItem = localMap.get(id) || null;
      const remoteItem = remoteMap.get(id) || null;

      const { winner, merged: mergedData } = resolveByUpdatedAt(
        localItem,
        remoteItem
      );

      if (winner === "none" || !mergedData) return;

      let syncMeta;
      if (!localItem && remoteItem) {
        // Only remote exists
        syncMeta = { lastSyncedAt: Date.now(), dirty: false };
      } else if (localItem && !remoteItem) {
        // Only local exists
        syncMeta = {
          // 🔥 Keep dirty flag if it was dirty before
          dirty: localItem.sync?.dirty ?? true,
          lastSyncedAt: localItem.sync?.lastSyncedAt ?? null,
        };
      } else if (winner === "remote") {
        syncMeta = { lastSyncedAt: Date.now(), dirty: false };
      } else {
        // winner === "local"
        syncMeta = {
          dirty: localItem?.sync?.dirty ?? true,
          lastSyncedAt: localItem?.sync?.lastSyncedAt ?? null,
        };
      }

      merged.push({
        id,
        data: mergedData,
        sync: syncMeta,
      });
    });

    await this.setLocalCookbooks(merged);

    console.log("[CookbookSync] pullFromRemote done", {
      totalLocal: local.length,
      totalRemote: remoteMap.size,
      totalMerged: merged.length,
    });
  }

  /**
   * Push all local "dirty" cookbooks to backend (which writes to Firestore).
   */
  async pushToRemote(uid: string): Promise<void> {
    if (!uid) {
      console.log("[CookbookSync] pushToRemote skipped: no uid");
      return;
    }

    console.log("[CookbookSync] pushToRemote ENTER", { uid });

    try {
      // 1) Load local cookbooks
      const local = await this.getLocalCookbooks();
      console.log("[CookbookSync] pushToRemote loaded local entities", {
        total: local.length,
      });

      const dirtyItems = local.filter((item) => item.sync.dirty);
      console.log("[CookbookSync] pushToRemote dirty items", {
        count: dirtyItems.length,
        ids: dirtyItems.map((i) => i.id),
      });

      if (!dirtyItems.length) {
        console.log(
          "[CookbookSync] pushToRemote nothing to push (no dirty items)"
        );
        return;
      }

      const payloadItems = dirtyItems.map((item) => {
        const { id, data } = item;
        const anyData: any = data || {};
        const now = Date.now();
        const createdAt =
          typeof anyData.createdAt === "number" ? anyData.createdAt : now;

        return {
          id,
          ...anyData,
          imageUrl: normalizeImageUrl(anyData),
          createdAt,
          // Prefer existing updatedAt when present; fallback to now.
          updatedAt: typeof anyData.updatedAt === "number" ? anyData.updatedAt : now,
        };
      });

      try {
        const resp = await fetch(`${API_BASE_URL}/sync/cookbooks/push`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            uid,
            items: payloadItems,
          }),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "<no body>");
          console.warn("[CookbookSync] pushToRemote backend error", {
            uid,
            status: resp.status,
            body: text,
          });
          return;
        }

        const json = await resp.json().catch(() => null);
        console.log("[CookbookSync] pushToRemote backend OK", json);
      } catch (netErr) {
        console.warn("[CookbookSync] pushToRemote network error", {
          uid,
          error:
            netErr instanceof Error
              ? { name: netErr.name, message: netErr.message }
              : netErr,
        });
        return;
      }

      // 3) Mark dirty items as clean locally
      const nowTs = Date.now();
      for (const item of dirtyItems) {
        item.sync.dirty = false;
        item.sync.lastSyncedAt = nowTs;
      }

      await this.setLocalCookbooks(local);
      console.log("[CookbookSync] pushToRemote DONE", {
        pushed: dirtyItems.length,
      });
    } catch (err) {
      console.warn("[CookbookSync] pushToRemote FATAL ERROR", {
        error:
          err instanceof Error
            ? { name: err.name, message: err.message }
            : err,
      });
      throw err;
    }
  }

  /**
   * Helper to mark a local cookbook as modified.
   * Call this from your UI or data layer when user edits a cookbook.
   */
  async upsertLocalCookbook(cookbook: CookbookDoc): Promise<void> {
    const local = await this.getLocalCookbooks();
    const idx = local.findIndex((c) => c.id === cookbook.id);
    const now = Date.now();

    // Normalize incoming doc so sync always relies on `imageUrl`.
    const normalized: CookbookDoc = {
      ...(cookbook as any),
      imageUrl: normalizeImageUrl(cookbook),
      updatedAt: typeof cookbook.updatedAt === "number" ? cookbook.updatedAt : now,
      createdAt: typeof cookbook.createdAt === "number" ? cookbook.createdAt : now,
      isDeleted: (cookbook as any)?.isDeleted ?? false,
    };

    if (idx >= 0) {
      const existing = local[idx];

      // If nothing meaningful changed, do nothing (prevents noisy dirty writes).
      const a = JSON.stringify(stableComparableFields(existing.data));
      const b = JSON.stringify(stableComparableFields(normalized));
      if (a === b) {
        return;
      }

      local[idx] = {
        id: normalized.id,
        data: {
          ...existing.data,
          ...normalized,
          // keep createdAt from existing if it exists
          createdAt:
            typeof existing.data.createdAt === "number"
              ? existing.data.createdAt
              : normalized.createdAt,
        },
        sync: {
          // preserve lastSyncedAt so we can reason about freshness
          lastSyncedAt: existing.sync?.lastSyncedAt ?? null,
          dirty: true,
        },
      };
    } else {
      local.push({
        id: normalized.id,
        data: normalized,
        sync: {
          lastSyncedAt: null,
          dirty: true,
        },
      });
    }

    await this.setLocalCookbooks(local);

    console.log("[CookbookSync] upsertLocalCookbook", {
      id: normalized.id,
      name: normalized.name,
    });
  }
}