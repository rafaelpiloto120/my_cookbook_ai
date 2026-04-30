import AsyncStorage from "@react-native-async-storage/async-storage";
import { nanoid } from "nanoid/non-secure";

import { MeasurementSystem, normalizeMeasurementSystem } from "./myDay";

export type MyDayWeightLog = {
  id: string;
  value: number;
  valueKg?: number;
  sourceMeasurement?: MeasurementSystem;
  createdAt: string;
  dayKey: string;
};

export const MY_DAY_WEIGHT_KEY = "myDayWeightLogs";

function kgToPounds(value: number) {
  return value * 2.2046226218;
}

function poundsToKg(value: number) {
  return value * 0.45359237;
}

function roundWeight(value: number) {
  return Number(value.toFixed(1));
}

function normalizeWeightToKg(value: number, measurement: MeasurementSystem) {
  return measurement === "US" ? poundsToKg(value) : value;
}

function weightForDisplay(valueKg: number, measurement: MeasurementSystem) {
  return measurement === "US" ? kgToPounds(valueKg) : valueKg;
}

export function getWeightDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function loadWeightLogs(): Promise<MyDayWeightLog[]> {
  try {
    const [raw, storedMeasurement, storedMeasureSystem] = await Promise.all([
      AsyncStorage.getItem(MY_DAY_WEIGHT_KEY),
      AsyncStorage.getItem("measurement"),
      AsyncStorage.getItem("measureSystem"),
    ]);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const measurement = normalizeMeasurementSystem(storedMeasurement, storedMeasureSystem);
    const normalized = parsed
      .map((log) => {
        const valueKg =
          Number.isFinite(log?.valueKg) && log.valueKg > 0
            ? Number(log.valueKg)
            : Number.isFinite(log?.value)
              ? normalizeWeightToKg(Number(log.value), measurement)
              : null;
        if (!valueKg) return null;
        return {
          ...log,
          valueKg,
          sourceMeasurement: (log?.sourceMeasurement === "US" || log?.sourceMeasurement === "Metric"
            ? log.sourceMeasurement
            : measurement) as MeasurementSystem,
          value: roundWeight(weightForDisplay(valueKg, measurement)),
        } satisfies MyDayWeightLog;
      })
      .filter((log): log is MyDayWeightLog => !!log)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    const needsMigration = normalized.some(
      (log, index) =>
        !Number.isFinite(parsed[index]?.valueKg) ||
        parsed[index]?.value !== normalized[index]?.valueKg ||
        !parsed[index]?.sourceMeasurement
    );
    if (needsMigration) {
      await saveWeightLogs(normalized);
    }
    return normalized;
  } catch {
    return [];
  }
}

export async function saveWeightLogs(logs: MyDayWeightLog[]): Promise<void> {
  await AsyncStorage.setItem(
    MY_DAY_WEIGHT_KEY,
    JSON.stringify(
      logs.map((log) => {
        const valueKg =
          Number.isFinite(log.valueKg) && (log.valueKg ?? 0) > 0
            ? Number(log.valueKg)
            : normalizeWeightToKg(log.value, log.sourceMeasurement ?? "Metric");
        return {
          ...log,
          valueKg,
          value: roundWeight(valueKg),
          sourceMeasurement: log.sourceMeasurement ?? "Metric",
        };
      })
    )
  );
}

export async function addWeightLog(
  value: number,
  date = new Date(),
  measurement: MeasurementSystem = "Metric"
): Promise<MyDayWeightLog> {
  const logs = await loadWeightLogs();
  const dayKey = getWeightDayKey(date);
  const valueKg = normalizeWeightToKg(value, measurement);
  const nextLog: MyDayWeightLog = {
    id: nanoid(),
    value: roundWeight(weightForDisplay(valueKg, measurement)),
    valueKg,
    sourceMeasurement: measurement,
    createdAt: date.toISOString(),
    dayKey,
  };

  const withoutSameDay = logs.filter((log) => log.dayKey !== dayKey);
  const next = [...withoutSameDay, nextLog].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  await saveWeightLogs(next);
  return nextLog;
}

export async function updateWeightLog(
  id: string,
  value: number,
  date = new Date(),
  measurement: MeasurementSystem = "Metric"
): Promise<MyDayWeightLog | null> {
  const logs = await loadWeightLogs();
  const existing = logs.find((log) => log.id === id);
  if (!existing) return null;

  const dayKey = getWeightDayKey(date);
  const valueKg = normalizeWeightToKg(value, measurement);
  const updatedLog: MyDayWeightLog = {
    ...existing,
    value: roundWeight(weightForDisplay(valueKg, measurement)),
    valueKg,
    sourceMeasurement: measurement,
    createdAt: date.toISOString(),
    dayKey,
  };

  const next = logs
    .filter((log) => log.id !== id && log.dayKey !== dayKey)
    .concat(updatedLog)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  await saveWeightLogs(next);
  return updatedLog;
}

export async function deleteWeightLog(id: string): Promise<void> {
  const logs = await loadWeightLogs();
  const next = logs.filter((log) => log.id !== id);
  await saveWeightLogs(next);
}

export function latestWeightLog(logs: MyDayWeightLog[]) {
  if (logs.length === 0) return null;
  return logs[logs.length - 1];
}
