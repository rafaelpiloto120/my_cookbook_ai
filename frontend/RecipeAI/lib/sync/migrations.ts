import AsyncStorage from "@react-native-async-storage/async-storage";

const MIGRATION_FLAG_KEY = "sync_migration_v1_done";

// Legacy keys we want to inspect / eventually migrate
const LEGACY_RECIPES_KEY = "recipes";
const LEGACY_COOKBOOKS_KEY = "cookbooks";

// Preferences-related legacy keys
const LEGACY_DIETARY_KEY = "dietary";
const LEGACY_AVOID_KEY = "avoid";
const LEGACY_AVOID_OTHER_KEY = "avoidOther";
const LEGACY_THEME_KEYS = ["theme", "@theme"];
const LEGACY_LANGUAGE_KEYS = ["userLanguage", "language"];

// Keys we explicitly do NOT migrate (just documented here for clarity):
// - PROFILE_KEY (profile photo / offline fallback)
// - RECIPES_SCROLL_Y_KEY (scroll position)
// - KEYS.ONBOARDING_DONE, "hasSeenOnboarding" (onboarding flags)
// - DEVICE_ID_KEY (analytics / device ID)

/**
 * One-time migration hook.
 *
 * For now this is intentionally conservative:
 * - It only reads the legacy keys.
 * - Logs what it finds.
 * - Marks the migration as done.
 *
 * When we wire full Firestore sync, we'll extend this to:
 * - Parse the legacy payloads.
 * - Upsert them via CookbookSync / RecipeSync / PreferencesSync.
 * - Optionally clear the old keys.
 */
export async function runInitialMigrationIfNeeded(): Promise<void> {
  try {
    const alreadyDone = await AsyncStorage.getItem(MIGRATION_FLAG_KEY);
    if (alreadyDone === "1") {
      // Migration already ran
      return;
    }

    console.log("[Migration] v1 starting… checking legacy AsyncStorage keys");

    const [
      recipesJson,
      cookbooksJson,
      dietaryJson,
      avoidJson,
      avoidOtherJson,
      themeValuePrimary,
      themeValueAlt,
      userLanguageJson,
      languageJson,
    ] = await Promise.all([
      AsyncStorage.getItem(LEGACY_RECIPES_KEY),
      AsyncStorage.getItem(LEGACY_COOKBOOKS_KEY),
      AsyncStorage.getItem(LEGACY_DIETARY_KEY),
      AsyncStorage.getItem(LEGACY_AVOID_KEY),
      AsyncStorage.getItem(LEGACY_AVOID_OTHER_KEY),
      AsyncStorage.getItem(LEGACY_THEME_KEYS[0]),
      AsyncStorage.getItem(LEGACY_THEME_KEYS[1]),
      AsyncStorage.getItem(LEGACY_LANGUAGE_KEYS[0]),
      AsyncStorage.getItem(LEGACY_LANGUAGE_KEYS[1]),
    ]);

    // We only log for now, so we can safely observe what's out there
    // without mutating user data or deleting anything.
    console.log("[Migration] legacy keys presence:", {
      hasRecipes: !!recipesJson,
      hasCookbooks: !!cookbooksJson,
      hasDietary: !!dietaryJson,
      hasAvoid: !!avoidJson,
      hasAvoidOther: !!avoidOtherJson,
      theme: themeValuePrimary || themeValueAlt || null,
      userLanguage: userLanguageJson || languageJson || null,
    });

    // TODO (future):
    //  - Parse recipesJson/cookbooksJson into structured data
    //  - Call into CookbookSync / RecipeSync / PreferencesSync
    //  - Optionally remove legacy keys

    await AsyncStorage.setItem(MIGRATION_FLAG_KEY, "1");
    console.log("[Migration] v1 completed (no destructive changes performed).");
  } catch (err) {
    console.warn("[Migration] v1 failed:", err);
    // On failure we do NOT set the flag, so we can attempt again on next launch.
  }
}