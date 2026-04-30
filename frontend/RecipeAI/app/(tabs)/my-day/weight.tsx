import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { Stack, useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { MaterialIcons } from "@expo/vector-icons";
import { Canvas, Path as SkiaPath, Skia } from "@shopify/react-native-skia";

import AppCard from "../../../components/AppCard";
import { useAuth } from "../../../context/AuthContext";
import { useThemeColors } from "../../../context/ThemeContext";
import { formatWeightFromKg, loadMeasurementSystemPreference, loadMyDayProfile, MyDayProfile } from "../../../lib/myDay";
import {
  addWeightLog,
  deleteWeightLog,
  getWeightDayKey,
  latestWeightLog,
  loadWeightLogs,
  MyDayWeightLog,
  updateWeightLog,
} from "../../../lib/myDayWeight";
import { useSyncEngine } from "../../../lib/sync/SyncEngine";

type MeasurementSystem = "US" | "Metric";

function clampPercent(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function hexToRgba(color: string, alpha: number) {
  if (!color.startsWith("#")) return color;
  const normalized = color.slice(1);
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized.slice(0, 6);

  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);

  if ([r, g, b].some((value) => Number.isNaN(value))) return color;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function chartPointLabelWidth(value: number | string) {
  return Math.max(36, Math.min(56, String(value).length * 9 + 8));
}

export default function MyDayWeightScreen() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const { bg, text, subText, border, cta, primary, card, modalBackdrop } = useThemeColors();
  const { width: viewportWidth } = useWindowDimensions();
  const router = useRouter();
  const syncEngine = useSyncEngine();
  const [logs, setLogs] = useState<MyDayWeightLog[]>([]);
  const [profile, setProfile] = useState<MyDayProfile | null>(null);
  const [weightInput, setWeightInput] = useState("");
  const [goalWeight, setGoalWeight] = useState("");
  const [measurement, setMeasurement] = useState<MeasurementSystem>("Metric");
  const [selectedDay, setSelectedDay] = useState("");
  const [calendarVisible, setCalendarVisible] = useState(false);
  const [editingLog, setEditingLog] = useState<MyDayWeightLog | null>(null);
  const [weightModalVisible, setWeightModalVisible] = useState(false);
  const [historyVisibleCount, setHistoryVisibleCount] = useState(5);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [goalType, setGoalType] = useState<"lose" | "maintain" | "gain">("maintain");
  const [rangeKey, setRangeKey] = useState<"week" | "month" | "six_months" | "all">("week");
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  useEffect(() => {
    setLogs([]);
    setProfile(null);
    setWeightInput("");
    setGoalWeight("");
    setSelectedDay("");
    setCalendarVisible(false);
    setEditingLog(null);
    setWeightModalVisible(false);
    setSelectedEntryId(null);
  }, [user?.uid]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      (async () => {
        const profile = await loadMyDayProfile();
        let nextLogs = await loadWeightLogs();
        const storedMeasurement = await loadMeasurementSystemPreference();

        if (nextLogs.length === 0 && profile.currentWeight) {
          const parsedProfileWeight = Number(profile.currentWeight.replace(",", "."));
          if (Number.isFinite(parsedProfileWeight) && parsedProfileWeight > 0) {
            const createdWeightLog = await addWeightLog(parsedProfileWeight, new Date(), storedMeasurement);
            if (typeof (syncEngine as any)?.markMyDayWeightDirty === "function") {
              await (syncEngine as any).markMyDayWeightDirty({
                id: createdWeightLog.id,
                createdAt: createdWeightLog.createdAt,
                dayKey: createdWeightLog.dayKey,
                weight: String(createdWeightLog.value),
                normalizedWeightKg:
                  Number.isFinite(createdWeightLog.valueKg) ? Number(createdWeightLog.valueKg) : null,
              });
            }
            nextLogs = await loadWeightLogs();
          }
        }

        if (!cancelled) {
          setProfile(profile);
          setLogs(nextLogs);
          setSelectedEntryId((prev) => prev ?? nextLogs[nextLogs.length - 1]?.id ?? null);
          setGoalWeight(
            profile.targetWeightKg != null
              ? formatWeightFromKg(profile.targetWeightKg, storedMeasurement)
              : profile.targetWeight || ""
          );
          setGoalType(
            profile.goalType === "lose" || profile.goalType === "gain" || profile.goalType === "maintain"
              ? profile.goalType
              : "maintain"
          );
          setMeasurement(storedMeasurement);
          setWeightInput("");
          setSelectedDay("");
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [syncEngine])
  );

  const latest = latestWeightLog(logs);
  const unit = measurement === "US" ? "lb" : "kg";
  const allLogs = useMemo(() => [...logs], [logs]);
  const displayedGoalWeight =
    profile?.targetWeightKg != null
      ? formatWeightFromKg(profile.targetWeightKg, measurement)
      : goalWeight;
  const goalWeightNumber = Number(displayedGoalWeight || 0);
  const weightStartValue =
    profile?.currentWeightKg != null
      ? Number(formatWeightFromKg(profile.currentWeightKg, measurement))
      : profile?.currentWeight
        ? Number(profile.currentWeight.replace(",", "."))
        : latest?.value ?? 0;
  const weightPlanUpdatedAt = profile?.updatedAt ? new Date(profile.updatedAt) : null;
  const weightRemainingToGoal =
    latest && Number.isFinite(goalWeightNumber) && goalWeightNumber > 0
      ? Math.abs(latest.value - goalWeightNumber)
      : null;
  const weightProgressRatio = useMemo(() => {
    if (!latest || !Number.isFinite(goalWeightNumber) || goalWeightNumber <= 0) return 0;
    if (!Number.isFinite(weightStartValue) || weightStartValue <= 0) return 0;
    if (goalType === "maintain") return 1;
    const totalDistance = Math.abs(weightStartValue - goalWeightNumber);
    if (totalDistance <= 0.01) return 1;
    const covered = totalDistance - Math.abs(latest.value - goalWeightNumber);
    return clampPercent(covered / totalDistance);
  }, [goalType, goalWeightNumber, latest, weightStartValue]);
  const rangeOptions = useMemo(
    () => [
      { key: "week" as const, label: t("my_day.range_week", { defaultValue: "This week" }) },
      { key: "month" as const, label: t("my_day.range_month", { defaultValue: "Last month" }) },
      { key: "six_months" as const, label: t("my_day.range_six_months", { defaultValue: "Last 6 months" }) },
      { key: "all" as const, label: t("my_day.range_all", { defaultValue: "All" }) },
    ],
    [t]
  );
  const filteredLogs = useMemo(() => {
    if (allLogs.length === 0) return [];
    if (rangeKey === "all") return allLogs;
    const now = new Date();
    const startDate = new Date(now);
    if (rangeKey === "week") {
      startDate.setDate(now.getDate() - 6);
      startDate.setHours(0, 0, 0, 0);
    } else if (rangeKey === "month") {
      startDate.setMonth(now.getMonth() - 1);
    } else if (rangeKey === "six_months") {
      startDate.setMonth(now.getMonth() - 6);
    }
    return allLogs.filter((log) => new Date(log.createdAt) >= startDate);
  }, [allLogs, rangeKey]);
  const chartLogs = filteredLogs.length > 0 ? filteredLogs : allLogs;
  const chartMin = chartLogs.length > 0 ? Math.min(...chartLogs.map((log) => log.value), Number.isFinite(goalWeightNumber) ? goalWeightNumber : Infinity) : 0;
  const chartMax = chartLogs.length > 0 ? Math.max(...chartLogs.map((log) => log.value), Number.isFinite(goalWeightNumber) ? goalWeightNumber : -Infinity) : 1;
  const chartRange = Math.max(chartMax - chartMin, 0.5);
  const chartTopPadding = 30;
  const chartHeight = 170;
  const chartBottomInset = 32;
  const chartXAxisBottomOffset = 22;
  const chartXAxisY = chartTopPadding + chartHeight + chartBottomInset - chartXAxisBottomOffset;
  const pointStart = 10;
  const chartViewportWidth = Math.max(viewportWidth - 122, 220);
  const pointGap =
    chartLogs.length > 1
      ? Math.max(42, (chartViewportWidth - pointStart * 2 - 24) / (chartLogs.length - 1))
      : 0;
  const chartWidth =
    chartLogs.length > 1
      ? Math.max(chartViewportWidth, pointStart * 2 + (chartLogs.length - 1) * pointGap + 24)
      : chartViewportWidth;
  const chartPoints = chartLogs.map((log, index) => ({
    ...log,
    x: chartLogs.length === 1 ? chartWidth / 2 : pointStart + index * pointGap,
    y: chartTopPadding + chartHeight - ((log.value - chartMin) / chartRange) * chartHeight,
  }));
  const goalLineY =
    Number.isFinite(goalWeightNumber) ? chartTopPadding + chartHeight - ((goalWeightNumber - chartMin) / chartRange) * chartHeight : null;
  const axisEntries = useMemo(() => {
    const raw = [
      { value: chartMax, goal: false },
      { value: chartMin + chartRange / 2, goal: false },
      { value: chartMin, goal: false },
      ...(Number.isFinite(goalWeightNumber) ? [{ value: goalWeightNumber, goal: true }] : []),
    ];
    const deduped: { value: number; goal: boolean }[] = [];
    raw
      .sort((a, b) => b.value - a.value)
      .forEach((entry) => {
        const existing = deduped.find((item) => Math.abs(item.value - entry.value) < 0.15);
        if (existing) {
          if (entry.goal) existing.goal = true;
          return;
        }
        deduped.push({ ...entry });
      });
    return deduped;
  }, [chartMax, chartMin, chartRange, goalWeightNumber]);
  const selectedEntry =
    allLogs.find((log) => log.id === selectedEntryId) ??
    allLogs[allLogs.length - 1] ??
    null;
  const selectedEntryIndex = selectedEntry
    ? allLogs.findIndex((log) => log.id === selectedEntry.id)
    : -1;
  const previousEntry = selectedEntryIndex > 0 ? allLogs[selectedEntryIndex - 1] : null;
  const changeFromPreviousKg =
    previousEntry && selectedEntry ? selectedEntry.value - previousEntry.value : null;

  useEffect(() => {
    if (logs.length === 0) {
      if (selectedEntryId !== null) setSelectedEntryId(null);
      return;
    }
    if (!selectedEntryId || !logs.some((log) => log.id === selectedEntryId)) {
      setSelectedEntryId(logs[logs.length - 1].id);
    }
  }, [logs, selectedEntryId]);

  useEffect(() => {
    if (chartLogs.length === 0) return;
    if (!selectedEntryId || !chartLogs.some((log) => log.id === selectedEntryId)) {
      setSelectedEntryId(chartLogs[chartLogs.length - 1].id);
    }
  }, [chartLogs, selectedEntryId]);

  const handleSave = async () => {
    const parsed = Number(weightInput.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const [year, month, day] = selectedDay.split("-").map(Number);
    const targetDate = year && month && day ? new Date(year, month - 1, day) : new Date();
    if (editingLog) {
      const updated = await updateWeightLog(editingLog.id, parsed, targetDate, measurement);
      if (updated && typeof (syncEngine as any)?.markMyDayWeightDirty === "function") {
        await (syncEngine as any).markMyDayWeightDirty({
          id: updated.id,
          createdAt: updated.createdAt,
          dayKey: updated.dayKey,
          weight: String(updated.value),
          normalizedWeightKg:
            Number.isFinite(updated.valueKg) ? Number(updated.valueKg) : null,
        });
      }
    } else {
      const created = await addWeightLog(parsed, targetDate, measurement);
      if (typeof (syncEngine as any)?.markMyDayWeightDirty === "function") {
        await (syncEngine as any).markMyDayWeightDirty({
          id: created.id,
          createdAt: created.createdAt,
          dayKey: created.dayKey,
          weight: String(created.value),
          normalizedWeightKg:
            Number.isFinite(created.valueKg) ? Number(created.valueKg) : null,
        });
      }
    }
    const nextLogs = await loadWeightLogs();
    setLogs(nextLogs);
    const savedDayKey = getWeightDayKey(targetDate);
    const matchingLog = nextLogs.find((log) => log.dayKey === savedDayKey);
    setSelectedEntryId(matchingLog?.id ?? nextLogs[nextLogs.length - 1]?.id ?? null);
    setWeightInput("");
    setSelectedDay("");
    setEditingLog(null);
    setWeightModalVisible(false);
  };

  const openCreateModal = () => {
    setEditingLog(null);
    setWeightInput("");
    setSelectedDay("");
    setWeightModalVisible(true);
  };

  const openEditModal = (log: MyDayWeightLog) => {
    setEditingLog(log);
    setWeightInput(String(log.value));
    setSelectedDay(log.dayKey);
    setWeightModalVisible(true);
  };

  const closeWeightModal = () => {
    setWeightModalVisible(false);
    setEditingLog(null);
    setWeightInput("");
    setSelectedDay("");
  };

  const progressText = useMemo(() => {
    if (!latest) {
      return t("my_day.weight_hint_empty", {
        defaultValue: "Add your weight to start seeing your progress over time.",
      });
    }
    if (!displayedGoalWeight) {
      return t("my_day.weight_goal_missing_body", {
        defaultValue: "Add a target weight",
      });
    }
    if (goalType === "maintain") {
      return t("my_day.weight_progress_maintain", {
        defaultValue: "Tracking how steady you stay around your current weight.",
      });
    }
    if ((weightRemainingToGoal ?? 0) <= 0.2) {
      return t("my_day.weight_progress_close", {
        defaultValue: "You are very close to your goal.",
      });
    }
    if (weightRemainingToGoal === null) return "";
    return t("my_day.weight_progress_remaining", {
      count: weightRemainingToGoal.toFixed(1),
      unit,
    } as any);
  }, [displayedGoalWeight, goalType, latest, t, unit, weightRemainingToGoal]);

  const displayedDay = selectedDay || getWeightDayKey(new Date());
  const [selectedYear, selectedMonth] = displayedDay.split("-").map(Number);
  const monthLabel = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(calendarMonth);
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language || undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    [i18n.language]
  );
  const monthStartWeekday = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1).getDay();
  const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  const calendarCells = [
    ...Array.from({ length: monthStartWeekday }).map(() => null),
    ...Array.from({ length: daysInMonth }).map((_, index) => index + 1),
  ];
  const entryFeedback = useMemo(() => {
      const rows = [...allLogs].reverse();
    return rows.map((log) => {
      const index = allLogs.findIndex((item) => item.id === log.id);
      const previous = index > 0 ? allLogs[index - 1] : null;
      const previousDistance =
        previous && Number.isFinite(goalWeightNumber) ? Math.abs(previous.value - goalWeightNumber) : null;
      const currentDistance =
        Number.isFinite(goalWeightNumber) ? Math.abs(log.value - goalWeightNumber) : null;
      const improvement =
        previousDistance !== null && currentDistance !== null ? previousDistance - currentDistance : null;

      if (!previous) {
        return {
          id: log.id,
          icon: "sentiment-very-satisfied",
          tone: "positive" as const,
          message: t("my_day.weight_feedback_start", {
            defaultValue: "Great start, let's build your progress from here.",
          }),
        };
      }

      if (currentDistance !== null && currentDistance <= 0.3) {
        return {
          id: log.id,
          icon: "emoji-events",
          tone: "positive" as const,
          message: t("my_day.weight_feedback_goal", {
            defaultValue: "Amazing work, you're right on top of your goal.",
          }),
        };
      }

      if (improvement !== null && improvement >= 0.5) {
        return {
          id: log.id,
          icon: "sentiment-very-satisfied",
          tone: "positive" as const,
          message: t("my_day.weight_feedback_positive", {
            defaultValue: "Great progress, keep going like this.",
          }),
        };
      }

      if (improvement !== null && improvement <= -0.5) {
        return {
          id: log.id,
          icon: "warning-amber",
          tone: "warning" as const,
          message: t("my_day.weight_feedback_warning", {
            defaultValue: "Careful, this entry moved a bit away from your goal.",
          }),
        };
      }

      return {
        id: log.id,
        icon: improvement !== null && improvement < 0 ? "error-outline" : goalType === "gain" ? "trending-up" : goalType === "lose" ? "trending-down" : "track-changes",
        tone: improvement !== null && improvement < 0 ? ("negative" as const) : ("warning" as const),
        message: t("my_day.weight_feedback_steady", {
          defaultValue: "Steady progress. Keep tracking and we'll spot the trend.",
        }),
      };
    });
  }, [allLogs, goalType, goalWeightNumber, t]);
  const selectedFeedback = selectedEntry ? entryFeedback.find((item) => item.id === selectedEntry.id) ?? null : null;
  const selectedFeedbackColor =
    selectedFeedback?.tone === "positive" ? "#16A34A" : selectedFeedback?.tone === "warning" ? "#D97706" : "#DC2626";
  const selectedFeedbackIcon =
    selectedFeedback?.tone === "positive" ? "sentiment-very-satisfied" : selectedFeedback?.tone === "warning" ? "warning-amber" : "error-outline";
  const selectedFeedbackShortMessage = useMemo(() => {
    if (!selectedFeedback) return "";
    if (!previousEntry) {
      return t("my_day.weight_feedback_short_start", {
        defaultValue: "Progress starts here",
      });
    }
    if (selectedFeedback.tone === "positive") {
      return t("my_day.weight_feedback_short_positive", {
        defaultValue: "Great progress",
      });
    }
    if (selectedFeedback.tone === "warning") {
      return t("my_day.weight_feedback_short_warning", {
        defaultValue: "Slight setback",
      });
    }
    return t("my_day.weight_feedback_short_negative", {
      defaultValue: "Needs attention",
    });
  }, [previousEntry, selectedFeedback, t]);
  const hasMoreHistory = entryFeedback.length > historyVisibleCount;
  const trendPath = useMemo(() => {
    if (chartPoints.length === 0) return "";
    if (chartPoints.length === 1) {
      const point = chartPoints[0];
      return `M ${point.x} ${point.y}`;
    }
    let path = `M ${chartPoints[0].x} ${chartPoints[0].y}`;
    for (let i = 0; i < chartPoints.length - 1; i += 1) {
      const current = chartPoints[i];
      const next = chartPoints[i + 1];
      const controlX = (current.x + next.x) / 2;
      path += ` C ${controlX} ${current.y}, ${controlX} ${next.y}, ${next.x} ${next.y}`;
    }
    return path;
  }, [chartPoints]);
  const areaPath = useMemo(() => {
    if (!trendPath || chartPoints.length === 0) return "";
    const lastPoint = chartPoints[chartPoints.length - 1];
    const firstPoint = chartPoints[0];
    const baselineY = chartXAxisY;
    return `${trendPath} L ${lastPoint.x} ${baselineY} L ${firstPoint.x} ${baselineY} Z`;
  }, [chartPoints, chartXAxisY, trendPath]);
  const chartFillColor = useMemo(() => hexToRgba(cta, 0.14), [cta]);
  const goalLineColor = useMemo(() => hexToRgba(cta, 0.6), [cta]);
  const trendSkPath = useMemo(() => (trendPath ? Skia.Path.MakeFromSVGString(trendPath) : null), [trendPath]);
  const areaSkPath = useMemo(() => (areaPath ? Skia.Path.MakeFromSVGString(areaPath) : null), [areaPath]);

  const sanitizeWeightInput = (value: string) => {
    const normalized = value.replace(",", ".");
    const cleaned = normalized.replace(/[^0-9.]/g, "");
    const [whole = "", ...decimals] = cleaned.split(".");
    const trimmedDecimals = decimals.join("").slice(0, 2);
    return cleaned.includes(".") ? `${whole}.${trimmedDecimals}` : whole;
  };

  return (
    <View style={[styles.screen, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t("my_day.weight_details_title", { defaultValue: "Weight details" }),
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
          <View style={styles.weightProgressHeader}>
            <View style={styles.weightProgressPrimary}>
              <Text style={[styles.summaryLabel, { color: subText }]}>
                {t("profile.health_current_weight", { defaultValue: "Current weight" })}
              </Text>
              <Text style={[styles.weightHeroValue, { color: text }]}>
                {latest ? `${latest.value} ${unit}` : "—"}
              </Text>
            </View>
            <View style={styles.weightProgressGoal}>
              <Text style={[styles.summaryLabel, { color: subText }]}>
                {t("profile.health_target_weight", { defaultValue: "Goal weight" })}
              </Text>
              <Text style={[styles.weightGoalValue, { color: text }]}>
                {displayedGoalWeight ? `${displayedGoalWeight} ${unit}` : "—"}
              </Text>
            </View>
          </View>
          <View style={[styles.weightProgressTrack, { backgroundColor: `${primary}1F` }]}>
            <View
              style={[
                styles.weightProgressFill,
                {
                  width: `${Math.max(weightProgressRatio * 100, latest ? 12 : 0)}%`,
                  backgroundColor: cta,
                },
              ]}
            />
          </View>
          <View style={styles.weightProgressMetaRow}>
            {weightStartValue > 0 ? (
              <Text style={[styles.weightProgressMeta, { color: subText }]}>
                {t("my_day.weight_progress_start", {
                  defaultValue: "Started at {{value}} {{unit}}",
                  value: weightStartValue.toFixed(1),
                  unit,
                })}
              </Text>
            ) : null}
            {displayedGoalWeight ? (
              <Text style={[styles.weightProgressMeta, { color: cta }]}>{String(progressText)}</Text>
            ) : (
              <TouchableOpacity activeOpacity={0.85} onPress={() => router.replace("/my-day")}>
                <Text style={[styles.weightProgressMeta, { color: cta }]}>{String(progressText)}</Text>
              </TouchableOpacity>
            )}
          </View>
          {weightPlanUpdatedAt ? (
            <Text style={[styles.weightProgressUpdatedAt, { color: subText }]}>
              {t("my_day.weight_progress_updated_at", {
                defaultValue: "Last updated on {{date}}",
                date: new Intl.DateTimeFormat(i18n.language || undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                }).format(weightPlanUpdatedAt),
              })}
            </Text>
          ) : null}
        </AppCard>

        <AppCard>
          <View style={styles.chartHeader}>
            <View style={styles.chartTitleWrap}>
              <Text style={[styles.sectionTitle, { color: text, marginBottom: 0 }]}>
                {t("my_day.weight_chart_title", { defaultValue: "Evolution" })}
              </Text>
              <Text style={[styles.chartHint, { color: subText }]}>
                {t("my_day.weight_chart_hint", {
                  defaultValue: "Click on the weight dots to see more details.",
                })}
              </Text>
            </View>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rangeChipsRow}
          >
            {rangeOptions.map((option) => {
              const selected = option.key === rangeKey;
              return (
                <TouchableOpacity
                  key={option.key}
                  activeOpacity={0.88}
                  style={[
                    styles.rangeChip,
                    {
                      backgroundColor: selected ? cta : bg,
                      borderColor: selected ? cta : border,
                    },
                  ]}
                  onPress={() => setRangeKey(option.key)}
                >
                  <Text style={[styles.rangeChipText, { color: selected ? "#fff" : text }]}>
                    {option.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          {logs.length === 0 ? (
            <Text style={[styles.emptyText, { color: subText }]}>
              {t("my_day.weight_empty", {
                defaultValue: "Your weight evolution will appear once you start logging entries.",
              })}
            </Text>
          ) : (
            <>
              <View style={styles.chartFrame}>
                <View style={[styles.chartYAxis, { height: chartTopPadding + chartHeight }]}>
                  {axisEntries.map((entry, index) => {
                    const top = chartTopPadding + chartHeight - ((entry.value - chartMin) / chartRange) * chartHeight - 9;
                    return (
                      <View key={`${entry.value}-${index}`} style={[styles.chartAxisEntry, { top }]}>
                        {entry.goal ? (
                          <MaterialIcons name="flag-circle" size={13} color={cta} style={{ marginRight: 4 }} />
                        ) : null}
                        <Text
                          style={[
                            styles.chartAxisLabel,
                            { color: entry.goal ? cta : subText, fontWeight: entry.goal ? "800" : "600" },
                          ]}
                        >
                          {entry.value.toFixed(1)}
                        </Text>
                      </View>
                    );
                  })}
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chartScrollContent}>
                  <View style={[styles.chartCanvas, { width: chartWidth, height: chartHeight + chartTopPadding + 32 }]}>
                    {[0, 0.5, 1].map((ratio, index) => (
                      <View
                        key={`grid-${ratio}`}
                        style={[
                          styles.chartGridLine,
                          {
                            top: chartTopPadding + chartHeight - chartHeight * ratio,
                            borderColor: `${border}88`,
                          },
                        ]}
                      />
                    ))}
                    {goalLineY !== null ? (
                      <View
                        style={[
                          styles.goalGuideLine,
                          {
                            top: goalLineY,
                            borderColor: goalLineColor,
                          },
                        ]}
                      />
                    ) : null}
                    <Canvas
                      style={[
                        styles.chartCanvasOverlay,
                        { width: chartWidth, height: chartHeight + chartTopPadding + 32 },
                      ]}
                    >
                      {areaSkPath ? <SkiaPath path={areaSkPath} color={chartFillColor} /> : null}
                      {trendSkPath ? (
                        <SkiaPath
                          path={trendSkPath}
                          color={cta}
                          style="stroke"
                          strokeWidth={3.5}
                          strokeCap="round"
                          strokeJoin="round"
                        />
                      ) : null}
                    </Canvas>
                    {chartPoints.map((point) => {
                      const selected = point.id === selectedEntry?.id;
                      const pointLabelWidth = chartPointLabelWidth(point.value);
                      return (
                        <TouchableOpacity
                          key={point.id}
                          activeOpacity={0.88}
                          style={[
                            styles.chartPointWrap,
                            {
                              width: pointLabelWidth,
                              left: Math.min(
                                chartWidth - pointLabelWidth,
                                Math.max(0, point.x - pointLabelWidth / 2)
                              ),
                              top: point.y - 26,
                            },
                          ]}
                          onPress={() => setSelectedEntryId(point.id)}
                        >
                          <Text style={[styles.chartPointValue, { color: selected ? cta : text }]}>
                            {point.value}
                          </Text>
                          <View
                            style={[
                              styles.chartPointDot,
                              {
                                backgroundColor: selected ? cta : bg,
                                borderColor: selected ? cta : primary,
                              },
                            ]}
                          />
                        </TouchableOpacity>
                      );
                    })}
                    <View style={[styles.chartXAxis, { borderColor: border }]} />
                    {chartPoints.map((point, index) => {
                      const showLabel =
                        index === 0 ||
                        index === chartPoints.length - 1 ||
                        index === Math.floor((chartPoints.length - 1) / 2);
                      if (!showLabel) return null;
                      return (
                        <Text
                          key={`label-${point.id}`}
                          style={[
                            styles.chartDateLabel,
                            { color: subText, left: Math.max(0, point.x - 22) },
                          ]}
                        >
                          {new Intl.DateTimeFormat(i18n.language || undefined, {
                            day: "numeric",
                            month: "short",
                          }).format(new Date(point.createdAt))}
                        </Text>
                      );
                    })}
                  </View>
                </ScrollView>
              </View>
              {selectedEntry ? (
                <View style={[styles.chartSelectionSummary, { backgroundColor: card, borderColor: border }]}>
                  <View style={styles.chartSelectionLeft}>
                    <Text style={[styles.timelineDetailsWeight, { color: text }]}>
                      {selectedEntry.value} {unit}
                    </Text>
                    <Text style={[styles.timelineDetailsDate, { color: subText }]}>
                      {dateFormatter.format(new Date(selectedEntry.createdAt))}
                    </Text>
                  </View>
                  <View style={styles.chartSelectionRight}>
                    <View style={styles.chartSelectionStatus}>
                      <MaterialIcons name={selectedFeedbackIcon as any} size={17} color={selectedFeedbackColor} />
                      <Text style={[styles.chartSelectionStatusText, { color: selectedFeedbackColor }]}>
                        {selectedFeedbackShortMessage}
                      </Text>
                    </View>
                    <Text style={[styles.historyChangeValue, { color: text }]}>
                      {changeFromPreviousKg !== null
                        ? `${changeFromPreviousKg > 0 ? "+" : ""}${changeFromPreviousKg.toFixed(2)} ${unit}`
                        : "—"}
                    </Text>
                    <Text style={[styles.timelineDetailLabel, { color: subText, marginBottom: 0 }]}>
                      {t("my_day.weight_change_previous", { defaultValue: "Vs previous" })}
                    </Text>
                  </View>
                </View>
              ) : null}
            </>
          )}
        </AppCard>

        <AppCard>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: text }]}>
              {t("my_day.weight_history", { defaultValue: "History" })}
            </Text>
          </View>
          {logs.length === 0 ? (
            <Text style={[styles.metaText, { color: subText }]}>
              {t("my_day.weight_history_empty", {
                defaultValue: "Your saved weight entries will appear here.",
              })}
            </Text>
          ) : (
            <View>
              {entryFeedback.slice(0, historyVisibleCount).map((item, index) => {
                const log = allLogs.find((entry) => entry.id === item.id);
                if (!log) return null;
                const iconColor = item.tone === "positive" ? "#16A34A" : item.tone === "warning" ? "#D97706" : "#DC2626";
                const previous = (() => {
                  const logIndex = allLogs.findIndex((entry) => entry.id === log.id);
                  return logIndex > 0 ? allLogs[logIndex - 1] : null;
                })();
                const changeValue =
                  previous ? `${log.value - previous.value > 0 ? "+" : ""}${(log.value - previous.value).toFixed(2)} ${unit}` : "—";
                return (
                  <View
                    key={item.id}
                    style={[
                      styles.historyRow,
                      { borderBottomColor: index < Math.min(entryFeedback.length, historyVisibleCount) - 1 || hasMoreHistory ? border : "transparent" },
                    ]}
                  >
                    <View style={styles.feedbackLineWrap}>
                      <View style={[styles.feedbackDot, { backgroundColor: iconColor }]} />
                      <View style={[styles.feedbackLine, { backgroundColor: `${iconColor}44` }]} />
                    </View>
                    <View style={styles.historyCopy}>
                      <View style={styles.feedbackTopRow}>
                        <View>
                          <Text style={[styles.feedbackDate, { color: text }]}>
                            {dateFormatter.format(new Date(log.createdAt))}
                          </Text>
                          <Text style={[styles.feedbackWeight, { color: text }]}>
                            {`${log.value} ${unit}`}
                          </Text>
                        </View>
                        <View style={styles.historyChangeBadge}>
                          <Text style={[styles.timelineDetailLabel, { color: subText }]}>
                            {t("my_day.weight_change_previous", { defaultValue: "Vs previous" })}
                          </Text>
                          <Text style={[styles.historyChangeValue, { color: text }]}>
                            {changeValue}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.feedbackMessageRow}>
                        <MaterialIcons name={item.icon as any} size={15} color={iconColor} />
                        <Text style={[styles.feedbackMessage, { color: subText }]}>
                          {item.message}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.historyActions}>
                      <TouchableOpacity
                        activeOpacity={0.85}
                        style={[styles.historyActionButton, { borderColor: border, backgroundColor: bg }]}
                        onPress={() => openEditModal(log)}
                      >
                        <MaterialIcons name="edit" size={16} color={text} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        activeOpacity={0.85}
                        style={[styles.historyActionButton, { borderColor: border, backgroundColor: bg }]}
                        onPress={() =>
                          Alert.alert(
                            t("common.delete", { defaultValue: "Delete" }),
                            t("my_day.weight_delete_confirm", {
                              defaultValue: "Delete this weight entry?",
                            }),
                            [
                              { text: t("common.cancel", { defaultValue: "Cancel" }), style: "cancel" },
                              {
                                text: t("common.delete", { defaultValue: "Delete" }),
                                style: "destructive",
                                onPress: async () => {
                                  await deleteWeightLog(log.id);
                                  if (typeof (syncEngine as any)?.markMyDayWeightDeleted === "function") {
                                    await (syncEngine as any).markMyDayWeightDeleted(log.id);
                                  }
                                  const nextLogs = await loadWeightLogs();
                                  setLogs(nextLogs);
                                  if (editingLog?.id === log.id) {
                                    setEditingLog(null);
                                    setWeightInput("");
                                    setSelectedDay("");
                                  }
                                },
                              },
                            ]
                          )
                        }
                      >
                        <MaterialIcons name="delete-outline" size={18} color={cta} />
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
              {hasMoreHistory ? (
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={styles.historyMoreButton}
                  onPress={() => setHistoryVisibleCount((prev) => prev + 5)}
                >
                  <Text style={[styles.historyMoreText, { color: cta }]}>
                    {t("common.view_more", { defaultValue: "View more" })}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}
        </AppCard>
      </ScrollView>

      <View pointerEvents="box-none" style={styles.floatingActionsWrap}>
        <TouchableOpacity activeOpacity={0.88} style={[styles.floatingLogWeightButton, { backgroundColor: cta }]} onPress={openCreateModal}>
          <MaterialIcons name="monitor-weight" size={18} color="#fff" />
          <Text style={styles.floatingLogWeightText}>
            {t("my_day.log_weight", { defaultValue: "Log weight" })}
          </Text>
        </TouchableOpacity>
      </View>

      <Modal visible={weightModalVisible} transparent animationType="slide" onRequestClose={closeWeightModal}>
        <Pressable style={[styles.calendarOverlay, { backgroundColor: modalBackdrop }]} onPress={closeWeightModal}>
          <KeyboardAvoidingView
            style={styles.weightModalKeyboard}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 20}
          >
            <View style={[styles.weightModalCard, { backgroundColor: card, borderColor: border }]} onStartShouldSetResponder={() => true}>
              <View style={styles.weightModalHeader}>
                <Text style={[styles.sectionTitle, { color: text, marginBottom: 0 }]}>
                  {editingLog
                    ? t("my_day.edit_weight", { defaultValue: "Edit weight" })
                    : t("my_day.log_weight", { defaultValue: "Log weight" })}
                </Text>
                <TouchableOpacity activeOpacity={0.85} onPress={closeWeightModal}>
                  <MaterialIcons name="close" size={22} color={subText} />
                </TouchableOpacity>
              </View>
              <Text style={[styles.metaText, { color: subText }]}>
                {t("my_day.weight_modal_hint", {
                  defaultValue: "Add your weight and pick the date you want to track.",
                })}
              </Text>
              <View style={styles.weightModalFields}>
                <TextInput
                  value={weightInput}
                  onChangeText={(value) => setWeightInput(sanitizeWeightInput(value))}
                  keyboardType="decimal-pad"
                  placeholder={measurement === "US" ? "165" : "72"}
                  placeholderTextColor={subText}
                  style={[styles.input, { color: text, borderColor: border, backgroundColor: bg }]}
                />
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[styles.dateInput, { borderColor: border, backgroundColor: bg }]}
                  onPress={() => {
                    setCalendarMonth(
                      selectedDay
                        ? new Date(selectedYear, selectedMonth - 1, 1)
                        : new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                    );
                    setCalendarVisible(true);
                  }}
                >
                  <Text style={{ color: selectedDay ? text : subText, fontSize: 14 }}>
                    {selectedDay || t("my_day.weight_pick_date", { defaultValue: "Pick date" })}
                  </Text>
                </TouchableOpacity>
              </View>
              <View style={styles.weightModalActions}>
                <TouchableOpacity activeOpacity={0.85} style={[styles.modalSecondaryButton, { borderColor: border, backgroundColor: bg }]} onPress={closeWeightModal}>
                  <Text style={[styles.modalSecondaryButtonText, { color: text }]}>
                    {t("common.cancel", { defaultValue: "Cancel" })}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity activeOpacity={0.85} style={[styles.button, { backgroundColor: cta }]} onPress={handleSave}>
                  <Text style={styles.buttonText}>{t("common.save")}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      <Modal visible={calendarVisible} transparent animationType="fade" onRequestClose={() => setCalendarVisible(false)}>
        <Pressable style={[styles.calendarOverlay, { backgroundColor: modalBackdrop }]} onPress={() => setCalendarVisible(false)}>
          <View style={[styles.calendarCard, { backgroundColor: bg, borderColor: border }]} onStartShouldSetResponder={() => true}>
            <View style={styles.calendarHeader}>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}
              >
                <MaterialIcons name="chevron-left" size={22} color={primary} />
              </TouchableOpacity>
              <Text style={[styles.calendarTitle, { color: text }]}>{monthLabel}</Text>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}
              >
                <MaterialIcons name="chevron-right" size={22} color={primary} />
              </TouchableOpacity>
            </View>
            <View style={styles.calendarWeekRow}>
              {["S", "M", "T", "W", "T", "F", "S"].map((label, index) => (
                <Text key={`${label}-${index}`} style={[styles.calendarWeekday, { color: subText }]}>
                  {label}
                </Text>
              ))}
            </View>
            <View style={styles.calendarGrid}>
              {calendarCells.map((day, index) => {
                const value =
                  day == null
                    ? null
                    : `${calendarMonth.getFullYear()}-${`${calendarMonth.getMonth() + 1}`.padStart(2, "0")}-${`${day}`.padStart(2, "0")}`;
                const todayKey = getWeightDayKey(new Date());
                const isSelected = value === selectedDay || (!selectedDay && value === todayKey);
                return (
                  <TouchableOpacity
                    key={`${value}-${index}`}
                    activeOpacity={0.85}
                    disabled={day == null}
                    style={[
                      styles.calendarCell,
                      isSelected && { backgroundColor: cta },
                      day == null && { opacity: 0 },
                    ]}
                    onPress={() => {
                      if (!value) return;
                      setSelectedDay(value);
                      setCalendarVisible(false);
                    }}
                  >
                    <Text style={{ color: isSelected ? "#fff" : text, fontWeight: "600" }}>{day ?? ""}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </Pressable>
      </Modal>
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
  weightProgressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-end",
    marginBottom: 10,
  },
  weightProgressPrimary: {
    flex: 1,
  },
  weightProgressGoal: {
    alignItems: "flex-end",
  },
  summaryLabel: {
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  weightHeroValue: {
    fontSize: 28,
    fontWeight: "800",
    lineHeight: 30,
  },
  weightGoalValue: {
    fontSize: 18,
    fontWeight: "800",
  },
  weightProgressTrack: {
    height: 12,
    borderRadius: 999,
    overflow: "hidden",
    marginBottom: 10,
  },
  weightProgressFill: {
    height: "100%",
    borderRadius: 999,
  },
  weightProgressMetaRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  weightProgressMeta: {
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 16,
    flexShrink: 1,
  },
  weightProgressUpdatedAt: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
  },
  chartHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  chartTitleWrap: {
    flex: 1,
    paddingRight: 8,
  },
  chartHint: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 4,
  },
  rangeChipsRow: {
    paddingBottom: 14,
    gap: 8,
  },
  rangeChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  rangeChipText: {
    fontSize: 12,
    fontWeight: "700",
  },
  chartFrame: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 2,
  },
  chartYAxis: {
    width: 40,
    position: "relative",
    height: 200,
  },
  chartAxisEntry: {
    position: "absolute",
    left: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  chartAxisLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  chartScrollContent: {
    paddingRight: 16,
  },
  chartCanvas: {
    position: "relative",
    marginBottom: 8,
  },
  chartCanvasOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
  },
  chartGridLine: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  goalGuideLine: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopWidth: 1.5,
    borderStyle: "dashed",
  },
  chartPointWrap: {
    position: "absolute",
    width: 56,
    alignItems: "center",
  },
  chartPointValue: {
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 5,
  },
  chartPointDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 2,
  },
  chartXAxis: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 22,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  chartDateLabel: {
    position: "absolute",
    bottom: 0,
    fontSize: 11,
    fontWeight: "600",
  },
  chartSelectionSummary: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  chartSelectionLeft: {
    flex: 1,
    minWidth: 0,
  },
  chartSelectionRight: {
    alignItems: "flex-end",
    justifyContent: "center",
  },
  chartSelectionStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 6,
  },
  chartSelectionStatusText: {
    fontSize: 12,
    fontWeight: "700",
  },
  timelineDetailsWeight: {
    fontSize: 20,
    fontWeight: "800",
    marginBottom: 4,
  },
  timelineDetailsDate: {
    fontSize: 13,
    lineHeight: 18,
  },
  timelineVsPreviousBadge: {
    alignItems: "flex-end",
  },
  timelineDetailLabel: {
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  timelineDetailValue: {
    fontSize: 17,
    fontWeight: "800",
    marginBottom: 4,
  },
  timelineDetailMeta: {
    fontSize: 12,
    lineHeight: 17,
  },
  feedbackList: {
    marginTop: 8,
  },
  feedbackRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 8,
  },
  feedbackLineWrap: {
    width: 18,
    alignItems: "center",
    marginTop: 4,
  },
  feedbackDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  feedbackLine: {
    width: 2,
    flex: 1,
    marginTop: 4,
    minHeight: 34,
    borderRadius: 999,
  },
  feedbackCopy: {
    flex: 1,
    paddingLeft: 8,
    paddingRight: 10,
  },
  feedbackTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 4,
  },
  feedbackDate: {
    fontSize: 15,
    fontWeight: "700",
  },
  feedbackWeight: {
    fontSize: 15,
    fontWeight: "700",
    marginTop: 2,
  },
  historyChangeBadge: {
    alignItems: "flex-end",
    maxWidth: 120,
  },
  historyChangeValue: {
    fontSize: 14,
    fontWeight: "700",
  },
  feedbackMessageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  feedbackMessage: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
  },
  metaText: {
    fontSize: 13,
    lineHeight: 18,
  },
  weightModalFields: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 14,
    marginBottom: 14,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
  },
  dateInput: {
    width: 118,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 14,
    justifyContent: "center",
  },
  button: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  buttonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  historyCopy: {
    flex: 1,
    paddingRight: 12,
  },
  historyValue: {
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 4,
  },
  historyDate: {
    fontSize: 13,
    lineHeight: 18,
  },
  historyActions: {
    flexDirection: "row",
    gap: 8,
  },
  historyActionButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  historyMoreButton: {
    paddingTop: 12,
    alignItems: "center",
  },
  historyMoreText: {
    fontSize: 14,
    fontWeight: "700",
  },
  calendarOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  weightModalKeyboard: {
    width: "100%",
    paddingHorizontal: 20,
  },
  weightModalCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
  },
  weightModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  weightModalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },
  modalSecondaryButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  modalSecondaryButtonText: {
    fontSize: 14,
    fontWeight: "700",
  },
  floatingActionsWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 18,
    paddingHorizontal: 16,
    alignItems: "flex-end",
    pointerEvents: "box-none",
  },
  floatingLogWeightButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 12,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  floatingLogWeightText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  calendarCard: {
    width: "86%",
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
  },
  calendarHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  calendarTitle: {
    fontSize: 16,
    fontWeight: "800",
  },
  calendarWeekRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  calendarWeekday: {
    width: "14.2%",
    textAlign: "center",
    fontSize: 12,
    fontWeight: "700",
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  calendarCell: {
    width: "14.2%",
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    marginBottom: 6,
  },
});
