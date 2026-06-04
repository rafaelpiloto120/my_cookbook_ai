import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

import { getDayKey, loadMyDayMeals } from "../myDayMeals";
import { getWeightDayKey, loadWeightLogs } from "../myDayWeight";

export type WeightReminderFrequency = "daily" | "weekly";
export type MealReminderSlotId = "breakfast" | "lunch" | "dinner" | "snack" | "extra";

export type MealReminderSlot = {
  id: MealReminderSlotId;
  enabled: boolean;
  time: string;
};

export type LocalNotificationPreferences = {
  notificationsEnabled: boolean;
  mealReminderEnabled: boolean;
  mealReminderTime: string;
  mealReminderTimes: string[];
  mealReminderSlots: MealReminderSlot[];
  weightReminderEnabled: boolean;
  weightReminderTime: string;
  weightReminderFrequency: WeightReminderFrequency;
  offersUpdatesEnabled: boolean;
};

type ScheduledReminderIds = {
  meal: string[];
  weight: string[];
};

const NOTIFICATION_PREFS_KEY = "localNotificationPreferences";
const SCHEDULED_IDS_KEY = "localNotificationScheduledIds";
const REMINDER_CHANNEL_ID = "reminders";
const DEFAULT_MEAL_TIME = "20:30";
const DEFAULT_WEIGHT_TIME = "08:00";
const ALL_MEAL_REMINDER_SLOTS: MealReminderSlot[] = [
  { id: "breakfast", enabled: true, time: "08:30" },
  { id: "lunch", enabled: true, time: "13:00" },
  { id: "dinner", enabled: true, time: "20:30" },
  { id: "snack", enabled: true, time: "16:30" },
  { id: "extra", enabled: true, time: "22:00" },
];
const DEFAULT_MEAL_REMINDER_SLOTS = ALL_MEAL_REMINDER_SLOTS.slice(0, 1);
const MIN_MEAL_REMINDER_INTERVAL_MINUTES = 60;
const SCHEDULE_DAYS_AHEAD = 14;
const MIN_SCHEDULE_LEAD_MS = 30 * 1000;
const DATE_TRIGGER_TYPE = "date";

type OptionalNotificationsModule = typeof import("expo-notifications");
type NotificationResponseSubscription = { remove: () => void };

let cachedNotifications: OptionalNotificationsModule | null | undefined;

function getNotifications(): OptionalNotificationsModule | null {
  if (cachedNotifications !== undefined) return cachedNotifications;
  try {
    // Optional native module: older dev builds will not include it until rebuilt.
    cachedNotifications = require("expo-notifications") as OptionalNotificationsModule;
  } catch (err) {
    console.warn("[Notifications] expo-notifications native module is not available in this build", err);
    cachedNotifications = null;
  }
  return cachedNotifications;
}

export const defaultLocalNotificationPreferences: LocalNotificationPreferences = {
  notificationsEnabled: false,
  mealReminderEnabled: false,
  mealReminderTime: DEFAULT_MEAL_TIME,
  mealReminderTimes: [DEFAULT_MEAL_TIME],
  mealReminderSlots: DEFAULT_MEAL_REMINDER_SLOTS,
  weightReminderEnabled: false,
  weightReminderTime: DEFAULT_WEIGHT_TIME,
  weightReminderFrequency: "daily",
  offersUpdatesEnabled: false,
};

const COPY = {
  en: {
    mealTitle: "Time to log your meals",
    mealBody: "Add today's meals and keep your day on track.",
    weightTitle: "Quick weight check-in",
    weightBody: "Log your weight to keep your progress updated.",
  },
  es: {
    mealTitle: "Hora de registrar tus comidas",
    mealBody: "Añade las comidas de hoy y mantén tu día en buen camino.",
    weightTitle: "Registro rápido de peso",
    weightBody: "Registra tu peso para mantener tu progreso actualizado.",
  },
  pt: {
    mealTitle: "Hora de registar as refeições",
    mealBody: "Adicione as refeições de hoje e mantenha o dia no caminho certo.",
    weightTitle: "Registo rápido de peso",
    weightBody: "Registe o seu peso para manter o progresso atualizado.",
  },
  "pt-BR": {
    mealTitle: "Hora de registrar as refeições",
    mealBody: "Adicione as refeições de hoje e mantenha seu dia no caminho certo.",
    weightTitle: "Registro rápido de peso",
    weightBody: "Registre seu peso para manter seu progresso atualizado.",
  },
  fr: {
    mealTitle: "C'est le moment d'enregistrer vos repas",
    mealBody: "Ajoutez les repas du jour et gardez votre journée sur la bonne voie.",
    weightTitle: "Petit suivi du poids",
    weightBody: "Enregistrez votre poids pour garder votre progression à jour.",
  },
  de: {
    mealTitle: "Zeit, deine Mahlzeiten einzutragen",
    mealBody: "Füge die heutigen Mahlzeiten hinzu und bleib auf Kurs.",
    weightTitle: "Kurzer Gewichts-Check-in",
    weightBody: "Trage dein Gewicht ein, um deinen Fortschritt aktuell zu halten.",
  },
};

function normalizeLanguage(language?: string | null): keyof typeof COPY {
  if (language === "pt-BR") return "pt-BR";
  if (language === "es" || language === "pt" || language === "fr" || language === "de") return language;
  return "en";
}

function sanitizeTime(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? value : fallback;
}

function sanitizeTimeList(value: unknown, fallback: string[]) {
  const source = Array.isArray(value) ? value : [];
  const unique = Array.from(
    new Set(
      source
        .map((item) => (typeof item === "string" ? item : ""))
        .filter((item) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(item))
    )
  );
  return (unique.length ? unique : fallback).slice(0, 3).sort();
}

function sanitizeMealReminderSlots(value: unknown, legacyTimes: string[]): MealReminderSlot[] {
  const legacy = legacyTimes.length ? legacyTimes : [DEFAULT_MEAL_TIME];
  if (!Array.isArray(value)) {
    return DEFAULT_MEAL_REMINDER_SLOTS.map((slot, index) => ({
      ...slot,
      time: sanitizeTime(legacy[index], slot.time),
    }));
  }

  const validSlots = value
    .filter((slot) => ALL_MEAL_REMINDER_SLOTS.some((defaultSlot) => defaultSlot.id === slot?.id))
    .slice(0, ALL_MEAL_REMINDER_SLOTS.length);
  const sourceSlots = validSlots.length ? validSlots : DEFAULT_MEAL_REMINDER_SLOTS;

  return sourceSlots.map((sourceSlot, index) => {
    const defaultSlot =
      ALL_MEAL_REMINDER_SLOTS.find((slot) => slot.id === sourceSlot?.id) ?? DEFAULT_MEAL_REMINDER_SLOTS[index];
    return {
      id: defaultSlot.id,
      enabled: sourceSlot?.enabled === undefined ? defaultSlot.enabled : !!sourceSlot.enabled,
      time: sanitizeTime(sourceSlot?.time, sanitizeTime(legacy[index], defaultSlot.time)),
    };
  });
}

function parseTime(value: string) {
  const [hour, minute] = sanitizeTime(value, "08:00").split(":").map((part) => Number(part));
  return { hour, minute };
}

function minutesFromTime(value: string) {
  const { hour, minute } = parseTime(value);
  return hour * 60 + minute;
}

function minutesBetweenTimes(first: string, second: string) {
  const diff = Math.abs(minutesFromTime(first) - minutesFromTime(second));
  return Math.min(diff, 24 * 60 - diff);
}

function filterMealSlotsByMinimumInterval(slots: MealReminderSlot[]) {
  return [...slots]
    .filter((slot) => slot.enabled)
    .sort((a, b) => minutesFromTime(a.time) - minutesFromTime(b.time))
    .reduce<MealReminderSlot[]>((accepted, slot) => {
      const isTooClose = accepted.some(
        (acceptedSlot) => minutesBetweenTimes(acceptedSlot.time, slot.time) < MIN_MEAL_REMINDER_INTERVAL_MINUTES
      );
      return isTooClose ? accepted : [...accepted, slot];
    }, []);
}

function withTime(base: Date, time: string) {
  const { hour, minute } = parseTime(time);
  const next = new Date(base);
  next.setHours(hour, minute, 0, 0);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

async function readScheduledIds(): Promise<ScheduledReminderIds> {
  try {
    const raw = await AsyncStorage.getItem(SCHEDULED_IDS_KEY);
    if (!raw) return { meal: [], weight: [] };
    const parsed = JSON.parse(raw);
    return {
      meal: Array.isArray(parsed?.meal) ? parsed.meal.filter((id: unknown) => typeof id === "string") : [],
      weight: Array.isArray(parsed?.weight) ? parsed.weight.filter((id: unknown) => typeof id === "string") : [],
    };
  } catch {
    return { meal: [], weight: [] };
  }
}

async function writeScheduledIds(ids: ScheduledReminderIds) {
  await AsyncStorage.setItem(SCHEDULED_IDS_KEY, JSON.stringify(ids));
}

export async function loadLocalNotificationPreferences(): Promise<LocalNotificationPreferences> {
  try {
    const raw = await AsyncStorage.getItem(NOTIFICATION_PREFS_KEY);
    if (!raw) return defaultLocalNotificationPreferences;
    const parsed = JSON.parse(raw);
    const legacyMealTime = sanitizeTime(parsed?.mealReminderTime, DEFAULT_MEAL_TIME);
    const legacyMealTimes = sanitizeTimeList(parsed?.mealReminderTimes, [legacyMealTime]);
    const mealReminderEnabled =
      parsed?.mealReminderEnabled === undefined ? false : !!parsed.mealReminderEnabled;
    const weightReminderEnabled =
      parsed?.weightReminderEnabled === undefined ? false : !!parsed.weightReminderEnabled;
    const offersUpdatesEnabled = !!parsed?.offersUpdatesEnabled;
    return {
      notificationsEnabled: mealReminderEnabled || weightReminderEnabled || offersUpdatesEnabled,
      mealReminderEnabled,
      mealReminderTime: legacyMealTime,
      mealReminderTimes: legacyMealTimes,
      mealReminderSlots: sanitizeMealReminderSlots(parsed?.mealReminderSlots, legacyMealTimes),
      weightReminderEnabled,
      weightReminderTime: sanitizeTime(parsed?.weightReminderTime, DEFAULT_WEIGHT_TIME),
      weightReminderFrequency: parsed?.weightReminderFrequency === "weekly" ? "weekly" : "daily",
      offersUpdatesEnabled,
    };
  } catch {
    return defaultLocalNotificationPreferences;
  }
}

export async function saveLocalNotificationPreferences(
  prefs: Partial<LocalNotificationPreferences>
): Promise<LocalNotificationPreferences> {
  const current = await loadLocalNotificationPreferences();
  const next: LocalNotificationPreferences = {
    ...current,
    ...prefs,
    mealReminderTime: sanitizeTime(prefs.mealReminderTime ?? current.mealReminderTime, DEFAULT_MEAL_TIME),
    mealReminderTimes: sanitizeTimeList(
      prefs.mealReminderTimes ?? current.mealReminderTimes,
      [current.mealReminderTime || DEFAULT_MEAL_TIME]
    ),
    mealReminderSlots: sanitizeMealReminderSlots(prefs.mealReminderSlots ?? current.mealReminderSlots, current.mealReminderTimes),
    weightReminderTime: sanitizeTime(prefs.weightReminderTime ?? current.weightReminderTime, DEFAULT_WEIGHT_TIME),
    weightReminderFrequency:
      (prefs.weightReminderFrequency ?? current.weightReminderFrequency) === "weekly" ? "weekly" : "daily",
  };
  await AsyncStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(next));
  return next;
}

export async function ensureReminderNotificationPermission() {
  if (Platform.OS === "web") return false;
  const Notifications = getNotifications();
  if (!Notifications) return false;
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export async function configureLocalNotifications() {
  const Notifications = getNotifications();
  if (!Notifications) return;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
      name: "Reminders",
      importance: Notifications.AndroidImportance?.DEFAULT ?? 3,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#A15C38",
    });
  }
}

export async function cancelAllLocalReminders() {
  const Notifications = getNotifications();
  if (!Notifications) {
    await writeScheduledIds({ meal: [], weight: [] });
    return;
  }
  const ids = await readScheduledIds();
  await Notifications.cancelAllScheduledNotificationsAsync?.().catch(() => undefined);
  await Promise.all(
    [...ids.meal, ...ids.weight].map((id) =>
      Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)
    )
  );
  await writeScheduledIds({ meal: [], weight: [] });
}

async function countMealsForDay(dayKey: string) {
  const meals = await loadMyDayMeals();
  return meals.filter((meal) => meal.dayKey === dayKey).length;
}

async function hasWeightForDay(dayKey: string) {
  const logs = await loadWeightLogs();
  return logs.some((log) => log.dayKey === dayKey);
}

function isWeeklyWeightDay(date: Date) {
  return date.getDay() === 1;
}

async function scheduleReminder({
  date,
  title,
  body,
  type,
}: {
  date: Date;
  title: string;
  body: string;
  type: "meal" | "weight";
}) {
  const Notifications = getNotifications();
  if (!Notifications) return null;
  return Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: {
        type,
        screen: type === "weight" ? "/my-day/weight" : "/my-day",
        action: type === "weight" ? "logWeight" : "addMeal",
      },
    },
    trigger: {
      type: DATE_TRIGGER_TYPE,
      date,
      channelId: REMINDER_CHANNEL_ID,
    } as any,
  });
}

export async function refreshLocalReminderSchedule() {
  const Notifications = getNotifications();
  if (!Notifications) return;
  await configureLocalNotifications();
  await cancelAllLocalReminders();

  const prefs = await loadLocalNotificationPreferences();
  if (!prefs.notificationsEnabled) return;
  if (!prefs.mealReminderEnabled && !prefs.weightReminderEnabled) return;

  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;

  const language = normalizeLanguage(await AsyncStorage.getItem("userLanguage"));
  const copy = COPY[language];
  const now = new Date();
  const earliestScheduleTime = now.getTime() + MIN_SCHEDULE_LEAD_MS;
  const nextIds: ScheduledReminderIds = { meal: [], weight: [] };

  for (let offset = 0; offset < SCHEDULE_DAYS_AHEAD; offset += 1) {
    const base = addDays(now, offset);

    if (prefs.mealReminderEnabled) {
      const dayKey = getDayKey(base);
      const mealCount = await countMealsForDay(dayKey);
      const enabledMealSlots = filterMealSlotsByMinimumInterval(prefs.mealReminderSlots);
      for (const [index, mealSlot] of enabledMealSlots.entries()) {
        const target = withTime(base, mealSlot.time);
        if (target.getTime() > earliestScheduleTime && mealCount <= index) {
          const id = await scheduleReminder({
            date: target,
            title: copy.mealTitle,
            body: copy.mealBody,
            type: "meal",
          });
          if (id) nextIds.meal.push(id);
        }
      }
    }

    if (prefs.weightReminderEnabled) {
      const target = withTime(base, prefs.weightReminderTime);
      const allowedByFrequency =
        prefs.weightReminderFrequency === "daily" || isWeeklyWeightDay(target);
      if (allowedByFrequency && target.getTime() > earliestScheduleTime && !(await hasWeightForDay(getWeightDayKey(target)))) {
        const id = await scheduleReminder({
          date: target,
          title: copy.weightTitle,
          body: copy.weightBody,
          type: "weight",
        });
        if (id) nextIds.weight.push(id);
      }
    }
  }

  await writeScheduledIds(nextIds);
}

export function addLocalNotificationResponseListener(
  callback: (screen: string | null, action: string | null) => void
): NotificationResponseSubscription {
  const Notifications = getNotifications();
  if (!Notifications) return { remove: () => undefined };
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const screen = response.notification.request.content.data?.screen;
    const action = response.notification.request.content.data?.action;
    callback(typeof screen === "string" ? screen : null, typeof action === "string" ? action : null);
  });
}

export async function sendTestLocalReminderNotification(type: "meal" | "weight") {
  const Notifications = getNotifications();
  if (!Notifications) return false;
  await configureLocalNotifications();
  const permission = await ensureReminderNotificationPermission();
  if (!permission) return false;

  const language = normalizeLanguage(await AsyncStorage.getItem("userLanguage"));
  const copy = COPY[language];
  await Notifications.scheduleNotificationAsync({
    content: {
      title: type === "weight" ? copy.weightTitle : copy.mealTitle,
      body: type === "weight" ? copy.weightBody : copy.mealBody,
      data: {
        type,
        screen: type === "weight" ? "/my-day/weight" : "/my-day",
        action: type === "weight" ? "logWeight" : "addMeal",
      },
    },
    trigger: null,
  });
  return true;
}
