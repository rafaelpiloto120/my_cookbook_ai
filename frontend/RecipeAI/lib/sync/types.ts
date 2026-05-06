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
  isDefault?: boolean;           // legacy flag kept for compatibility
  source?: string;               // legacy/source marker kept for compatibility
  isDeleted?: boolean;           // soft-delete flag (optional for future)
}

// ---------- Recipes ----------

export type Difficulty = "easy" | "medium" | "hard" | "unknown";

export type CostLevel = "low" | "medium" | "high" | "unknown";

export type RecipeNutritionSource = "imported" | "ai_generated" | "manual" | "estimated";

export interface RecipeNutritionPerServing {
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

export interface RecipeNutritionInfo {
  perServing: RecipeNutritionPerServing;
  source: RecipeNutritionSource;
  updatedAt: number | string;
}

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
  nutritionInfo?: RecipeNutritionInfo | null;

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

// ---------- My Day ----------

export interface MyDayPlanDoc {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface MyDayProfileDoc {
  age: string;
  height: string;
  heightCm?: number | null;
  currentWeight: string;
  targetWeight: string;
  currentWeightKg?: number | null;
  targetWeightKg?: number | null;
  gender: string;
  goalType: string;
  pace: string;
  plan: MyDayPlanDoc | null;
  isCustomizedPlan: boolean;
  updatedAt: number;
  schemaVersion: number;
}

export type MyDayMealSource = "photo" | "text" | "recipe" | "manual";

export interface MyDayMealIngredientDoc {
  name: string;
  quantity: string;
  unit: string;
}

export interface MyDayMealDoc {
  id: string;
  title: string;
  source: MyDayMealSource;
  createdAt: string;
  dayKey: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  rawInput?: string;
  photoUri?: string;
  recipeId?: string;
  servingMultiplier?: number;
  nutritionMode?: "auto" | "manual";
  automaticNutrition?: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  };
  ingredients?: MyDayMealIngredientDoc[];
  updatedAt: number;
  schemaVersion: number;
  isDeleted?: boolean;
}

export interface MyDayWeightLogDoc {
  id: string;
  createdAt: string;
  dayKey: string;
  weight: string;
  normalizedWeightKg: number | null;
  note?: string;
  updatedAt: number;
  schemaVersion: number;
  isDeleted?: boolean;
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
