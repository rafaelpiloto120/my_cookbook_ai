import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { MaterialIcons } from "@expo/vector-icons";

import AppCard from "../../../components/AppCard";
import { useThemeColors } from "../../../context/ThemeContext";
import { loadMyDayProfile, MyDayPlan } from "../../../lib/myDay";
import { getDayKey, loadMyDayMeals } from "../../../lib/myDayMeals";

type TrendPoint = {
  dayKey: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  label: string;
  status: "logged" | "missed" | "future" | "today-empty";
};

type HistoryPoint = {
  dayKey: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

type DayInsight = {
  icon: string;
  tone: "positive" | "caution" | "warning" | "neutral";
  message: string;
};

function getMondayWeekStart(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  return start;
}

function formatWeekTrendLabel(date: Date, locale: string) {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" })
    .format(date)
    .replace(".", "")
    .slice(0, 3);
  const day = new Intl.DateTimeFormat(locale, { day: "numeric" }).format(date);
  const normalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${normalizedWeekday}, ${day}`;
}

function formatWeekRangeLabel(weekStart: Date, locale: string) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth() && weekStart.getFullYear() === weekEnd.getFullYear();
  if (sameMonth) {
    const monthYear = new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }).format(weekStart);
    return `${weekStart.getDate()}-${weekEnd.getDate()} ${monthYear}`;
  }
  return `${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(weekStart)} - ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(weekEnd)}`;
}

export default function MyDayTrendsScreen() {
  const { t, i18n } = useTranslation();
  const { bg, text, subText, cta, isDark } = useThemeColors();
  const router = useRouter();
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);
  const [target, setTarget] = useState<number | null>(null);
  const [plan, setPlan] = useState<MyDayPlan | null>(null);
  const [selectedWeekStart, setSelectedWeekStart] = useState(() => getMondayWeekStart(new Date()));

  const locale = useMemo(() => (i18n.language === "pt" ? "pt-PT" : i18n.language || "en"), [i18n.language]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      (async () => {
        const meals = await loadMyDayMeals();
        const profile = await loadMyDayProfile();
        const historyByDay = new Map<string, HistoryPoint>();

        meals.forEach((meal) => {
          const current = historyByDay.get(meal.dayKey) ?? {
            dayKey: meal.dayKey,
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
          };
          current.calories += meal.calories;
          current.protein += meal.protein;
          current.carbs += meal.carbs;
          current.fat += meal.fat;
          historyByDay.set(meal.dayKey, current);
        });

        if (!cancelled) {
          setHistoryPoints(
            Array.from(historyByDay.values())
              .filter((point) => point.calories > 0)
              .sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1))
          );
          setPlan(profile.plan ?? null);
          setTarget(profile.plan?.calories ?? null);
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [locale])
  );

  const historyByDay = useMemo(
    () => new Map(historyPoints.map((point) => [point.dayKey, point])),
    [historyPoints]
  );
  const currentWeekStart = useMemo(() => getMondayWeekStart(new Date()), []);
  const selectedWeekKey = getDayKey(selectedWeekStart);
  const currentWeekKey = getDayKey(currentWeekStart);
  const canGoForward = selectedWeekKey < currentWeekKey;
  const selectedWeekLabel = useMemo(
    () => formatWeekRangeLabel(selectedWeekStart, locale),
    [locale, selectedWeekStart]
  );
  const currentWeekLabel = useMemo(() => {
    const label = String(t("my_day.range_week", { defaultValue: "This week" }));
    return label.trim().toLowerCase() === "this" ? "This week" : label;
  }, [t]);
  const goToPreviousWeek = () => {
    setSelectedWeekStart((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() - 7);
      return next;
    });
  };
  const goToNextWeek = () => {
    setSelectedWeekStart((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() + 7);
      return getDayKey(next) > currentWeekKey ? currentWeekStart : next;
    });
  };
  const points = useMemo<TrendPoint[]>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = getDayKey(today);
    const startDate = new Date(selectedWeekStart);
    startDate.setHours(0, 0, 0, 0);

    return Array.from({ length: 7 }, (_, index) => {
      const cursor = new Date(startDate);
      cursor.setDate(startDate.getDate() + index);
      const dayKey = getDayKey(cursor);
      const dayTotals = historyByDay.get(dayKey);
      const calories = dayTotals?.calories ?? 0;
      const status: TrendPoint["status"] =
        calories > 0
          ? "logged"
          : dayKey > todayKey
            ? "future"
            : dayKey < todayKey
              ? "missed"
              : "today-empty";
      return {
        dayKey,
        calories,
        protein: dayTotals?.protein ?? 0,
        carbs: dayTotals?.carbs ?? 0,
        fat: dayTotals?.fat ?? 0,
        label: formatWeekTrendLabel(cursor, locale),
        status,
      };
    });
  }, [historyByDay, locale, selectedWeekStart]);
  const loggedPoints = points.filter((point) => point.calories > 0);
  const selectedWeekHistoryPoints = useMemo(
    () =>
      points
        .filter((point) => point.calories > 0)
        .map(({ dayKey, calories, protein, carbs, fat }) => ({ dayKey, calories, protein, carbs, fat }))
        .reverse(),
    [points]
  );
  const average = loggedPoints.length
    ? Math.round(loggedPoints.reduce((sum, point) => sum + point.calories, 0) / loggedPoints.length)
    : 0;
  const chartMax = Math.max(...points.map((point) => point.calories), target || 0, 1);
  const goalHeight = target ? (target / chartMax) * 100 : 0;
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
    [locale]
  );
  const insightToneColors: Record<DayInsight["tone"], string> = {
    positive: "#2E7D32",
    caution: "#B7791F",
    warning: "#B94A48",
    neutral: subText,
  };
  const getDayInsight = (point: HistoryPoint): DayInsight => {
    if (!plan) {
      return {
        icon: "track-changes",
        tone: "neutral",
        message: t("my_day.trend_history_goal_missing", {
          defaultValue: "Set a daily goal to compare this day against your plan.",
        }),
      };
    }

    const calorieDiff = point.calories - plan.calories;
    if (calorieDiff > 0) {
      return {
        icon: "warning-amber",
        tone: "warning",
        message: t("my_day.trend_history_calories_over", {
          defaultValue: "Calories were {{count}} kcal above goal.",
          count: Math.round(calorieDiff),
        }),
      };
    }

    const macroEntries = [
      { key: "protein", label: t("my_day.protein", { defaultValue: "Protein" }), value: point.protein, target: plan.protein },
      { key: "carbs", label: t("my_day.carbs", { defaultValue: "Carbs" }), value: point.carbs, target: plan.carbs },
      { key: "fat", label: t("my_day.fat", { defaultValue: "Fat" }), value: point.fat, target: plan.fat },
    ];
    const macroOver = macroEntries
      .filter((macro) => macro.target > 0 && macro.value > macro.target * 1.1)
      .sort((a, b) => b.value / b.target - a.value / a.target)[0];
    if (macroOver) {
      return {
        icon: "warning-amber",
        tone: "warning",
        message: t("my_day.trend_history_macro_over", {
          defaultValue: "{{macro}} was above goal, even though calories stayed within plan.",
          macro: macroOver.label,
        }),
      };
    }

    if (plan.protein > 0 && point.protein < plan.protein * 0.7) {
      return {
        icon: "error-outline",
        tone: "caution",
        message: t("my_day.trend_history_protein_low", {
          defaultValue: "Protein was below goal for this day.",
        }),
      };
    }

    return {
      icon: "sentiment-very-satisfied",
      tone: "positive",
      message: t("my_day.trend_history_on_track", {
        defaultValue: "Calories and macros were broadly on track for this day.",
      }),
    };
  };

  return (
    <View style={[styles.screen, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t("my_day.trend_details", { defaultValue: "Trend details" }),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
          headerLeft: () => (
            <TouchableOpacity activeOpacity={0.8} onPress={() => router.replace("/my-day")} style={styles.backButton}>
              <MaterialIcons name="arrow-back" size={26} color="#fff" />
            </TouchableOpacity>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <AppCard>
          <Text style={[styles.sectionTitle, { color: text }]}>
            {t("my_day.weekly_trends", { defaultValue: "Weekly trends" })}
          </Text>
          <View style={styles.trendStatsRow}>
            <View style={styles.trendStatBlock}>
              <Text style={[styles.trendStatLabel, styles.trendAverageLabel, { color: subText }]}>
                {t("my_day.average_daily_intake", { defaultValue: "Average daily intake" })}
              </Text>
              <Text style={[styles.trendStatValue, styles.trendStatValueLarge, { color: text }]}>
                {average} kcal
              </Text>
            </View>
            <View style={[styles.trendStatBlock, styles.trendStatBlockRight]}>
              <Text style={[styles.trendStatLabel, styles.trendAverageLabel, { color: subText }]}>
                {t("my_day.goal_days_met", { defaultValue: "Days within goal" })}
              </Text>
              <Text style={[styles.trendStatValue, { color: text }]}>
                {target ? `${loggedPoints.filter((point) => point.calories <= target).length}/7` : "—"}
              </Text>
            </View>
          </View>
          <View style={styles.weekPickerRow}>
            <TouchableOpacity
              activeOpacity={0.82}
              style={[styles.weekPickerButton, { borderColor: `${subText}33`, backgroundColor: bg }]}
              onPress={goToPreviousWeek}
            >
              <MaterialIcons name="chevron-left" size={22} color={text} />
            </TouchableOpacity>
            <View style={styles.weekPickerLabelWrap}>
              <Text style={[styles.weekPickerEyebrow, { color: subText }]}>
                {selectedWeekKey === currentWeekKey
                  ? currentWeekLabel
                  : t("my_day.week_label", { defaultValue: "Week" })}
              </Text>
              <Text style={[styles.weekPickerLabel, { color: text }]} numberOfLines={1}>
                {selectedWeekLabel}
              </Text>
            </View>
            <TouchableOpacity
              activeOpacity={0.82}
              disabled={!canGoForward}
              style={[
                styles.weekPickerButton,
                {
                  borderColor: `${subText}33`,
                  backgroundColor: bg,
                  opacity: canGoForward ? 1 : 0.35,
                },
              ]}
              onPress={goToNextWeek}
            >
              <MaterialIcons name="chevron-right" size={22} color={text} />
            </TouchableOpacity>
          </View>
          <View style={styles.trendBars}>
            {points.map((point) => {
              const actualHeight = target ? (point.calories / chartMax) * 100 : 0;
              const goalColor =
                point.status === "future"
                  ? isDark ? "#5A606A" : "#E2E5E9"
                  : point.status === "missed"
                    ? isDark ? "#444A53" : "#C5CAD1"
                    : isDark ? "#5A606A" : "#D7DBE0";
              return (
                <View key={point.dayKey} style={styles.trendBarColumn}>
                  <View style={styles.trendBarTrack}>
                    <View
                      style={[
                        styles.trendGoalBar,
                        {
                          backgroundColor: goalColor,
                          height: `${goalHeight}%`,
                          opacity: point.status === "future" ? 0.55 : 1,
                        },
                      ]}
                    />
                    {point.calories > 0 ? (
                      <View
                        style={[
                          styles.trendBarFill,
                          {
                            backgroundColor: cta,
                            height: `${Math.max(actualHeight, 8)}%`,
                          },
                        ]}
                      />
                    ) : point.status === "missed" ? (
                      <Text style={[styles.trendBarStatusDash, { color: subText }]}>—</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.trendBarLabel, { color: subText }]}>
                    {point.label}
                  </Text>
                </View>
              );
            })}
          </View>
        </AppCard>

        <AppCard>
          <Text style={[styles.sectionTitle, { color: text }]}>
            {t("my_day.weight_history", { defaultValue: "History" })}
          </Text>
          {selectedWeekHistoryPoints.length === 0 ? (
            <View style={styles.emptyHistoryWrap}>
              <Text style={[styles.emptyHistoryTitle, { color: text }]}>
                {t("my_day.trend_history_week_empty_title", { defaultValue: "No meals logged this week" })}
              </Text>
              <Text style={[styles.metaText, styles.emptyHistoryBody, { color: subText }]}>
                {t("my_day.trend_history_week_empty_body", {
                  defaultValue: "History only shows days with logged meals for the selected week.",
                })}
              </Text>
            </View>
          ) : (
            <View>
              {selectedWeekHistoryPoints.map((point, index) => {
                const [year, month, day] = point.dayKey.split("-").map(Number);
                const date = new Date(year, month - 1, day);
                const insight = getDayInsight(point);
                const insightColor = insightToneColors[insight.tone];
                return (
                  <View
                    key={point.dayKey}
                    style={[
                      styles.historyRow,
                      { borderBottomColor: index < selectedWeekHistoryPoints.length - 1 ? `${subText}24` : "transparent" },
                    ]}
                  >
                    <View style={styles.timelineLineWrap}>
                      <View style={[styles.timelineDot, { backgroundColor: cta }]} />
                      <View style={[styles.timelineLine, { backgroundColor: `${cta}44` }]} />
                    </View>
                    <View style={styles.historyCopy}>
                      <View style={styles.historyTopRow}>
                        <View style={styles.historyMainCopy}>
                          <Text style={[styles.historyDate, { color: text }]}>
                            {dateFormatter.format(date)}
                          </Text>
                          <Text style={[styles.historyCalories, { color: text }]}>
                            {`${Math.round(point.calories)} kcal`}
                          </Text>
                        </View>
                        <View style={styles.historyGoalBadge}>
                          <Text style={[styles.historyGoalLabel, { color: subText }]}>VS GOAL</Text>
                          <Text style={[styles.historyGoalValue, { color: text }]}>
                            {target ? `${point.calories - target > 0 ? "+" : ""}${Math.round(point.calories - target)} kcal` : "—"}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.historyMacroRow}>
                        {[
                          { key: "protein", label: t("my_day.protein", { defaultValue: "Protein" }), value: point.protein },
                          { key: "carbs", label: t("my_day.carbs", { defaultValue: "Carbs" }), value: point.carbs },
                          { key: "fat", label: t("my_day.fat", { defaultValue: "Fat" }), value: point.fat },
                        ].map((macro) => (
                          <Text key={macro.key} style={[styles.historyMacroText, { color: subText }]}>
                            {`${macro.label} ${Math.round(macro.value)}g`}
                          </Text>
                        ))}
                      </View>
                      <View style={styles.historyInsightRow}>
                        <MaterialIcons name={insight.icon as any} size={15} color={insightColor} />
                        <Text style={[styles.historyInsightText, { color: subText }]}>
                          {insight.message}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </AppCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, paddingBottom: 24 },
  backButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 14,
  },
  trendBars: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    height: 104,
    marginBottom: 10,
  },
  trendStatsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 12,
  },
  trendStatBlock: {
    flex: 1,
  },
  trendStatBlockRight: {
    alignItems: "flex-end",
  },
  trendAverageLabel: {
    textTransform: "uppercase",
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: 3,
  },
  trendStatValue: {
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 2,
  },
  trendStatValueLarge: {
    fontSize: 20,
  },
  trendStatLabel: {
    fontSize: 12,
    lineHeight: 16,
  },
  weekPickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 14,
  },
  weekPickerButton: {
    width: 36,
    height: 36,
    borderWidth: 1,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  weekPickerLabelWrap: {
    flex: 1,
    alignItems: "center",
  },
  weekPickerEyebrow: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
  },
  weekPickerLabel: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "800",
    marginTop: 1,
  },
  trendBarColumn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
  },
  trendBarTrack: {
    width: "78%",
    flex: 1,
    position: "relative",
    borderRadius: 10,
    justifyContent: "flex-end",
    marginBottom: 6,
  },
  trendGoalBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    width: "100%",
    borderRadius: 10,
  },
  trendBarFill: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    width: "100%",
    borderRadius: 10,
  },
  trendBarStatusDash: {
    position: "absolute",
    alignSelf: "center",
    top: "45%",
    fontSize: 12,
    fontWeight: "800",
  },
  trendBarLabel: {
    fontSize: 10,
    fontWeight: "700",
    lineHeight: 13,
  },
  metaText: {
    fontSize: 13,
  },
  emptyHistoryWrap: {
    paddingVertical: 4,
  },
  emptyHistoryTitle: {
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 4,
  },
  emptyHistoryBody: {
    lineHeight: 18,
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  timelineLineWrap: {
    width: 18,
    alignItems: "center",
    marginTop: 4,
  },
  timelineDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  timelineLine: {
    width: 2,
    flex: 1,
    marginTop: 4,
    minHeight: 34,
    borderRadius: 999,
  },
  historyCopy: {
    flex: 1,
    paddingLeft: 8,
  },
  historyTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  historyMainCopy: {
    flex: 1,
  },
  historyGoalBadge: {
    alignItems: "flex-end",
    maxWidth: 120,
  },
  historyGoalLabel: {
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 15,
  },
  historyGoalValue: {
    fontSize: 14,
    fontWeight: "700",
    marginTop: 2,
  },
  historyDate: {
    fontSize: 15,
    fontWeight: "700",
  },
  historyCalories: {
    fontSize: 15,
    fontWeight: "700",
    marginTop: 2,
  },
  historyMacroRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 6,
  },
  historyMacroText: {
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 16,
  },
  historyInsightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 7,
  },
  historyInsightText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
});
