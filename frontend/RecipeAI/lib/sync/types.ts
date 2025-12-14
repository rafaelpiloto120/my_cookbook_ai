/**
 * Shared domain types for sync logic.
 *
 * These interfaces represent the canonical shape of data as stored in Firestore
 * and used by the sync engine (Cookbooks, Recipes, Preferences, etc.).
 * UI layers can map their local view models into / from these structures.
 */
// lib/sync/types.ts

// ---------- Cookbooks ----------

export interface CookbookDoc {
  id: string;                    // Firestore doc ID / local ID
  name: string;                  // Cookbook name
  imageUrl?: string | null;      // Optional cover image
  createdAt: number;             // ms since epoch
  updatedAt: number;             // ms since epoch
  isDeleted?: boolean;           // soft-delete flag (optional for future)
}

// ---------- Recipes ----------

export type Difficulty = "easy" | "medium" | "hard" | "unknown";

export type CostLevel = "low" | "medium" | "high" | "unknown";

export interface Ingredient {
  id: string;                    // local identifier
  name: string;
  quantity?: number | null;
  unit?: string | null;
  notes?: string | null;
}

export interface InstructionStep {
  id: string;                    // local identifier
  text: string;                  // "Preheat the oven to 180ºC"
  order: number;                 // 1, 2, 3... (step position in the recipe)
}

export interface RecipeDoc {
  id: string;                    // Firestore doc ID / local ID
  title: string;
  imageUrl?: string | null;
  createdAt: number;
  updatedAt: number;

  cookingTimeMinutes?: number | null;
  difficulty?: Difficulty;
  servings?: number | null;
  cost?: CostLevel;

  ingredients: Ingredient[];
  steps: InstructionStep[];

  cookbookIds: string[];         // which cookbooks this recipe belongs to
  tags: string[];

  isDeleted?: boolean;           // soft-delete flag (optional for future)
}

// ---------- Preferences ----------

export type MeasurementSystem = "metric" | "imperial";
export type ThemeMode = "light" | "dark" | "system";

export interface PreferencesDoc {
  userDietary: string[];         // dietary keys (e.g. "vegetarian", "vegan"...)
  userAvoid: string[];           // avoid keys (e.g. "nuts", "seafood", "other")
  userAvoidOther: string;        // free text for "other" ingredients
  userMeasurement: MeasurementSystem;
  themeMode: ThemeMode;
  userLanguage: string;          // "en", "pt", "pt-BR", etc.
  updatedAt: number;             // ms since epoch
}

// ---------- Generic sync helpers ----------

// Local-only metadata (NOT written to Firestore)
export interface LocalSyncMetadata {
  lastSyncedAt: number | null;   // last time this entity was synced
  dirty: boolean;                // true = has local changes not yet pushed
}

// A local entity with embedded sync metadata (in AsyncStorage / local DB)
export interface LocalEntity<T> {
  /**
   * Local primary key (should usually mirror data.id for CookbookDoc / RecipeDoc).
   */
  id: string;
  /**
   * Domain data (CookbookDoc, RecipeDoc, PreferencesDoc, ...).
   */
  data: T;
  /**
   * Local-only sync metadata (never written to Firestore).
   */
  sync: LocalSyncMetadata;
}