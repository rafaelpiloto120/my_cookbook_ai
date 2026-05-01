import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";

import { useThemeColors } from "../context/ThemeContext";
import {
  MeasurementSystem,
  MyDayGender,
  MyDayGoalType,
  MyDayPace,
  MyDayPlan,
  MyDayProfile,
} from "../lib/myDay";

const GRAMS_PER_OUNCE = 28.349523125;

type Props = {
  visible: boolean;
  draft: MyDayProfile | null;
  measurement: MeasurementSystem;
  planMode: "auto" | "manual";
  initialStep?: number;
  onClose: () => void;
  onSave: () => void;
  onUpdateField: <K extends keyof MyDayProfile>(key: K, value: MyDayProfile[K]) => void;
  onUpdatePlan: (key: keyof MyDayPlan, value: string) => void;
  onPlanModeChange: (mode: "auto" | "manual") => void;
};

export default function HealthGoalsEditorModal({
  visible,
  draft,
  measurement,
  planMode,
  initialStep = 0,
  onClose,
  onSave,
  onUpdateField,
  onUpdatePlan,
  onPlanModeChange,
}: Props) {
  const { t } = useTranslation();
  const { bg, text, subText, border, card, cta, modalBackdrop } = useThemeColors();
  const [currentStep, setCurrentStep] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const stepsRef = useRef<ScrollView | null>(null);
  const { width } = useWindowDimensions();
  const pageWidth = contentWidth || Math.max(width - 140, 240);

  const sanitizePositiveDecimalInput = (value: string) => {
    const normalized = value.replace(",", ".").replace(/[^0-9.]/g, "");
    const [whole = "", ...rest] = normalized.split(".");
    const decimals = rest.join("").slice(0, 2);
    const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
    if (normalized.includes(".")) {
      return `${trimmedWhole || "0"}.${decimals}`;
    }
    return trimmedWhole;
  };

  const parsePositiveNumber = (value: string) => {
    const parsed = Number(value.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  };

  const formatWeightValue = (value: number) =>
    Number(value.toFixed(2)).toString();

  const formatPlanMetricValue = (value: number, key: keyof MyDayPlan) => {
    if (!Number.isFinite(value)) return "";
    if (key === "calories") return String(Math.round(value));
    if (measurement === "US") {
      const ounces = value / GRAMS_PER_OUNCE;
      return Number(ounces.toFixed(2)).toString();
    }
    return String(Math.round(value));
  };

  const parsePlanMetricInput = (value: string, key: keyof MyDayPlan) => {
    const parsed = Number(value.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) return "";
    if (key === "calories") return String(Math.round(parsed));
    if (measurement === "US") {
      return String(Math.round(parsed * GRAMS_PER_OUNCE));
    }
    return String(Math.round(parsed));
  };

  const planMetricUnit = (key: keyof MyDayPlan) => {
    if (key === "calories") return "kcal";
    return measurement === "US" ? "oz" : "g";
  };

  const planMetricPlaceholder = (key: keyof MyDayPlan, fallback: string) => {
    const numericFallback = Number(fallback);
    if (!Number.isFinite(numericFallback) || numericFallback <= 0) return fallback;
    return formatPlanMetricValue(numericFallback, key);
  };

  const currentWeightValue = parsePositiveNumber(draft?.currentWeight ?? "");

  const buildDefaultTargetWeight = (goal: MyDayGoalType) => {
    if (!currentWeightValue) return "";
    if (goal === "lose") return formatWeightValue(Math.max(currentWeightValue - 1, 0.1));
    if (goal === "gain") return formatWeightValue(currentWeightValue + 1);
    return formatWeightValue(currentWeightValue);
  };

  const handleGoalSelection = (goal: MyDayGoalType) => {
    if (!draft) return;
    onUpdateField("goalType", goal);
    if (goal === "maintain") {
      if (draft.currentWeight) {
        onUpdateField("targetWeight", sanitizePositiveDecimalInput(draft.currentWeight));
      }
      return;
    }

    const parsedTarget = parsePositiveNumber(draft.targetWeight);
    const isValidExistingTarget =
      currentWeightValue &&
      parsedTarget &&
      ((goal === "lose" && parsedTarget < currentWeightValue) ||
        (goal === "gain" && parsedTarget > currentWeightValue));

    if (!isValidExistingTarget) {
      onUpdateField("targetWeight", buildDefaultTargetWeight(goal));
    }
  };

  const handleCurrentWeightChange = (value: string) => {
    if (!draft) return;
    const sanitized = sanitizePositiveDecimalInput(value);
    onUpdateField("currentWeight", sanitized);
    if (draft.goalType === "maintain") {
      onUpdateField("targetWeight", sanitized);
    }
  };

  const handleTargetWeightChange = (value: string, goal: "lose" | "gain") => {
    if (!draft) return;
    const sanitized = sanitizePositiveDecimalInput(value);
    if (!sanitized) {
      onUpdateField("targetWeight", "");
      return;
    }
    onUpdateField("targetWeight", sanitized);
  };

  const validateGoalStep = () => {
    if (!draft) return false;
    if (draft.goalType === "maintain") return true;

    const currentWeight = parsePositiveNumber(draft.currentWeight);
    const targetWeight = parsePositiveNumber(draft.targetWeight);

    if (!currentWeight || !targetWeight) {
      Alert.alert(
        t("profile.health_your_goal", { defaultValue: "Your Goal" }),
        t("profile.health_target_weight_required", {
          defaultValue: "Please enter a valid goal weight to continue.",
        })
      );
      return false;
    }

    if (draft.goalType === "lose" && targetWeight >= currentWeight) {
      Alert.alert(
        t("profile.health_your_goal", { defaultValue: "Your Goal" }),
        t("profile.health_target_weight_lose_error", {
          defaultValue: "For losing weight, your goal weight should be lower than your current weight.",
        })
      );
      return false;
    }

    if (draft.goalType === "gain" && targetWeight <= currentWeight) {
      Alert.alert(
        t("profile.health_your_goal", { defaultValue: "Your Goal" }),
        t("profile.health_target_weight_gain_error", {
          defaultValue: "For gaining weight, your goal weight should be higher than your current weight.",
        })
      );
      return false;
    }

    return true;
  };

  const validateAboutYouStep = () => {
    if (!draft) return false;

    const age = parsePositiveNumber(draft.age);
    const height = parsePositiveNumber(draft.height);
    const currentWeight = parsePositiveNumber(draft.currentWeight);

    if (!age || !height || !currentWeight) {
      Alert.alert(
        t("profile.health_about_you", { defaultValue: "About You" }),
        t("profile.health_about_you_required", {
          defaultValue: "Please complete age, height, and current weight to continue.",
        })
      );
      return false;
    }

    if (measurement === "US" && height > 96) {
      Alert.alert(
        t("profile.health_about_you", { defaultValue: "About You" }),
        t("profile.health_height_us_validation", {
          defaultValue: "Height looks too high for inches. If you meant centimeters, switch to Metric or enter your height in inches.",
        })
      );
      return false;
    }

    return true;
  };

  useEffect(() => {
    if (visible) {
      const nextStep = Math.max(0, Math.min(2, initialStep));
      setCurrentStep(nextStep);
      requestAnimationFrame(() => {
        stepsRef.current?.scrollTo({ x: pageWidth * nextStep, animated: false });
      });
    }
  }, [initialStep, pageWidth, visible]);

  const steps = [
    {
      label: t("profile.health_about_you", { defaultValue: "About You" }),
      icon: "person-outline" as const,
    },
    {
      label: t("profile.health_your_goal", { defaultValue: "Your Goal" }),
      icon: "flag" as const,
    },
    {
      label: t("profile.health_daily_plan", { defaultValue: "Daily Plan" }),
      icon: "insights" as const,
    },
  ];

  const goToStep = (step: number) => {
    setCurrentStep(step);
    stepsRef.current?.scrollTo({ x: pageWidth * step, animated: true });
  };

  const handlePagerLayout = (event: LayoutChangeEvent) => {
    const nextWidth = Math.floor(event.nativeEvent.layout.width);
    if (nextWidth > 0 && nextWidth !== contentWidth) {
      setContentWidth(nextWidth);
      requestAnimationFrame(() => {
        stepsRef.current?.scrollTo({ x: nextWidth * currentStep, animated: false });
      });
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[styles.overlay, { backgroundColor: modalBackdrop }]} onPress={onClose}>
        <KeyboardAvoidingView
          style={styles.keyboardWrap}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 20}
        >
          <View
            style={[styles.card, { backgroundColor: card, borderColor: border }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.headerRow}>
              <Text style={[styles.title, { color: text }]}>
                {t("profile.health_goals_title", { defaultValue: "Health & Goals" })}
              </Text>
              <TouchableOpacity activeOpacity={0.8} onPress={onClose}>
                <MaterialIcons name="close" size={22} color={subText} />
              </TouchableOpacity>
            </View>
            <View style={styles.stepsRow}>
              {steps.map((step, index) => {
                const selected = index === currentStep;
                return (
                  <TouchableOpacity key={step.label} activeOpacity={0.85} style={styles.stepItem} onPress={() => goToStep(index)}>
                    <View
                      style={[
                        styles.stepDot,
                        {
                          backgroundColor: selected ? cta : `${border}`,
                          borderColor: selected ? cta : border,
                        },
                      ]}
                    >
                      <Text style={[styles.stepDotText, { color: selected ? "#fff" : subText }]}>
                        {index + 1}
                      </Text>
                    </View>
                    <View style={styles.stepLabelWrap}>
                      <MaterialIcons
                        name={step.icon}
                        size={14}
                        color={selected ? text : subText}
                      />
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.stepLabel,
                          { color: selected ? text : subText, fontWeight: selected ? "800" : "600" },
                        ]}
                      >
                        {step.label}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={[styles.headerDivider, { backgroundColor: border }]} />

            {draft ? (
              <>
                <View style={styles.pagerViewport} onLayout={handlePagerLayout}>
                  <ScrollView
                    ref={stepsRef}
                    horizontal
                    pagingEnabled
                    showsHorizontalScrollIndicator={false}
                    scrollEventThrottle={16}
                    onMomentumScrollEnd={(event) => {
                      const nextStep = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
                      setCurrentStep(nextStep);
                    }}
                  >
                  <View style={[styles.stepPage, { width: pageWidth, backgroundColor: card }]}>
                    <ScrollView
                      showsVerticalScrollIndicator={false}
                      keyboardShouldPersistTaps="always"
                      style={{ backgroundColor: card }}
                      contentContainerStyle={styles.scrollContent}
                    >
                      <View style={styles.blockSpacious}>
                        <Text style={[styles.sectionLabel, { color: text }]}>
                          {t("profile.health_about_you", { defaultValue: "About You" })}
                        </Text>
                        <Text style={[styles.stepIntro, { color: subText }]}>
                          {t("profile.health_about_you_intro", {
                            defaultValue: "These details help us personalize your targets.",
                          })}
                        </Text>
                        <View style={styles.aboutGrid}>
                          {[
                            {
                              key: "age" as const,
                              label: t("profile.health_age", { defaultValue: "Age" }),
                              placeholder: "30",
                              keyboardType: "number-pad" as const,
                              unit: "",
                            },
                            {
                              key: "height" as const,
                              label: `${t("profile.health_height", { defaultValue: "Height" })} (${measurement === "US" ? "in" : "cm"})`,
                              placeholder: measurement === "US" ? "68" : "170",
                              keyboardType: "decimal-pad" as const,
                              unit: "",
                            },
                            {
                              key: "currentWeight" as const,
                              label: `${t("profile.health_current_weight", { defaultValue: "Current weight" })} (${measurement === "US" ? "lb" : "kg"})`,
                              placeholder: measurement === "US" ? "165" : "72",
                              keyboardType: "decimal-pad" as const,
                              unit: "",
                            },
                          ].map((field) => (
                            <View key={field.key} style={styles.aboutCard}>
                              <Text style={[styles.stackedFieldLabel, { color: text }]}>{field.label}</Text>
                              <TextInput
                                value={draft[field.key]}
                                onChangeText={(value) =>
                                  field.key === "currentWeight"
                                    ? handleCurrentWeightChange(value)
                                    : field.key === "height"
                                      ? onUpdateField(field.key, sanitizePositiveDecimalInput(value))
                                      : onUpdateField(field.key, value.replace(/[^0-9]/g, ""))
                                }
                                keyboardType={field.keyboardType}
                                style={[styles.stackedFieldInput, { color: text, borderColor: border, backgroundColor: card }]}
                                placeholder={field.placeholder}
                                placeholderTextColor={subText}
                              />
                            </View>
                          ))}
                        </View>
                      </View>

                      <View style={styles.blockSpacious}>
                        <Text style={[styles.fieldLabel, { color: text }]}>
                          {t("profile.health_gender", { defaultValue: "Gender" })}
                        </Text>
                        <View style={styles.chipWrap}>
                          {[
                            { key: "", label: t("profile.health_gender_unspecified", { defaultValue: "Prefer not to say" }) },
                            { key: "female", label: t("profile.health_gender_female", { defaultValue: "Female" }) },
                            { key: "male", label: t("profile.health_gender_male", { defaultValue: "Male" }) },
                          ].map((option) => {
                            const selected = draft.gender === option.key;
                            return (
                              <TouchableOpacity
                                key={option.label}
                                activeOpacity={0.85}
                                style={[styles.chip, { backgroundColor: selected ? cta : "transparent", borderColor: border }]}
                                onPress={() => onUpdateField("gender", option.key as MyDayGender)}
                              >
                                    <Text style={{ color: selected ? "#fff" : text, fontWeight: "600", fontSize: 14 }}>
                                      {option.label}
                                    </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>
                    </ScrollView>
                  </View>

                  <View style={[styles.stepPage, { width: pageWidth, backgroundColor: card }]}>
                    <ScrollView
                      showsVerticalScrollIndicator={false}
                      keyboardShouldPersistTaps="always"
                      style={{ backgroundColor: card }}
                      contentContainerStyle={styles.scrollContent}
                    >
                      <View style={styles.blockSpacious}>
                        <Text style={[styles.sectionLabel, { color: text }]}>
                          {t("profile.health_your_goal", { defaultValue: "Your Goal" })}
                        </Text>
                        <Text style={[styles.stepIntro, { color: subText }]}>
                          {t("profile.health_goal_intro", {
                            defaultValue: "Choose the direction you want My Day to support.",
                          })}
                        </Text>
                        <View style={styles.goalCardWrap}>
                          {[
                            { key: "lose", label: t("profile.health_goal_lose", { defaultValue: "Lose weight" }) },
                            { key: "maintain", label: t("profile.health_goal_maintain", { defaultValue: "Maintain weight" }) },
                            { key: "gain", label: t("profile.health_goal_gain", { defaultValue: "Gain weight" }) },
                          ].map((option) => {
                            const selected = draft.goalType === option.key;
                            const showTargetInput = selected && option.key !== "maintain";
                            return (
                              <TouchableOpacity
                                key={option.key}
                                activeOpacity={0.85}
                                style={[styles.goalCard, { backgroundColor: selected ? cta : "transparent", borderColor: selected ? cta : border }]}
                                onPress={() => handleGoalSelection(option.key as MyDayGoalType)}
                              >
                                <View style={styles.goalCardMain}>
                                  <MaterialIcons
                                    name={
                                      option.key === "lose"
                                        ? "trending-down"
                                        : option.key === "gain"
                                          ? "trending-up"
                                          : "horizontal-rule"
                                    }
                                    size={20}
                                    color={selected ? "#fff" : text}
                                  />
                                  <Text style={{ color: selected ? "#fff" : text, fontWeight: "700", fontSize: 15 }}>
                                    {option.label}
                                  </Text>
                                </View>
                                {showTargetInput ? (
                                  <View style={styles.goalTargetWrap}>
                                    <TextInput
                                      value={draft.targetWeight}
                                      onChangeText={(value) => handleTargetWeightChange(value, option.key as "lose" | "gain")}
                                      keyboardType="decimal-pad"
                                      style={[
                                        styles.goalTargetInput,
                                        {
                                          color: selected ? "#fff" : text,
                                          borderColor: selected ? "rgba(255,255,255,0.45)" : border,
                                          backgroundColor: selected ? "rgba(255,255,255,0.12)" : card,
                                        },
                                      ]}
                                      placeholder={buildDefaultTargetWeight(option.key as "lose" | "gain")}
                                      placeholderTextColor={selected ? "rgba(255,255,255,0.7)" : subText}
                                    />
                                    <Text style={[styles.goalTargetUnit, { color: selected ? "rgba(255,255,255,0.75)" : subText }]}>
                                      {measurement === "US" ? "lb" : "kg"}
                                    </Text>
                                  </View>
                                ) : null}
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>

                      {draft.goalType !== "maintain" ? (
                        <View style={styles.blockSpacious}>
                          <Text style={[styles.fieldLabel, { color: text }]}>
                            {t("profile.health_pace_label", { defaultValue: "Pace" })}
                          </Text>
                          <View style={styles.chipWrap}>
                            {[
                              { key: "relaxed", label: t("profile.health_pace_relaxed", { defaultValue: "Relaxed" }) },
                              { key: "balanced", label: t("profile.health_pace_balanced", { defaultValue: "Balanced" }) },
                              { key: "aggressive", label: t("profile.health_pace_aggressive", { defaultValue: "Aggressive" }) },
                            ].map((option) => {
                              const selected = draft.pace === option.key;
                              return (
                                <TouchableOpacity
                                  key={option.key}
                                  activeOpacity={0.85}
                                  style={[styles.chip, { backgroundColor: selected ? cta : "transparent", borderColor: border }]}
                                  onPress={() => onUpdateField("pace", option.key as MyDayPace)}
                                >
                                      <Text style={{ color: selected ? "#fff" : text, fontWeight: "600", fontSize: 14 }}>
                                        {option.label}
                                      </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        </View>
                      ) : null}
                    </ScrollView>
                  </View>

                  <View style={[styles.stepPage, { width: pageWidth, backgroundColor: card }]}>
                    <ScrollView
                      showsVerticalScrollIndicator={false}
                      keyboardShouldPersistTaps="always"
                      style={{ backgroundColor: card }}
                      contentContainerStyle={styles.scrollContent}
                    >
                      <View style={[styles.planStepWrap, styles.blockSpacious]}>
                        <View style={styles.planHeader}>
                          <View style={styles.planHeaderCopy}>
                            <Text style={[styles.sectionLabel, { color: text }]}>
                              {t("profile.health_daily_plan", { defaultValue: "Daily Plan" })}
                            </Text>
                            <Text style={[styles.planHint, { color: subText }]}>
                              {t("profile.health_plan_result_hint", {
                                defaultValue:
                                  "Here is what you should consume daily. Keep it automatic based on your goals or fine-tune it manually.",
                              })}
                            </Text>
                          </View>
                        </View>
                        <View style={styles.modeWrap}>
                          <TouchableOpacity
                            activeOpacity={0.85}
                            style={[styles.modeButton, { backgroundColor: planMode === "auto" ? cta : "transparent", borderColor: border }]}
                            onPress={() => onPlanModeChange("auto")}
                          >
                            <MaterialIcons name="auto-awesome" size={14} color={planMode === "auto" ? "#fff" : text} />
                            <Text style={[styles.modeButtonText, { color: planMode === "auto" ? "#fff" : text }]}>
                              {t("profile.health_plan_auto", { defaultValue: "Automatic" })}
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            activeOpacity={0.85}
                            style={[styles.modeButton, { backgroundColor: planMode === "manual" ? cta : "transparent", borderColor: border }]}
                            onPress={() => onPlanModeChange("manual")}
                          >
                            <MaterialIcons name="edit-note" size={15} color={planMode === "manual" ? "#fff" : text} />
                            <Text style={[styles.modeButtonText, { color: planMode === "manual" ? "#fff" : text }]}>
                              {t("profile.health_plan_manual", { defaultValue: "Manual" })}
                            </Text>
                          </TouchableOpacity>
                        </View>

                        <View style={styles.planGrid}>
                          {[
                            [
                              { key: "calories" as const, label: t("profile.health_calories", { defaultValue: "Calories" }), placeholder: "2100" },
                              { key: "protein" as const, label: t("my_day.protein"), placeholder: "130" },
                            ],
                            [
                              { key: "carbs" as const, label: t("my_day.carbs"), placeholder: "210" },
                              { key: "fat" as const, label: t("my_day.fat"), placeholder: "70" },
                            ],
                          ].map((row, rowIndex) => (
                            <View key={`plan-row-${rowIndex}`} style={styles.planGridRow}>
                              {row.map((field) => (
                                <View
                                  key={field.key}
                                  style={[
                                    styles.planGridCard,
                                    { backgroundColor: bg },
                                    planMode === "auto" ? styles.planGridCardAuto : null,
                                  ]}
                                >
                                  <Text style={[styles.planMetricLabel, { color: subText }]}>{field.label}</Text>
                                  {planMode === "manual" ? (
                                    <View style={styles.planGridManualWrap}>
                                      <View style={styles.planGridManualInputRow}>
                                        <TextInput
                                          value={
                                            draft.plan?.[field.key]
                                              ? formatPlanMetricValue(draft.plan?.[field.key] as number, field.key)
                                              : ""
                                          }
                                          onChangeText={(value) => onUpdatePlan(field.key, parsePlanMetricInput(value, field.key))}
                                          keyboardType="number-pad"
                                          editable
                                          style={[
                                            styles.planMetricInputInline,
                                            { color: text, borderColor: border, backgroundColor: card },
                                          ]}
                                          placeholder={planMetricPlaceholder(field.key, field.placeholder)}
                                          placeholderTextColor={subText}
                                        />
                                        <Text style={[styles.planMetricUnitInline, { color: subText }]}>
                                          {planMetricUnit(field.key)}
                                        </Text>
                                      </View>
                                    </View>
                                  ) : (
                                    <View style={styles.planGridValueWrap}>
                                      <Text style={[styles.planMetricValueInline, { color: text }]}>
                                        {draft.plan?.[field.key]
                                          ? formatPlanMetricValue(draft.plan?.[field.key] as number, field.key)
                                          : planMetricPlaceholder(field.key, field.placeholder)}
                                      </Text>
                                      <Text style={[styles.planMetricUnitInline, { color: subText }]}>
                                        {planMetricUnit(field.key)}
                                      </Text>
                                    </View>
                                  )}
                                </View>
                              ))}
                            </View>
                          ))}
                        </View>
                      </View>
                    </ScrollView>
                  </View>
                  </ScrollView>
                </View>

                    <View style={styles.actions}>
                      {currentStep === 0 ? (
                        <>
                          <TouchableOpacity
                            activeOpacity={0.85}
                            style={[styles.secondaryButton, { borderColor: border, backgroundColor: bg }]}
                            onPress={onClose}
                          >
                            <Text style={[styles.secondaryButtonText, { color: text }]}>{t("common.cancel")}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            activeOpacity={0.85}
                            style={[styles.primaryButton, { backgroundColor: cta }]}
                            onPress={() => {
                              if (!validateAboutYouStep()) return;
                              goToStep(1);
                            }}
                          >
                            <Text style={styles.primaryButtonText}>
                              {t("profile.health_define_goal", { defaultValue: "Define My goal" })}
                            </Text>
                          </TouchableOpacity>
                        </>
                      ) : null}

                      {currentStep === 1 ? (
                        <>
                          <TouchableOpacity
                            activeOpacity={0.85}
                            style={[styles.secondaryButton, { borderColor: border, backgroundColor: bg }]}
                            onPress={() => goToStep(0)}
                          >
                            <Text style={[styles.secondaryButtonText, { color: text }]}>{t("common.back")}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            activeOpacity={0.85}
                            style={[styles.primaryButton, { backgroundColor: cta }]}
                            onPress={() => {
                              if (!validateGoalStep()) return;
                              goToStep(2);
                            }}
                          >
                            <Text style={styles.primaryButtonText}>
                              {t("profile.health_generate_plan", { defaultValue: "Generate my plan" })}
                            </Text>
                          </TouchableOpacity>
                        </>
                      ) : null}

                      {currentStep === 2 ? (
                        <>
                          <TouchableOpacity
                            activeOpacity={0.85}
                            style={[styles.secondaryButton, { borderColor: border, backgroundColor: bg }]}
                            onPress={() => goToStep(1)}
                          >
                            <Text style={[styles.secondaryButtonText, { color: text }]}>{t("common.back")}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            activeOpacity={0.85}
                            style={[styles.primaryButton, { backgroundColor: cta }]}
                            onPress={onSave}
                          >
                            <Text style={styles.primaryButtonText}>{t("common.save")}</Text>
                          </TouchableOpacity>
                        </>
                      ) : null}
                    </View>
                  </>
                ) : null}
              </View>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    padding: 14,
  },
  keyboardWrap: {
    justifyContent: "center",
  },
  card: {
    borderRadius: 22,
    borderWidth: 1,
    padding: 18,
    height: 632,
    maxHeight: "90%",
    overflow: "hidden",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: "800",
  },
  scrollContent: {
    paddingBottom: 8,
    flexGrow: 1,
  },
  stepsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    marginBottom: 12,
    paddingBottom: 4,
  },
  headerDivider: {
    height: StyleSheet.hairlineWidth,
    marginBottom: 16,
  },
  stepItem: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  stepLabelWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  stepDotText: {
    fontSize: 11,
    fontWeight: "800",
  },
  stepLabel: {
    fontSize: 13,
    textAlign: "center",
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: "800",
    marginBottom: 8,
  },
  stepIntro: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  block: {
    marginTop: 2,
    marginBottom: 4,
  },
  blockSpacious: {
    marginTop: 14,
    marginBottom: 8,
  },
  aboutGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 8,
    alignItems: "stretch",
  },
  aboutCard: {
    width: "48%",
    paddingVertical: 2,
  },
  stackedFieldLabel: {
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
  },
  stackedFieldInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 5,
  },
  formRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 10,
  },
  pagerViewport: {
    flex: 1,
    overflow: "hidden",
  },
  stepPage: {
    flex: 1,
    overflow: "hidden",
  },
  fieldStack: {
    gap: 12,
    marginBottom: 8,
  },
  formHalf: {
    flex: 1,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  goalCardWrap: {
    gap: 10,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  goalCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  goalCardMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexShrink: 1,
  },
  goalTargetWrap: {
    width: 112,
    marginLeft: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  goalTargetInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
    flex: 1,
  },
  goalTargetUnit: {
    fontSize: 12,
    fontWeight: "700",
  },
  planStepWrap: {
    marginTop: 4,
  },
  planHint: {
    fontSize: 13,
    lineHeight: 18,
  },
  planHeader: {
    marginBottom: 8,
  },
  planHeaderCopy: {
    paddingRight: 0,
  },
  modeWrap: {
    flexDirection: "row",
    gap: 4,
    flexShrink: 0,
    marginTop: 6,
    marginBottom: 12,
    alignSelf: "stretch",
  },
  modeButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 34,
  },
  modeButtonText: {
    flexShrink: 1,
    fontWeight: "700",
    fontSize: 13,
    lineHeight: 16,
    textAlign: "center",
  },
  planGrid: {
    marginTop: 0,
  },
  planGridRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  planGridCard: {
    width: "48.5%",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 92,
    justifyContent: "space-between",
  },
  planGridCardAuto: {
    justifyContent: "center",
    alignItems: "center",
  },
  planMetricLabel: {
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    textAlign: "center",
  },
  planGridValueWrap: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  planGridManualWrap: {
    marginTop: 10,
  },
  planGridManualInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  planMetricValueInline: {
    fontSize: 21,
    fontWeight: "800",
    lineHeight: 23,
  },
  planMetricUnitInline: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 2,
  },
  planMetricInputInline: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 7,
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
    flex: 1,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
  },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 13,
  },
  secondaryButtonText: {
    fontWeight: "600",
    fontSize: 14,
  },
  primaryButton: {
    flex: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 13,
  },
  primaryButtonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
});
