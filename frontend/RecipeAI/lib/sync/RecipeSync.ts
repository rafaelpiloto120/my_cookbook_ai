// lib/sync/RecipeSync.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RecipeDoc, LocalEntity } from "./types";
import { resolveByUpdatedAt } from "./conflictStrategy";

const AS_KEY_RECIPES = "sync_recipes";
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || "http://10.0.2.2:3000";

export class RecipeSync {
  /**
   * Local helpers
   */
  async getLocalRecipes(): Promise<LocalEntity<RecipeDoc>[]> {
    // 1) Load the new structured store first (sync_recipes)
    const raw = await AsyncStorage.getItem(AS_KEY_RECIPES);
    let base: LocalEntity<RecipeDoc>[] | null = null;

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          base = parsed.map((item: any) => {
            const data: RecipeDoc =
              item.data && typeof item.data === "object" ? item.data : (item as RecipeDoc);

            return {
              id: item.id || data.id,
              data,
              sync: {
                dirty: item.sync?.dirty ?? false,
                lastSyncedAt:
                  typeof item.sync?.lastSyncedAt === "number" ? item.sync.lastSyncedAt : null,
              },
            } as LocalEntity<RecipeDoc>;
          });

          console.log("[RecipeSync] Normalized 'sync_recipes' into LocalEntity[]", {
            count: base.length,
          });
        } else {
          base = [];
        }
      } catch (err) {
        console.warn(
          "[RecipeSync] failed to parse 'sync_recipes', falling back to legacy 'recipes'",
          err
        );
        base = null;
      }
    }

    // 2) Also load the legacy snapshot key used by UI screens
    const legacyRaw = await AsyncStorage.getItem("recipes");

    // Case A: no structured store and no legacy snapshot
    if (!base && !legacyRaw) {
      return [];
    }

    // Helper: normalize a legacy snapshot recipe into a RecipeDoc
    const toRecipeDoc = (r: any, now: number): RecipeDoc => {
      const createdAt = typeof r?.createdAt === "number" ? r.createdAt : now;
      const updatedAt = typeof r?.updatedAt === "number" ? r.updatedAt : createdAt;

      return {
        ...(r as Partial<RecipeDoc>),
        id: r.id,
        title: r.title ?? "",
        imageUrl: r.imageUrl ?? null,
        createdAt,
        updatedAt,
        cookingTimeMinutes:
          typeof r.cookingTimeMinutes === "number"
            ? r.cookingTimeMinutes
            : typeof r.totalMinutes === "number"
            ? r.totalMinutes
            : null,
        difficulty: r.difficulty ?? "easy",
        servings: typeof r.servings === "number" ? r.servings : null,
        cost: r.cost ?? null,
        ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
        steps: Array.isArray(r.steps)
          ? r.steps
          : Array.isArray(r.instructions)
          ? r.instructions
          : [],
        cookbookIds: Array.isArray(r.cookbookIds) ? r.cookbookIds : [],
        tags: Array.isArray(r.tags) ? r.tags : [],
        isDeleted: r.isDeleted ?? false,
      };
    };

    // Case B: no structured store yet, but legacy snapshot exists => one-time migration
    if (!base && legacyRaw) {
      try {
        const legacy = JSON.parse(legacyRaw);
        if (!Array.isArray(legacy)) return [];

        const now = Date.now();

        const migrated: LocalEntity<RecipeDoc>[] = legacy
          .filter((r: any) => r && typeof r === "object" && r.id)
          .map((r: any) => {
            const data = toRecipeDoc(r, now);
            return {
              id: data.id,
              data,
              sync: {
                dirty: true,
                lastSyncedAt: null,
              },
            } as LocalEntity<RecipeDoc>;
          });

        await AsyncStorage.setItem(AS_KEY_RECIPES, JSON.stringify(migrated));

        console.log("[RecipeSync] rebuilt LocalEntity[] from legacy 'recipes'", {
          count: migrated.length,
        });

        return migrated;
      } catch (err) {
        console.warn("[RecipeSync] failed to read legacy 'recipes' key", err);
        return [];
      }
    }

    // From here on we have `base` (structured store) and may/may not have a legacy snapshot.
    if (!legacyRaw) {
      return base as LocalEntity<RecipeDoc>[];
    }

    // Case C: both structured store and legacy snapshot exist => merge so deletes are detected
    try {
      const legacy = JSON.parse(legacyRaw);
      if (!Array.isArray(legacy)) {
        return base as LocalEntity<RecipeDoc>[];
      }

      const now = Date.now();

      const legacyMap = new Map<string, RecipeDoc>();
      for (const r of legacy) {
        if (!r || typeof r !== "object") continue;
        const id: string | undefined = (r as any).id;
        if (!id) continue;
        legacyMap.set(id, toRecipeDoc(r, now));
      }

      const baseMap = new Map<string, LocalEntity<RecipeDoc>>();
      (base as LocalEntity<RecipeDoc>[]).forEach((item) => {
        baseMap.set(item.id, item);
      });

      const allIds = new Set<string>([
        ...Array.from(baseMap.keys()),
        ...Array.from(legacyMap.keys()),
      ]);

      const merged: LocalEntity<RecipeDoc>[] = [];

      allIds.forEach((id) => {
        const baseItem = baseMap.get(id) || null;
        const legacyDoc = legacyMap.get(id) || null;

        if (!baseItem && !legacyDoc) return;

        // New recipe present only in legacy snapshot => add as dirty
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

        // Present only in structured store but missing from legacy snapshot.
        // IMPORTANT: The legacy "recipes" key is a UI snapshot/cache and may be stale,
        // especially around auth transitions. Do NOT infer deletion from absence.
        // Keep the structured-store item as-is.
        if (baseItem && !legacyDoc) {
          merged.push(baseItem);
          return;
        }

        // Both exist => ensure deletes always win, otherwise pick the newest by updatedAt
        const legacyIsDeleted = legacyDoc!.isDeleted === true;
        const baseIsDeleted = baseItem!.data?.isDeleted === true;

        // If the legacy snapshot indicates deletion but the structured store does not,
        // prefer the legacy deletion even if timestamps are equal/older (defensive).
        if (legacyIsDeleted && !baseIsDeleted) {
          merged.push({
            id,
            data: {
              ...baseItem!.data,
              ...legacyDoc!,
              isDeleted: true,
              updatedAt: Math.max(legacyDoc!.updatedAt ?? 0, baseItem!.data.updatedAt ?? 0, now),
            },
            sync: {
              dirty: true,
              lastSyncedAt: baseItem!.sync.lastSyncedAt ?? null,
            },
          });
          return;
        }

        // If structured store indicates deletion but legacy does not, keep the deletion.
        // (This can happen if the UI hasn't updated the legacy snapshot yet.)
        if (baseIsDeleted && !legacyIsDeleted) {
          merged.push({
            id,
            data: {
              ...baseItem!.data,
              isDeleted: true,
              updatedAt: Math.max(baseItem!.data.updatedAt ?? 0, now),
            },
            sync: {
              dirty: baseItem!.sync?.dirty ?? true,
              lastSyncedAt: baseItem!.sync.lastSyncedAt ?? null,
            },
          });
          return;
        }

        const legacyUpdated = legacyDoc!.updatedAt ?? 0;
        const baseUpdated = baseItem!.data.updatedAt ?? 0;

        if (legacyUpdated > baseUpdated) {
          merged.push({
            id,
            data: legacyDoc!,
            sync: {
              dirty: true,
              lastSyncedAt: baseItem!.sync.lastSyncedAt ?? null,
            },
          });
        } else {
          merged.push(baseItem!);
        }
      });

      await AsyncStorage.setItem(AS_KEY_RECIPES, JSON.stringify(merged));

      console.log("[RecipeSync] merged 'sync_recipes' with legacy 'recipes' snapshot", {
        legacyCount: legacyMap.size,
        beforeCount: (base as LocalEntity<RecipeDoc>[]).length,
        afterCount: merged.length,
      });

      return merged;
    } catch (err) {
      console.warn("[RecipeSync] failed to merge legacy recipes snapshot", err);
      return base as LocalEntity<RecipeDoc>[];
    }
  }

  async setLocalRecipes(items: LocalEntity<RecipeDoc>[]): Promise<void> {
    await AsyncStorage.setItem(AS_KEY_RECIPES, JSON.stringify(items));
  }

  /**
   * Full sync for recipes (pull + push).
   * Called by SyncEngine.
   */
  async syncAll(uid: string | null): Promise<void> {
    if (!uid) {
      console.log("[RecipeSync] syncAll skipped: no uid");
      return;
    }

    console.log("[RecipeSync] syncAll start", { uid });

    try {
      // 1) Pull remote → merge into local
      await this.pullFromRemote(uid);
      // 2) Push any dirty local changes back to remote
      await this.pushToRemote(uid);

      console.log("[RecipeSync] syncAll done", { uid });
    } catch (err) {
      console.warn("[RecipeSync] syncAll error", { uid, err });
      throw err;
    }
  }

  /**
   * Pull from backend → merge with local via conflictStrategy
   * IMPORTANT: preserve `dirty` for local winners and local-only recipes.
   */
  async pullFromRemote(uid: string): Promise<void> {
    if (!uid) {
      console.log("[RecipeSync] Skipping pullFromRemote: no uid");
      return;
    }

    console.log("[RecipeSync] pullFromRemote start", { uid });

    const local = await this.getLocalRecipes();

    let items: any[] = [];
    try {
      const res = await fetch(`${API_BASE_URL}/sync/recipes/pull`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uid }),
      });

      if (!res.ok) {
        console.warn("[RecipeSync] pullFromRemote backend error", {
          status: res.status,
          statusText: res.statusText,
        });
      } else {
        const json = await res.json().catch(() => null);
        if (json && Array.isArray(json.items)) {
          items = json.items;
        }
      }
    } catch (err) {
      console.warn("[RecipeSync] pullFromRemote exception", { uid, err });
      // We still merge local-only items below, so don't early-return.
    }

    const remoteMap = new Map<string, RecipeDoc>();

    for (const raw of items) {
      if (!raw) continue;

      // Support both `{ id, ...fields }` and `{ id, data: {...} }`
      const base = raw.data && typeof raw.data === "object" ? raw.data : raw;
      const id =
        (typeof raw.id === "string" && raw.id) ||
        (typeof (base as any).id === "string" && (base as any).id) ||
        undefined;

      if (!id) continue;

      const createdAtRaw = (base as any).createdAt;
      const updatedAtRaw = (base as any).updatedAt;

      const createdAt =
        typeof createdAtRaw === "number"
          ? createdAtRaw
          : typeof createdAtRaw === "string"
          ? Number(createdAtRaw) || Date.now()
          : Date.now();

      const updatedAt =
        typeof updatedAtRaw === "number"
          ? updatedAtRaw
          : typeof updatedAtRaw === "string"
          ? Number(updatedAtRaw) || createdAt
          : createdAt;

      const cooked: RecipeDoc = {
        ...(base as Partial<RecipeDoc>),
        id,
        title: (base as any).title ?? "",
        imageUrl: (base as any).imageUrl ?? null,
        createdAt,
        updatedAt,
        cookingTimeMinutes:
          typeof (base as any).cookingTimeMinutes === "number"
            ? (base as any).cookingTimeMinutes
            : null,
        difficulty: (base as any).difficulty ?? "unknown",
        servings: typeof (base as any).servings === "number" ? (base as any).servings : null,
        cost: (base as any).cost ?? "unknown",
        ingredients: Array.isArray((base as any).ingredients) ? (base as any).ingredients : [],
        steps: Array.isArray((base as any).steps) ? (base as any).steps : [],
        cookbookIds: Array.isArray((base as any).cookbookIds) ? (base as any).cookbookIds : [],
        tags: Array.isArray((base as any).tags) ? (base as any).tags : [],
        isDeleted: (base as any).isDeleted ?? false,
      };

      remoteMap.set(id, cooked);
    }

    const localMap = new Map<string, LocalEntity<RecipeDoc>>();
    local.forEach((item) => {
      localMap.set(item.id, item);
    });

    const allIds = new Set<string>([
      ...Array.from(remoteMap.keys()),
      ...Array.from(localMap.keys()),
    ]);

    const merged: LocalEntity<RecipeDoc>[] = [];

    allIds.forEach((id) => {
      const localItem = localMap.get(id) || null;
      const remoteItem = remoteMap.get(id) || null;

      const { winner, merged: mergedData } = resolveByUpdatedAt(localItem, remoteItem);

      if (winner === "none" || !mergedData) return;

      let syncMeta;
      if (!localItem && remoteItem) {
        // Only remote exists → clean
        syncMeta = { lastSyncedAt: Date.now(), dirty: false };
      } else if (localItem && !remoteItem) {
        // Only local exists → keep it dirty so it will be retried until server has it
        syncMeta = {
          dirty: localItem.sync?.dirty ?? true,
          lastSyncedAt: localItem.sync?.lastSyncedAt ?? null,
        };
      } else if (winner === "remote") {
        // Remote wins → clean
        syncMeta = { lastSyncedAt: Date.now(), dirty: false };
      } else {
        // winner === "local" → keep whatever local thought about dirtiness
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

    await this.setLocalRecipes(merged);
    console.log("[RecipeSync] pullFromRemote done", {
      totalRemote: remoteMap.size,
      totalLocal: local.length,
      totalMerged: merged.length,
    });
  }

  /**
   * Push dirty local recipes → backend (which writes to Firestore)
   */
  async pushToRemote(uid: string): Promise<void> {
    console.log("[RecipeSync] pushToRemote CALLED", { uid });
    if (!uid) {
      console.log("[RecipeSync] Skipping pushToRemote: no uid");
      return;
    }

    console.log("[RecipeSync] pushToRemote start", { uid });

    const local = await this.getLocalRecipes();
    const dirtyItems = local.filter((item) => item.sync.dirty);

    console.log("[RecipeSync] pushToRemote loaded local entities", {
      total: local.length,
    });
    console.log("[RecipeSync] pushToRemote dirty items", {
      count: dirtyItems.length,
      ids: dirtyItems.map((i) => i.id),
    });

    if (!dirtyItems.length) {
      console.log("[RecipeSync] No dirty recipes to push");
      return;
    }

    const now = Date.now();

    const payloadItems = dirtyItems.map((item) => {
      const base = item.data as any;
      const createdAt = typeof base.createdAt === "number" ? base.createdAt : now;

      return {
        id: item.id,
        ...base,
        createdAt,
        updatedAt: now,
      };
    });

    try {
      const res = await fetch(`${API_BASE_URL}/sync/recipes/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uid,
          items: payloadItems,
        }),
      });

      if (!res.ok) {
        console.warn("[RecipeSync] pushToRemote backend error", {
          status: res.status,
          statusText: res.statusText,
        });
        return;
      }

      // Mark items as synced locally
      for (const item of dirtyItems) {
        item.sync.dirty = false;
        item.sync.lastSyncedAt = now;
        if (item.data) {
          (item.data as any).updatedAt = now;
          if (typeof (item.data as any).createdAt !== "number") {
            (item.data as any).createdAt = now;
          }
        }
      }

      await this.setLocalRecipes(local);
      console.log("[RecipeSync] pushToRemote done", {
        pushed: dirtyItems.length,
      });
    } catch (err) {
      console.warn("[RecipeSync] pushToRemote exception", { uid, err });
    }
  }

  /**
   * Upsert a recipe in local cache & mark as dirty for next sync
   */
  async upsertLocalRecipe(recipe: RecipeDoc): Promise<void> {
    const local = await this.getLocalRecipes();
    const idx = local.findIndex((r) => r.id === recipe.id);
    const existing = idx >= 0 ? local[idx] : null;
    const now = Date.now();

    const createdAt = recipe.createdAt ?? existing?.data.createdAt ?? now;

    const payload: LocalEntity<RecipeDoc> = {
      id: recipe.id,
      data: {
        ...existing?.data,
        ...recipe,
        createdAt,
        updatedAt: now,
      },
      sync: {
        // keep previous lastSyncedAt if any, but always mark as dirty
        lastSyncedAt: existing?.sync?.lastSyncedAt ?? null,
        dirty: true,
      },
    };

    if (idx >= 0) {
      local[idx] = payload;
    } else {
      local.push(payload);
    }

    await this.setLocalRecipes(local);
    console.log("[RecipeSync] upsertLocalRecipe", {
      id: recipe.id,
      title: recipe.title,
      dirty: payload.sync.dirty,
      lastSyncedAt: payload.sync.lastSyncedAt,
    });
  }
}