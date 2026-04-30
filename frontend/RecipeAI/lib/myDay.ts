import AsyncStorage from "@react-native-async-storage/async-storage";

export type MyDayGoalType = "lose" | "maintain" | "gain" | "track";
export type MyDayPace = "relaxed" | "balanced" | "aggressive";
export type MyDayGender = "female" | "male" | "nonbinary" | "prefer_not_to_say" | "";
export type MeasurementSystem = "US" | "Metric";

export type MyDayPlan = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

export type MyDayProfile = {
  age: string;
  height: string;
  heightCm?: number | null;
  currentWeight: string;
  targetWeight: string;
  currentWeightKg?: number | null;
  targetWeightKg?: number | null;
  gender: MyDayGender;
  goalType: MyDayGoalType;
  pace: MyDayPace;
  plan: MyDayPlan | null;
  isCustomizedPlan: boolean;
  updatedAt: string;
};

export const MY_DAY_PROFILE_KEY = "myDayProfile";

export const defaultMyDayProfile = (): MyDayProfile => ({
  age: "",
  height: "",
  heightCm: null,
  currentWeight: "",
  targetWeight: "",
  currentWeightKg: null,
  targetWeightKg: null,
  gender: "",
  goalType: "track",
  pace: "balanced",
  plan: null,
  isCustomizedPlan: false,
  updatedAt: new Date().toISOString(),
});

function safeNumber(value: string): number | null {
  if (!value) return null;
  const normalized = value.replace(",", ".").trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function poundsToKg(value: number) {
  return value * 0.45359237;
}

function kgToPounds(value: number) {
  return value * 2.2046226218;
}

function inchesToCm(value: number) {
  return value * 2.54;
}

function cmToInches(value: number) {
  return value / 2.54;
}

function roundWeight(value: number) {
  return Number(value.toFixed(1));
}

function roundHeight(value: number) {
  return Number(value.toFixed(1));
}

export function normalizeMeasurementSystem(
  storedMeasurement?: string | null,
  storedMeasureSystem?: string | null
): MeasurementSystem {
  const measurementSource = storedMeasurement || storedMeasureSystem;
  return measurementSource === "US" || measurementSource === "imperial" ? "US" : "Metric";
}

export async function loadMeasurementSystemPreference(): Promise<MeasurementSystem> {
  const [storedMeasurement, storedMeasureSystem, storedUserMeasurement, syncPrefsRaw] =
    await Promise.all([
      AsyncStorage.getItem("measurement"),
      AsyncStorage.getItem("measureSystem"),
      AsyncStorage.getItem("userMeasurement"),
      AsyncStorage.getItem("sync_prefs"),
    ]);

  let syncPrefsMeasurement: string | null = null;
  if (syncPrefsRaw) {
    try {
      const parsed = JSON.parse(syncPrefsRaw);
      if (typeof parsed?.userMeasurement === "string") {
        syncPrefsMeasurement = parsed.userMeasurement;
      }
    } catch {
      syncPrefsMeasurement = null;
    }
  }

  return normalizeMeasurementSystem(
    storedMeasurement || storedMeasureSystem,
    storedUserMeasurement || syncPrefsMeasurement
  );
}

export function parseWeightToKg(value: string, measurementSystem: MeasurementSystem): number | null {
  const parsed = safeNumber(value);
  if (!parsed) return null;
  return measurementSystem === "US" ? poundsToKg(parsed) : parsed;
}

export function parseHeightToCm(value: string, measurementSystem: MeasurementSystem): number | null {
  const parsed = safeNumber(value);
  if (!parsed) return null;
  return measurementSystem === "US" ? inchesToCm(parsed) : parsed;
}

export function formatWeightFromKg(valueKg: number | null | undefined, measurementSystem: MeasurementSystem): string {
  if (!Number.isFinite(valueKg ?? NaN) || !valueKg || valueKg <= 0) return "";
  const displayValue = measurementSystem === "US" ? kgToPounds(valueKg) : valueKg;
  return roundWeight(displayValue).toString();
}

export function formatHeightFromCm(valueCm: number | null | undefined, measurementSystem: MeasurementSystem): string {
  if (!Number.isFinite(valueCm ?? NaN) || !valueCm || valueCm <= 0) return "";
  const displayValue = measurementSystem === "US" ? cmToInches(valueCm) : valueCm;
  return roundHeight(displayValue).toString();
}

export function hasMyDaySetup(profile: MyDayProfile | null | undefined) {
  if (!profile) return false;
  return !!profile.plan;
}

export function deriveSuggestedPlan(
  profile: Pick<MyDayProfile, "age" | "height" | "currentWeight" | "goalType" | "pace" | "gender">,
  measurementSystem: MeasurementSystem
): MyDayPlan | null {
  const age = safeNumber(profile.age);
  const rawHeight = safeNumber(profile.height);
  const rawWeight = safeNumber(profile.currentWeight);

  if (!age || !rawHeight || !rawWeight) return null;

  const heightCm = measurementSystem === "US" ? inchesToCm(rawHeight) : rawHeight;
  const weightKg = measurementSystem === "US" ? poundsToKg(rawWeight) : rawWeight;

  let sexOffset = -78;
  if (profile.gender === "male") sexOffset = 5;
  if (profile.gender === "female") sexOffset = -161;

  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + sexOffset;
  const maintenance = bmr * 1.35;

  const paceAdjustments: Record<MyDayPace, number> = {
    relaxed: 180,
    balanced: 320,
    aggressive: 500,
  };

  let targetCalories = maintenance;
  if (profile.goalType === "lose") targetCalories -= paceAdjustments[profile.pace];
  if (profile.goalType === "gain") targetCalories += paceAdjustments[profile.pace];

  targetCalories = Math.max(1200, Math.min(4200, targetCalories));

  const proteinMultiplier =
    profile.goalType === "lose" ? 1.8 : profile.goalType === "gain" ? 1.8 : 1.6;
  const fatMultiplier = profile.goalType === "lose" ? 0.8 : 0.9;

  const protein = Math.max(60, Math.round(weightKg * proteinMultiplier));
  const fat = Math.max(40, Math.round(weightKg * fatMultiplier));
  const remainingCalories = targetCalories - protein * 4 - fat * 9;
  const carbs = Math.max(80, Math.round(remainingCalories / 4));

  return {
    calories: Math.round(targetCalories / 10) * 10,
    protein,
    carbs,
    fat,
  };
}

export async function loadMyDayProfile(): Promise<MyDayProfile> {
  try {
    const [raw, measurementSystem] = await Promise.all([
      AsyncStorage.getItem(MY_DAY_PROFILE_KEY),
      loadMeasurementSystemPreference(),
    ]);
    if (!raw) return defaultMyDayProfile();
    const parsed = JSON.parse(raw);
    const heightCm =
      Number.isFinite(parsed?.heightCm) && parsed.heightCm > 0
        ? Number(parsed.heightCm)
        : parseHeightToCm(parsed?.height ?? "", measurementSystem);
    const currentWeightKg =
      Number.isFinite(parsed?.currentWeightKg) && parsed.currentWeightKg > 0
        ? Number(parsed.currentWeightKg)
        : parseWeightToKg(parsed?.currentWeight ?? "", measurementSystem);
    const targetWeightKg =
      Number.isFinite(parsed?.targetWeightKg) && parsed.targetWeightKg > 0
        ? Number(parsed.targetWeightKg)
        : parseWeightToKg(parsed?.targetWeight ?? "", measurementSystem);

    return {
      ...defaultMyDayProfile(),
      ...parsed,
      height: formatHeightFromCm(heightCm, measurementSystem),
      heightCm,
      currentWeight: formatWeightFromKg(currentWeightKg, measurementSystem),
      targetWeight: formatWeightFromKg(targetWeightKg, measurementSystem),
      currentWeightKg,
      targetWeightKg,
      plan: parsed?.plan
        ? {
            calories: Number(parsed.plan.calories) || 0,
            protein: Number(parsed.plan.protein) || 0,
            carbs: Number(parsed.plan.carbs) || 0,
            fat: Number(parsed.plan.fat) || 0,
          }
        : null,
    };
  } catch {
    return defaultMyDayProfile();
  }
}

export async function saveMyDayProfile(
  profile: MyDayProfile,
  measurementSystem?: MeasurementSystem
): Promise<void> {
  const resolvedMeasurementSystem = measurementSystem ?? (await loadMeasurementSystemPreference());
  const heightCm =
    Number.isFinite(profile.heightCm ?? NaN) && (profile.heightCm ?? 0) > 0
      ? Number(profile.heightCm)
      : parseHeightToCm(profile.height, resolvedMeasurementSystem);
  const currentWeightKg =
    Number.isFinite(profile.currentWeightKg ?? NaN) && (profile.currentWeightKg ?? 0) > 0
      ? Number(profile.currentWeightKg)
      : parseWeightToKg(profile.currentWeight, resolvedMeasurementSystem);
  const targetWeightKg =
    Number.isFinite(profile.targetWeightKg ?? NaN) && (profile.targetWeightKg ?? 0) > 0
      ? Number(profile.targetWeightKg)
      : parseWeightToKg(profile.targetWeight, resolvedMeasurementSystem);
  await AsyncStorage.setItem(
    MY_DAY_PROFILE_KEY,
    JSON.stringify({
      ...profile,
      heightCm,
      currentWeightKg,
      targetWeightKg,
      updatedAt: new Date().toISOString(),
    })
  );
}
