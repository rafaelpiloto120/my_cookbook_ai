import { runInitialMigrationIfNeeded } from "./migrations";
import { CookbookSync } from "./CookbookSync";
import { RecipeSync } from "./RecipeSync";
import { PreferencesSync } from "./PreferencesSync";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth } from "../../firebaseConfig";

/**
 * Reasons why a sync can be triggered.
 * This is useful for logging and debugging.
 */
export type SyncTriggerReason =
    | "initial"
    | "auth-change"
    | "manual"
    | "tab-focus"
    | "app-foreground"
    | "migration"
    | "auth-ready"; // legacy/compat reason for old triggers

type SyncPhase = "start" | "success" | "error";

function nowMs() {
    return Date.now();
}

// Helper to normalize sync trigger input for backward compatibility.
function normalizeTrigger(input: any): {
    reason: SyncTriggerReason;
    scope?: "all" | "cookbooks" | "recipes" | "preferences";
    force?: boolean;
} {
    if (typeof input === "string") {
        return { reason: input as SyncTriggerReason };
    }

    if (input && typeof input === "object") {
        const r = input.reason;
        const reason: SyncTriggerReason =
            typeof r === "string" ? (r as SyncTriggerReason) : "manual";

        const scope =
            input.scope === "cookbooks" ||
            input.scope === "recipes" ||
            input.scope === "preferences" ||
            input.scope === "all"
                ? (input.scope as any)
                : undefined;

        const force = input.force === true;

        return { reason, scope, force };
    }

    return { reason: "manual" };
}

function logSync(
    phase: SyncPhase,
    payload: {
        reason?: SyncTriggerReason;
        scope?: "all" | "cookbooks" | "recipes" | "preferences";
        durationMs?: number;
        error?: unknown;
        details?: Record<string, unknown>;
    } = {}
) {
    const prefix = "[SyncEngine]";
    const { reason, scope, durationMs, error, details } = payload;

    if (phase === "start") {
        console.log(`${prefix} ▶️ sync start`, {
            reason: reason ?? "unknown",
            scope: scope ?? "all",
            ...(details || {}),
        });
        return;
    }

    if (phase === "success") {
        console.log(`${prefix} ✅ sync success`, {
            reason: reason ?? "unknown",
            scope: scope ?? "all",
            durationMs: durationMs ?? null,
            ...(details || {}),
        });
        return;
    }

    if (phase === "error") {
        console.warn(`${prefix} ❌ sync error`, {
            reason: reason ?? "unknown",
            scope: scope ?? "all",
            durationMs: durationMs ?? null,
            error:
                error instanceof Error
                    ? { message: error.message, name: error.name }
                    : error ?? null,
            ...(details || {}),
        });
        return;
    }
}

/**
 * Central sync coordinator for cookbooks, recipes, and preferences.
 * Handles:
 *  - one-time migration from old AsyncStorage-only data
 *  - throttling
 *  - wiring per-entity sync modules
 *  - structured logging
 */
export class SyncEngine {
    /**
     * True when there is any Firebase user (anonymous or full account).
     * Used mainly for logging / future behavior toggles.
     */
    private isLoggedIn: boolean = false;
    private hasRunInitialSync: boolean = false;

    // Throttling / in‑flight tracking
    private lastSyncAt: number | null = null;
    private syncInFlight: boolean = false;
    private static readonly MIN_SYNC_INTERVAL_MS = 8000; // 8s between syncs

    // Queue of reasons requested while a sync is already running.
    // We coalesce them by just re-running a full sync once the current one finishes.
    private pendingReasons: SyncTriggerReason[] = [];

    // Timer used to re-run a queued sync after the throttle window expires.
    private pendingTimer: ReturnType<typeof setTimeout> | null = null;

    // Per-entity sync modules
    private cookbookSync: CookbookSync;
    private recipeSync: RecipeSync;
    private preferencesSync: PreferencesSync;

    constructor() {
        console.log("[SyncEngine] created", {
            hasGlobalSingleton: !!(globalThis as any)?.__recipeai_syncEngine,
        });
        this.cookbookSync = new CookbookSync();
        this.recipeSync = new RecipeSync();
        this.preferencesSync = new PreferencesSync();
    }

    /**
     * If a sync request is throttled, we must not drop it.
     * Instead, schedule a single follow-up run as soon as the throttle window expires.
     */
    private scheduleQueuedSyncAfterThrottle() {
        // If we already have a timer scheduled, don't schedule another.
        if (this.pendingTimer) return;

        if (this.lastSyncAt === null) return;

        const now = nowMs();
        const nextAllowedAt = this.lastSyncAt + SyncEngine.MIN_SYNC_INTERVAL_MS;
        const delayMs = Math.max(0, nextAllowedAt - now);

        this.pendingTimer = setTimeout(() => {
            this.pendingTimer = null;

            // If a sync is currently running, we'll rely on the in-flight queue
            // to trigger another run when it completes.
            if (this.syncInFlight) return;

            const nextReason = this.pendingReasons.shift();
            if (!nextReason) return;

            console.log("[SyncEngine] ▶️ running queued sync (post-throttle)", {
                reason: nextReason,
            });

            this.syncAll(nextReason, { bypassThrottle: true }).catch((err) => {
                logSync("error", {
                    reason: nextReason,
                    scope: "all",
                    error: err,
                });
            });
        }, delayMs);

        console.log("[SyncEngine] 🕒 queued sync scheduled", {
            delayMs,
            pendingCount: this.pendingReasons.length,
        });
    }

    /**
     * Publish the canonical merged state from the sync-store back into the legacy
     * AsyncStorage snapshot keys used by many UI screens.
     *
     * This is critical after auth transitions (anonymous -> account, or account switch),
     * because the sync layer merges data in `sync_*` keys while the UI often still
     * reads from `cookbooks` / `recipes` snapshot keys.
     */
    private async publishMergedSnapshotsToLegacy(): Promise<void> {
        try {
            // Cookbooks
            const cookbooksRaw = await AsyncStorage.getItem("sync_cookbooks");
            if (cookbooksRaw) {
                try {
                    const parsed = JSON.parse(cookbooksRaw);
                    if (Array.isArray(parsed)) {
                        const snapshot = parsed
                            .map((e: any) => e?.data)
                            .filter((d: any) => d && d.isDeleted !== true);
                        await AsyncStorage.setItem("cookbooks", JSON.stringify(snapshot));
                        console.log("[SyncEngine] published cookbooks snapshot from sync-store", {
                            count: snapshot.length,
                        });
                    }
                } catch (err) {
                    console.warn("[SyncEngine] failed to publish cookbooks snapshot", err);
                }
            }

            // Recipes
            const recipesRaw = await AsyncStorage.getItem("sync_recipes");
            if (recipesRaw) {
                try {
                    const parsed = JSON.parse(recipesRaw);
                    if (Array.isArray(parsed)) {
                        const snapshot = parsed
                            .map((e: any) => e?.data)
                            .filter((d: any) => d && d.isDeleted !== true);
                        await AsyncStorage.setItem("recipes", JSON.stringify(snapshot));
                        console.log("[SyncEngine] published recipes snapshot from sync-store", {
                            count: snapshot.length,
                        });
                    }
                } catch (err) {
                    console.warn("[SyncEngine] failed to publish recipes snapshot", err);
                }
            }
        } catch (err) {
            console.warn("[SyncEngine] publishMergedSnapshotsToLegacy failed", err);
        }
    }

    /**
     * Called from AuthContext when Firebase auth state changes
     * (anonymous → logged in, logged out, etc.)
     *
     * We now receive a richer snapshot with uid + isAnonymous or null
     * when there is no user at all.
     */
    async handleAuthStateChanged(
        authState: { uid: string; isAnonymous: boolean } | null
    ): Promise<void> {
        this.isLoggedIn = !!authState;

        console.log("[SyncEngine] Auth state changed.", {
            isLoggedIn: this.isLoggedIn,
            uid: authState?.uid ?? null,
            isAnonymous: authState?.isAnonymous ?? null,
        });

        try {
            await this.syncAll("auth-change", { bypassThrottle: true });
        } catch (err) {
            logSync("error", {
                reason: "auth-change",
                scope: "all",
                error: err,
            });
        }
    }

    /**
     * Public entry point used by screens / app lifecycle.
     * Still throttled and guarded against concurrent syncs.
     */
    async syncAll(
        trigger: SyncTriggerReason | { reason?: SyncTriggerReason; scope?: any; force?: boolean } = "manual",
        options: { bypassThrottle?: boolean } = {}
    ): Promise<void> {
        const norm = normalizeTrigger(trigger);
        const reason = norm.reason;
        const now = nowMs();

        // If a sync is already running:
        //  - For non-manual reasons, queue the request.
        //  - For manual reasons (user actions), DO NOT queue (it causes delayed sync UX).
        //    Instead, let callers force a bypass-throttle sync once the current run finishes.
        if (this.syncInFlight) {
            if (reason === "manual") {
                console.log("[SyncEngine] ⏭️ manual sync requested while in-flight; skipping queue", {
                    reason,
                });
                return;
            }

            console.log("[SyncEngine] ⏳ syncAll queued – in flight", { reason });
            this.pendingReasons.push(reason);
            return;
        }

        // Throttle subsequent syncs so we don't run too often.
        // NOTE: we deliberately do *not* throttle manual syncs, because those
        // are usually triggered directly by important user actions (e.g.
        // saving a recipe) and should run immediately if possible.
        if (
            !options.bypassThrottle &&
            reason !== "manual" &&
            reason !== "auth-change" &&
            this.hasRunInitialSync &&
            this.lastSyncAt !== null &&
            now - this.lastSyncAt < SyncEngine.MIN_SYNC_INTERVAL_MS
        ) {
            console.log("[SyncEngine] ⏳ syncAll throttled", {
                reason,
                sinceLastMs: now - this.lastSyncAt,
                minIntervalMs: SyncEngine.MIN_SYNC_INTERVAL_MS,
            });

            // Do NOT drop this request — queue it and run as soon as we can.
            this.pendingReasons.push(reason);
            this.scheduleQueuedSyncAfterThrottle();
            return;
        }

        this.syncInFlight = true;
        const startedAt = nowMs();

        logSync("start", { reason, scope: "all" });

        try {
            if (!this.hasRunInitialSync) {
                this.hasRunInitialSync = true;
            }

            // 1) Ensure we migrate any old local-only data before starting real sync
            const migrationStart = nowMs();
            await runInitialMigrationIfNeeded();
            logSync("success", {
                reason,
                scope: "all",
                durationMs: nowMs() - migrationStart,
                details: { stage: "migration" },
            });

            // 2) Per-entity syncs
            const uid = auth.currentUser?.uid ?? null;

            // Cookbooks
            if (this.cookbookSync && typeof (this.cookbookSync as any).syncAll === "function") {
                const cookbookStart = nowMs();
                await this.cookbookSync.syncAll();
                logSync("success", {
                    reason,
                    scope: "cookbooks",
                    durationMs: nowMs() - cookbookStart,
                });
            } else {
                logSync("error", {
                    reason,
                    scope: "cookbooks",
                    error: "CookbookSync.syncAll is not available",
                });
            }

            // Recipes
            if (this.recipeSync && typeof (this.recipeSync as any).syncAll === "function") {
                const recipeStart = nowMs();
                await this.recipeSync.syncAll(uid);
                logSync("success", {
                    reason,
                    scope: "recipes",
                    durationMs: nowMs() - recipeStart,
                });
            } else {
                logSync("error", {
                    reason,
                    scope: "recipes",
                    error: "RecipeSync.syncAll is not available",
                });
            }

            // Preferences
            if (this.preferencesSync && typeof (this.preferencesSync as any).syncAll === "function") {
                const prefStart = nowMs();
                await this.preferencesSync.syncAll(uid);
                logSync("success", {
                    reason,
                    scope: "preferences",
                    durationMs: nowMs() - prefStart,
                });
            } else {
                logSync("error", {
                    reason,
                    scope: "preferences",
                    error: "PreferencesSync.syncAll is not available",
                });
            }

            // After auth transitions, publish the merged canonical state back into
            // legacy snapshot keys so UI screens immediately reflect merged data.
            if (reason === "auth-change" && uid) {
                await this.publishMergedSnapshotsToLegacy();
            }

            if (uid) {
                this.lastSyncAt = nowMs();
            }

            logSync("success", {
                reason,
                scope: "all",
                durationMs: nowMs() - startedAt,
            });
        } catch (err) {
            logSync("error", {
                reason,
                scope: "all",
                durationMs: nowMs() - startedAt,
                error: err,
            });
            throw err;
        } finally {
            this.syncInFlight = false;

            // If any sync requests were queued while this one was running, run one more
            // sync immediately, bypassing the throttle. We coalesce multiple queued
            // reasons into a single follow-up run.
            const nextReason = this.pendingReasons.shift();
            if (nextReason) {
                console.log("[SyncEngine] ▶️ running queued sync", { reason: nextReason });
                this.syncAll(nextReason, { bypassThrottle: true }).catch((err) => {
                    logSync("error", {
                        reason: nextReason,
                        scope: "all",
                        error: err,
                    });
                });
            }
        }
    }

    /**
     * Force a sync to happen as soon as possible.
     * - If a sync is already running, we enqueue a single manual run to happen next.
     * - If idle, we run immediately and bypass throttle.
     *
     * This is intended for UX-critical actions like create/update/delete.
     */
    forceSyncNow(trigger: SyncTriggerReason | { reason?: SyncTriggerReason; scope?: any; force?: boolean } = "manual") {
        const norm = normalizeTrigger(trigger);
        const reason = norm.reason;
        if (this.syncInFlight) {
            // Ensure we run one more sync right after the current one.
            // Avoid growing the queue with repeated manual requests.
            if (!this.pendingReasons.includes("manual")) {
                this.pendingReasons.push("manual");
            }
            console.log("[SyncEngine] 🧲 forceSyncNow queued after in-flight", {
                reason,
                pendingCount: this.pendingReasons.length,
            });
            return;
        }

        console.log("[SyncEngine] 🧲 forceSyncNow running", { reason });
        this.syncAll(reason, { bypassThrottle: true }).catch((err) => {
            logSync("error", {
                reason,
                scope: "all",
                error: err,
            });
        });
    }

    /**
     * Optional convenience wrapper if you want a semantic API:
     * syncEngine.requestSync("tab-focus") instead of syncEngine.syncAll(...)
     */
    requestSync(trigger: SyncTriggerReason | { reason?: SyncTriggerReason; scope?: any; force?: boolean }) {
        const norm = normalizeTrigger(trigger);
        console.log("[SyncEngine] requestSync", { reason: norm.reason, scope: norm.scope ?? "all", force: norm.force ?? false });
        this.syncAll(norm.reason).catch((err) => {
            logSync("error", {
                reason: norm.reason,
                scope: "all",
                error: err,
            });
        });
    }
    /**
   * TEMPORARY: centralised snapshot writer for recipes.
   * Keeps legacy AsyncStorage-based storage working while
   * the UI gradually moves fully to the sync engine.
   */
    public async saveLocalRecipesSnapshot(recipes: any[]): Promise<void> {
        try {
            await AsyncStorage.setItem("recipes", JSON.stringify(recipes));
        } catch (err) {
            console.warn("[SyncEngine] Failed to save local recipes snapshot", err);
        }
    }

    /**
     * TEMPORARY: centralised snapshot writer for cookbooks.
     * Keeps legacy AsyncStorage-based storage working while
     * the UI gradually moves fully to the sync engine.
     */
    public async saveLocalCookbooksSnapshot(cookbooks: any[]): Promise<void> {
        try {
            // Read previous snapshot so we can detect changes + removals (deletions)
            const prevRaw = await AsyncStorage.getItem("cookbooks");
            const prevIds = new Set<string>();
            const prevById = new Map<string, any>();

            if (prevRaw) {
                try {
                    const prev = JSON.parse(prevRaw);
                    if (Array.isArray(prev)) {
                        for (const c of prev) {
                            const id = (c as any)?.id;
                            if (typeof id === "string" && id) {
                                prevIds.add(id);
                                prevById.set(id, c);
                            }
                        }
                    }
                } catch {
                    // ignore parse issues for previous snapshot
                }
            }

            // Persist legacy snapshot (used by existing UI screens)
            await AsyncStorage.setItem("cookbooks", JSON.stringify(cookbooks));

            // Only mirror *new/changed* items into the sync engine store.
            // IMPORTANT: we must NOT call requestSync for each item; we call it once at the end.
            if (Array.isArray(cookbooks)) {
                for (const cb of cookbooks) {
                    const id = (cb as any)?.id;
                    if (!id) continue;

                    const prevCb = prevById.get(String(id));

                    // Decide if this cookbook has meaningfully changed compared to previous snapshot
                    const hasChanged = (() => {
                        if (!prevCb) return true; // new

                        const a: any = prevCb;
                        const b: any = cb;

                        // Compare the fields that matter for remote sync.
                        // (We avoid deep compare of the whole object to prevent false positives.)
                        return (
                            (a.name ?? "") !== (b.name ?? "") ||
                            (a.imageUrl ?? null) !== (b.imageUrl ?? null) ||
                            (a.isDeleted ?? false) !== (b.isDeleted ?? false) ||
                            (a.updatedAt ?? null) !== (b.updatedAt ?? null)
                        );
                    })();

                    if (hasChanged) {
                        // Keep UI-provided fields, but ensure we always have an id.
                        await this.markCookbookDirty({ ...(cb as any), id }, { triggerSync: false });
                    }

                    // This id still exists in the new snapshot, so it wasn't deleted.
                    prevIds.delete(String(id));
                }
            }

            // Anything present before but missing now => mark as deleted + dirty
            if (prevIds.size > 0) {
                const now = Date.now();
                for (const id of prevIds) {
                    await this.markCookbookDirty(
                        {
                            id,
                            isDeleted: true,
                            updatedAt: now,
                        },
                        { triggerSync: false }
                    );
                }
            }

            // Trigger a single sync after cookbook snapshot changes.
            // Safe offline: dirty state persists and will be pushed later.
            this.forceSyncNow("manual");
        } catch (err) {
            console.warn("[SyncEngine] Failed to save local cookbooks snapshot", err);
        }
    }
      /**
   * Mark a recipe as dirty in the sync engine so it gets pushed to Firestore.
   * This keeps the UI decoupled from RecipeSync internals.
   */
  public async markRecipeDirty(recipe: any): Promise<void> {
    try {
      await this.recipeSync.upsertLocalRecipe(recipe);
      console.log("[SyncEngine] markRecipeDirty ok", { id: recipe?.id });
    } catch (err) {
      console.warn("[SyncEngine] markRecipeDirty for recipe failed", err);
    }
  }

  /**
   * Mark a cookbook as dirty in the sync engine so it gets pushed to Firestore.
   * (We’ll use this later from cookbook screens.)
   * Optionally disables triggering a sync for bulk operations.
   */
  public async markCookbookDirty(
    cookbook: any,
    options: { triggerSync?: boolean } = {}
  ): Promise<void> {
    try {
      await this.cookbookSync.upsertLocalCookbook(cookbook);
      console.log("[SyncEngine] markCookbookDirty ok", { id: cookbook?.id });
      // Default behavior: trigger a sync. Bulk callers can disable this.
      if (options.triggerSync !== false) {
        this.forceSyncNow("manual");
      }
    } catch (err) {
      console.warn("[SyncEngine] markCookbookDirty failed", err);
    }
  }

  /**
   * Mark preferences as dirty in the sync engine so they get pushed to Firestore.
   * This keeps the UI decoupled from PreferencesSync internals.
   */
  public async markPreferencesDirty(preferences: any): Promise<void> {
    try {
      if (
        this.preferencesSync &&
        typeof (this.preferencesSync as any).upsertLocalPreferences === "function"
      ) {
        await (this.preferencesSync as any).upsertLocalPreferences(preferences);
        console.log("[SyncEngine] markPreferencesDirty ok");
        this.forceSyncNow("manual");
      } else if (
        this.preferencesSync &&
        typeof (this.preferencesSync as any).saveLocalPreferences === "function"
      ) {
        // Backwards-compatible: if PreferencesSync used a different method name.
        await (this.preferencesSync as any).saveLocalPreferences(preferences);
        console.log("[SyncEngine] markPreferencesDirty (saveLocalPreferences) ok");
        this.forceSyncNow("manual");
      } else {
        console.warn(
          "[SyncEngine] markPreferencesDirty called but PreferencesSync has no upsert/save method"
        );
      }
    } catch (err) {
      console.warn("[SyncEngine] markPreferencesDirty failed", err);
    }
  }
}

// IMPORTANT: named singleton export used by AuthContext and screens
// In dev (Fast Refresh / HMR), modules can be re-evaluated and accidentally create
// multiple SyncEngine instances. That breaks sync triggers because different screens
// may hold references to different instances.
// We pin the singleton on globalThis to ensure a single instance across reloads.
const g = globalThis as unknown as { __recipeai_syncEngine?: SyncEngine };
export const syncEngine: SyncEngine = g.__recipeai_syncEngine ?? (g.__recipeai_syncEngine = new SyncEngine());

/**
 * Simple hook facade used by screens.
 * Right now it just returns the singleton. If in the future we decide to
 * move to a React context-based SyncEngineProvider, we can keep this hook
 * name and change the implementation without touching the screens.
 */
export function useSyncEngine(): SyncEngine {
    return syncEngine;
}