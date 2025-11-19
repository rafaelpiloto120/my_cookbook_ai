import AsyncStorage from "@react-native-async-storage/async-storage";

const DEVICE_ID_KEY = "deviceId";

/**
 * Returns a stable, per-device identifier stored in AsyncStorage.
 * If none exists yet, it generates a random one, persists it, and returns it.
 */
export async function getDeviceId(): Promise<string> {
  try {
    // 1. Try to reuse an existing stored id
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored && typeof stored === "string" && stored.length > 0) {
      return stored;
    }

    // 2. Generate a new pseudo-random id (no dependencies)
    const randomPart = Math.random().toString(36).slice(2);
    const timePart = Date.now().toString(36);
    const newId = `dev_${randomPart}_${timePart}`;

    await AsyncStorage.setItem(DEVICE_ID_KEY, newId);
    return newId;
  } catch (err) {
    console.warn(
      "[deviceId] Failed to get or store device id, falling back to random",
      err
    );
    // Last-resort fallback (not persisted if AsyncStorage is failing)
    const randomPart = Math.random().toString(36).slice(2);
    const timePart = Date.now().toString(36);
    return `dev_fallback_${randomPart}_${timePart}`;
  }
}

export default getDeviceId;