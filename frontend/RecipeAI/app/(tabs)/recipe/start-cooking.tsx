// app/(tabs)/recipe/start-cooking.tsx
import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  PanResponder,
  Animated,
  Easing,
  Dimensions,
  ScrollView,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack, useNavigation } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import { useThemeColors } from "../../../context/ThemeContext";
import { useKeepAwake } from "expo-keep-awake";
import { useTranslation } from "react-i18next";

interface Recipe {
  id: string;
  title: string;
  steps: string[];
}

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const SWIPE_DISTANCE = 80; // px before we switch steps

export default function StartCooking() {
  const { t } = useTranslation();
  const { recipe } = useLocalSearchParams<{ recipe?: string }>();
  const [currentStep, setCurrentStep] = useState(0);
  const [parsedRecipe, setParsedRecipe] = useState<Recipe | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const router = useRouter();
  const nav = useNavigation();
  const { bg, text, subText } = useThemeColors();

  // keep screen awake
  useKeepAwake();

  // hide tab bar while in cooking mode
  useEffect(() => {
    const parent = (nav as any)?.getParent?.();
    parent?.setOptions?.({ tabBarStyle: { display: "none" } });
    return () => parent?.setOptions?.({ tabBarStyle: undefined });
  }, [nav]);

  // parse incoming recipe
  useEffect(() => {
    if (!recipe) return;
    try {
      const parsed: Recipe = JSON.parse(recipe);
      setParsedRecipe(parsed);
      if (Array.isArray(parsed.steps)) setSteps(parsed.steps);
    } catch (e) {
      console.warn("Failed to parse recipe:", e);
    }
  }, [recipe]);

  // --- animation state for swipe ---
  const panX = useRef(new Animated.Value(0)).current;

  // IMPORTANT: keep a ref in sync with the current step to avoid stale closures
  const stepRef = useRef(currentStep);
  useEffect(() => {
    stepRef.current = currentStep;
  }, [currentStep]);

  // slide in from left/right
  const animateSlideIn = (fromRight: boolean) => {
    panX.setValue(fromRight ? SCREEN_WIDTH : -SCREEN_WIDTH);
    Animated.timing(panX, {
      toValue: 0,
      duration: 220,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };

  // PanResponder: drive panX while dragging; decide on release USING THE REF
  const panXStart = useRef(0);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_evt, gesture) =>
        Math.abs(gesture.dx) > Math.abs(gesture.dy) && Math.abs(gesture.dx) > 6,
      onPanResponderGrant: () => {
        // @ts-ignore - private but works for read
        panXStart.current = panX._value || 0;
      },
      onPanResponderMove: (_evt, gesture) => {
        panX.setValue(panXStart.current + gesture.dx);
      },
      onPanResponderRelease: (_evt, gesture) => {
        const { dx } = gesture;
        const idx = stepRef.current; // <-- always up-to-date
        if (dx < -SWIPE_DISTANCE && idx < steps.length - 1) {
          // swipe left → next
          setCurrentStep((s) => s + 1);
          animateSlideIn(true);
        } else if (dx > SWIPE_DISTANCE && idx > 0) {
          // swipe right → prev
          setCurrentStep((s) => s - 1);
          animateSlideIn(false);
        } else {
          // not enough → snap back
          Animated.spring(panX, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
          }).start();
        }
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate: () => {
        Animated.spring(panX, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 0,
        }).start();
      },
    })
  ).current;

  // button handlers use the same animation pattern
  const nextStep = () => {
    setCurrentStep((s) => {
      if (s < steps.length - 1) {
        animateSlideIn(true);
        return s + 1;
      }
      return s;
    });
  };

  const prevStep = () => {
    setCurrentStep((s) => {
      if (s > 0) {
        animateSlideIn(false);
        return s - 1;
      }
      return s;
    });
  };

  // adaptive text sizing: larger for short steps, smaller for long
  const stepText = steps[currentStep] || "";
  const len = stepText.length;
  const fontSize = len < 60 ? 30 : len < 140 ? 24 : 20;
  const lineHeight = Math.round(fontSize * 1.4);

  if (steps.length === 0 || !parsedRecipe) {
    return (
      <View style={[styles.center, { backgroundColor: bg }]}>
        <Text style={{ color: text }}>{t("recipes.no_steps")}</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 20 }}>
          <Text style={{ color: "#E27D60", fontWeight: "600" }}>{t("recipes.back")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      <StatusBar hidden />

      <Stack.Screen
        options={{
          headerShown: true,
          title: t("recipes.cooking_mode"),
          presentation: "fullScreenModal",
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
          headerLeft: () => <View />, // no default back
          headerRight: () => (
            <TouchableOpacity
              onPress={() =>
                router.replace({
                  pathname: "/(tabs)/recipe/[id]",
                  params: { id: parsedRecipe.id, recipe: JSON.stringify(parsedRecipe) },
                })
              }
              style={{ padding: 8 }}
            >
              <MaterialIcons name="close" size={26} color="#fff" />
            </TouchableOpacity>
          ),
          tabBarStyle: { display: "none" },
        }}
      />

      {/* Progress Bar */}
      <View style={styles.progressContainer}>
        <View
          style={[
            styles.progressBar,
            { width: `${((currentStep + 1) / steps.length) * 100}%` },
          ]}
        />
      </View>

      <Text style={[styles.progressText, { color: subText }]}>
        {t("recipes.step_of", { current: currentStep + 1, total: steps.length })}
      </Text>

      {/* Current Step (swipe + vertical scroll for long text) */}
      <View style={styles.stepOuter}>
        <Animated.View
          {...panResponder.panHandlers}
          style={[styles.stepInner, { transform: [{ translateX: panX }] }]}
        >
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ alignItems: "center", justifyContent: "center", flexGrow: 1 }}
          >
            <Text style={[styles.stepText, { color: text, fontSize, lineHeight }]}>
              {stepText}
            </Text>
          </ScrollView>
        </Animated.View>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          onPress={prevStep}
          disabled={currentStep === 0}
          style={[styles.navButton, currentStep === 0 && { opacity: 0.4 }]}
        >
          <MaterialIcons name="arrow-back" size={28} color="#fff" />
          <Text style={styles.navText}>{t("recipes.back")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={nextStep}
          disabled={currentStep === steps.length - 1}
          style={[styles.navButton, currentStep === steps.length - 1 && { opacity: 0.4 }]}
        >
          <Text style={styles.navText}>{t("recipes.next")}</Text>
          <MaterialIcons name="arrow-forward" size={28} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, justifyContent: "center" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },

  progressContainer: {
    height: 8,
    backgroundColor: "#ccc",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 10,
  },
  progressBar: { height: "100%", backgroundColor: "#E27D60" },
  progressText: { textAlign: "center", marginBottom: 20, fontWeight: "600" },

  stepOuter: {
    flex: 1,
    overflow: "hidden", // prevents overshoot during slide
    justifyContent: "center",
  },
  stepInner: {
    paddingHorizontal: 12,
    flex: 1,
  },
  stepText: {
    fontWeight: "500",
    textAlign: "center",
  },

  controls: { flexDirection: "row", justifyContent: "space-between", marginTop: 20 },
  navButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E27D60",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 28,
  },
  navText: { color: "#fff", fontWeight: "600", marginHorizontal: 6 },
});