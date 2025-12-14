import AsyncStorage from "@react-native-async-storage/async-storage";

const SYNC_PREFS_KEY = "sync_prefs";

export const PREFS_UPDATED = "prefs:updated";

// Minimal event emitter compatible with React Native (no Node 'events' dependency)
type Listener<T = any> = (payload: T) => void;

class SimpleEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, cb: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }

  off(event: string, cb: Listener) {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) this.listeners.delete(event);
  }

  emit<T = any>(event: string, payload: T) {
    const set = this.listeners.get(event);
    if (!set) return;
    Array.from(set).forEach((cb) => {
      try {
        cb(payload);
      } catch {
        // swallow listener errors
      }
    });
  }
}

export const prefsEvents = new SimpleEmitter();

// Central place to persist + notify
export async function saveUserPrefs(prefs: {
  userLanguage?: string;
  userDietary?: string[];            // your dietary ids
  userAvoid?: string[];              // your avoid ids
  userAvoidOther?: string;           // free text
  userMeasurement?: "metric" | "imperial";
  themeMode?: "light" | "dark" | "system";
}) {
  // 1) Preserve existing per-field keys for backward compatibility
  const entries: [string, string][] = [];
  if (prefs.userLanguage !== undefined)
    entries.push(["userLanguage", prefs.userLanguage]);
  if (prefs.userDietary !== undefined)
    entries.push(["userDietary", JSON.stringify(prefs.userDietary)]);
  if (prefs.userAvoid !== undefined)
    entries.push(["userAvoid", JSON.stringify(prefs.userAvoid)]);
  if (prefs.userAvoidOther !== undefined)
    entries.push(["userAvoidOther", prefs.userAvoidOther]);
  if (prefs.userMeasurement !== undefined)
    entries.push(["userMeasurement", prefs.userMeasurement]);
  if (prefs.themeMode !== undefined)
    entries.push(["themeMode", prefs.themeMode]);

  if (entries.length) {
    await AsyncStorage.multiSet(entries);
  }

  // 2) Maintain a consolidated, sync-friendly prefs document
  try {
    const raw = await AsyncStorage.getItem(SYNC_PREFS_KEY);
    let existing: any = null;
    if (raw) {
      try {
        existing = JSON.parse(raw);
      } catch {
        existing = null;
      }
    }

    const now = Date.now();
    const merged = {
      ...(existing || {}),
      ...prefs,
      updatedAt: now,
      createdAt:
        existing && typeof existing.createdAt === "number"
          ? existing.createdAt
          : now,
    };

    await AsyncStorage.setItem(SYNC_PREFS_KEY, JSON.stringify(merged));
  } catch {
    // Ignore sync_prefs failures; per-field keys are still persisted
  }

  // 3) Notify listeners
  prefsEvents.emit(PREFS_UPDATED, prefs);
}