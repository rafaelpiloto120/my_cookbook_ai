import React, { useEffect, useState, useRef } from "react";
import { View, Text, TouchableOpacity, StyleSheet, TextInput, Alert, Image, Modal, KeyboardAvoidingView, Platform, ScrollView, Keyboard } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Stack, useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useThemeColors, useTheme } from "../../context/ThemeContext";
import AppButton from "../../components/AppButton";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { saveUserPrefs } from "../../lib/prefs";
import * as Localization from "expo-localization";

import { supportedLanguages, SupportedLanguage } from "../../i18n";
import { MaterialIcons } from "@expo/vector-icons";

type ThemeMode = "light" | "dark";
type Measure = "metric" | "imperial";

// reuse the same stores/Profile keys the app already uses
const KEYS = {
  ONBOARDING_DONE: "onboarding_done",
  LANGUAGE: "language",
  DIETARY: "dietary",        // array of keys like ["dietary.vegan"] or ["dietary.none"]
  AVOID: "avoid",            // array of keys like ["avoid.gluten"] or ["avoid.none","avoid.other"]
  AVOID_OTHER: "avoidOther", // string
  MEASURE: "measureSystem",  // "metric" | "imperial"
  THEME: "themeMode",        // "system" | "light" | "dark"
};

const HEADER_BG = "#293a53";

// robust translator: never show raw keys; leverage i18next defaultValue
const tt = (tfn: any, key: string, fallback: string) => {
  try {
    const s = tfn(key, { defaultValue: fallback });
    if (!s || typeof s !== "string") return fallback;
    // If i18n returns the same key or a value that still contains the key, fallback
    if (s === key || s.includes(key)) return fallback;
    return s;
  } catch {
    return fallback;
  }
};

// Force-translation helper against the global i18n instance
const tr = (key: string, fallback: string) => {
  try {
    const s = i18n.t(key, { defaultValue: fallback, interpolation: { escapeValue: false } }) as string;
    if (!s || typeof s !== "string") return fallback;
    if (s === key || s.includes(key)) return fallback;
    return s;
  } catch {
    return fallback;
  }
};

// Language options helper (copied from Profile)
function getLanguageLabelAndFlag(code: SupportedLanguage): { label: string; flag: string } {
  switch (code) {
    case "en": return { label: "English", flag: "🇬🇧" };
    case "es": return { label: "Español", flag: "🇪🇸" };
    case "pt": return { label: "Português (PT)", flag: "🇵🇹" };
    case "pt-BR": return { label: "Português (BR)", flag: "🇧🇷" };
    case "fr": return { label: "Français", flag: "🇫🇷" };
    case "de": return { label: "Deutsch", flag: "🇩🇪" };
    case "it": return { label: "Italiano", flag: "🇮🇹" };
    default: return { label: code, flag: "" };
  }
}
const languageOptions = supportedLanguages.map(code => ({
  code,
  ...getLanguageLabelAndFlag(code as SupportedLanguage),
}));
function resolveSupportedLanguageFromDevice(): SupportedLanguage {
  try {
    const locales = (Localization as any)?.getLocales?.() || [];
    const tag: string | undefined =
      locales[0]?.languageTag ||
      (locales[0]?.languageCode
        ? `${locales[0].languageCode}${locales[0].regionCode ? "-" + locales[0].regionCode : ""}`
        : undefined);

    const norm = (tag || "").replace("_", "-").toLowerCase();

    if (norm.startsWith("pt-br")) return "pt-BR" as SupportedLanguage;
    if (norm.startsWith("pt"))    return "pt" as SupportedLanguage;
    if (norm.startsWith("es"))    return "es" as SupportedLanguage;
    if (norm.startsWith("fr"))    return "fr" as SupportedLanguage;
    if (norm.startsWith("de"))    return "de" as SupportedLanguage;
    if (norm.startsWith("it"))    return "it" as SupportedLanguage;
    if (norm.startsWith("en"))    return "en" as SupportedLanguage;

    return "en" as SupportedLanguage;
  } catch {
    return "en" as SupportedLanguage;
  }
}

// steps: 1=Intro + Language, 2=Dietary/Avoid, 3=Theme/Measure
export default function Onboarding() {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView | null>(null);
  const { t } = useTranslation();
  const router = useRouter();
  const { bg, isDark } = useThemeColors();
  const { theme, toggleTheme } = useTheme();

  // steps: 1=Intro + Language, 2=Dietary/Avoid, 3=Theme/Measure
  const [step, setStep] = useState(1);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // language
  const [language, setLanguage] = useState(i18n.language || "en");
  const [modalLanguage, setModalLanguage] = useState(false);

  // Auto-detect and set default language if none is stored
  useEffect(() => {
    (async () => {
      try {
        // Respect previously chosen language (from onboarding/profile)
        const storedUserLang = await AsyncStorage.getItem("userLanguage");
        const storedLegacy   = await AsyncStorage.getItem(KEYS.LANGUAGE);
        const chosen = storedUserLang || storedLegacy;

        if (chosen && typeof chosen === "string") {
          if (i18n.language !== chosen) {
            try { await i18n.changeLanguage(chosen as SupportedLanguage); } catch {}
          }
          setLanguage(chosen as SupportedLanguage);
          return;
        }

        // Auto-detect if nothing stored
        const detected = resolveSupportedLanguageFromDevice();
        setLanguage(detected);
        try { await i18n.changeLanguage(detected); } catch {}
      } catch {
        // ignore, keep current language
      }
    })();
  }, []);

  // Persist selected language immediately and broadcast via saveUserPrefs
  useEffect(() => {
    (async () => {
      try {
        if (!language) return;
        await AsyncStorage.setItem("userLanguage", language as string);
        await AsyncStorage.setItem(KEYS.LANGUAGE, language as string);
        await saveUserPrefs({ userLanguage: language as SupportedLanguage });
      } catch {}
    })();
  }, [language]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const onShow = (e: any) => {
      setKeyboardVisible(true);
      setKeyboardHeight(e?.endCoordinates?.height ?? 0);
    };

    const onHide = () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    };

    const subShow = Keyboard.addListener(showEvent, onShow);
    const subHide = Keyboard.addListener(hideEvent, onHide);

    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  // Safely coerce translation trees into plain objects (avoid rendering crashes if not loaded)
  const rawDietary = t("dietary", { returnObjects: true }) as any;
  const allDietary: Record<string, { label: string; icon: string }> =
    rawDietary && typeof rawDietary === "object" && !Array.isArray(rawDietary) ? rawDietary : {};

  const rawAvoid = t("avoid", { returnObjects: true }) as any;
  const allAvoid: Record<string, { label: string; icon: string }> =
    rawAvoid && typeof rawAvoid === "object" && !Array.isArray(rawAvoid) ? rawAvoid : {};
  const dietaryOptions = Object.fromEntries(
  Object.entries(allDietary).filter(([key]) => key !== "dietary.none" && key.toLowerCase() !== "none")
);
const avoidOptions = Object.fromEntries(
  Object.entries(allAvoid).filter(([key]) => key !== "avoid.none" && key.toLowerCase() !== "none")
);

  const [dietary, setDietary] = useState<string[]>([]);
const [avoid, setAvoid] = useState<string[]>([]);
  const [avoidOther, setAvoidOther] = useState("");

  // measure & theme
  const [measure, setMeasure] = useState<Measure>("metric");
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");


  const toggleDietary = (key: string) => {
  setDietary(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
};

const toggleAvoid = (key: string) => {
  setAvoid(prev => {
    const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
    if (!next.includes("other")) setAvoidOther(""); // Profile uses "other"
    return next;
  });
};

  const next = () => setStep((s) => Math.min(3, s + 1));
  const back = () => setStep((s) => Math.max(1, s - 1));

  async function persistOnboardingPrefs() {
    // Persist prefs centrally + notify listeners (Profile, AI Kitchen, etc.)
    await saveUserPrefs({
      userLanguage: language,
      userDietary: dietary,
      userAvoid: avoid,
      userAvoidOther: avoidOther || "",
      userMeasurement: measure,
      themeMode: themeMode,
    });

    // Also persist the same values to AsyncStorage using the keys
    // expected by the Profile screen and other legacy consumers.
    try {
      await AsyncStorage.multiSet([
        ["dietary", JSON.stringify(dietary || [])],
        ["avoid", JSON.stringify(avoid || [])],
        ["avoidOther", avoidOther || ""],
        ["measurement", measure],
        ["theme", themeMode],
      ]);
    } catch (e) {
      // If this fails, we still continue; saveUserPrefs already holds the source of truth
      console.warn(
        "Failed to persist onboarding dietary/avoid prefs to AsyncStorage",
        e
      );
    }

    // Ensure i18n reflects language immediately
    if (language && i18n.language !== language) {
      await i18n.changeLanguage(language).catch(() => {});
    }

    // Ensure ThemeContext matches the selected themeMode immediately,
    // so the user sees dark/light mode applied as soon as onboarding finishes.
    const shouldBeDark = themeMode === "dark";
    if ((shouldBeDark && theme !== "dark") || (!shouldBeDark && theme !== "light")) {
      try {
        toggleTheme();
      } catch {
        // best-effort: even if this fails, the stored preference is correct
      }
    }

    // Mark onboarding done
    await AsyncStorage.setItem(KEYS.ONBOARDING_DONE, "true");
    // Also set legacy flag so onboarding doesn't show again elsewhere
    await AsyncStorage.setItem("hasSeenOnboarding", "true");
    // Persist language redundantly (defensive)
    await AsyncStorage.setItem("userLanguage", language as string);
    await AsyncStorage.setItem(KEYS.LANGUAGE, language as string);
  }

  async function finalize() {
    try {
      await persistOnboardingPrefs();
      // Create localized default cookbooks if none exist
      await ensureDefaultCookbooks();
      // Go to tabs home
      router.replace("/(tabs)");
    } catch (e) {
      Alert.alert(t("common.error", "Error"), t("onboarding.error_save", "Could not save your preferences."));
    }
  }

  async function handleCreateAccount() {
  try {
    await persistOnboardingPrefs();
    // Create localized default cookbooks if none exist yet
    await ensureDefaultCookbooks();
  } catch {
    // even if this fails, still try to navigate so user can attempt auth
  }
  router.push("/auth/signin?mode=signup");
}

  async function handleSignInInstead() {
    try {
      await persistOnboardingPrefs();
      // Create localized default cookbooks if none exist yet
      await ensureDefaultCookbooks();
    } catch {
      // even if this fails, still try to navigate so user can attempt auth
    }
    router.push("/auth/signin");
  }

  async function ensureDefaultCookbooks() {
    // Local-only for now (your code already uses AsyncStorage for cookbooks)
    // Avoid overwriting existing user cookbooks
    const existingRaw = await AsyncStorage.getItem("cookbooks");
    const existing = existingRaw ? JSON.parse(existingRaw) : [];

    if (Array.isArray(existing) && existing.length > 0) return;

    // names localized via i18n at the moment of onboarding, using cookbook_defaults.*
    const defaults = [
      {
        id: "cb-favorites",
        name: t("cookbook_defaults.favorites", "Favorites"),
        imageUrl: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600",
      },
      {
        id: "cb-breakfast",
        name: t("cookbook_defaults.breakfast", "Breakfast"),
        imageUrl: "https://images.unsplash.com/photo-1504754524776-8f4f37790ca0?w=600",
      },
      {
        id: "cb-lunch",
        name: t("cookbook_defaults.lunch", "Lunch"),
        imageUrl: "https://images.unsplash.com/photo-1525755662778-989d0524087e?w=600",
      },
      {
        id: "cb-dinner",
        name: t("cookbook_defaults.dinner", "Dinner"),
        imageUrl: "https://images.unsplash.com/photo-1543353071-873f17a7a088?w=600",
      },
      {
        id: "cb-desserts",
        name: t("cookbook_defaults.desserts", "Desserts"),
        imageUrl: "https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=600",
      },
    ];

    await AsyncStorage.setItem("cookbooks", JSON.stringify(defaults));
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 80 : 0}
    >
      <SafeAreaView style={[styles.container, { backgroundColor: HEADER_BG, paddingTop: step === 1 ? insets.top : 0 }]}>
        <StatusBar style="light" backgroundColor={HEADER_BG} />
        <Stack.Screen
          options={{
            headerShown: step !== 1,
            title: t("onboarding.title", "Welcome to MyCookbook AI"),
            headerStyle: { backgroundColor: HEADER_BG },
            headerTintColor: "#fff",
            headerTitleAlign: "center",
            statusBarStyle: "light",
            statusBarBackgroundColor: HEADER_BG,
          }}
        />
        {/* STEP CONTENT */}
        {step === 1 && (
          <View key={language} style={styles.contentIntro}>
            {/* HERO: logo + title + slogan + blurb grouped together */}
            <View style={styles.introHero}>
              <Image
                source={require("../../assets/images/icon.png")}
                style={{ width: 128, height: 128, borderRadius: 28, marginBottom: 16 }}
                resizeMode="contain"
              />
              <Text style={[styles.h1, { color: "#fff", textAlign: "center" }]}>
                {t("onboarding.title", "Welcome to MyCookbook AI")}
              </Text>
              <Text style={styles.sloganText}>
                {t("common.slogan", "Your smart kitchen companion")}
              </Text>
              <Text style={styles.descText}>
                {t("onboarding.intro_blurb", "Tell us a few quick things to personalize your experience.")}
              </Text>
              <View style={styles.languageBlock}>
                <Text style={[styles.h2, { color: "#fff", marginTop: 8, marginBottom: 16 }]}>
                  {tr("onboarding.choose_language", "Choose your language")}
                </Text>
                <TouchableOpacity
                  onPress={() => setModalLanguage(true)}
                  activeOpacity={0.8}
                  style={styles.languagePicker}
                >
                  {(() => {
                    const current =
                      languageOptions.find(o => o.code === (language as SupportedLanguage)) ||
                      { flag: "🌐", label: String(language) };
                    return (
                      <View style={{ flexDirection: "row", alignItems: "center" }}>
                        <Text style={{ fontSize: 20, marginRight: 8 }}>{current.flag}</Text>
                        <Text style={{ fontSize: 16, color: "#111" }}>{current.label}</Text>
                      </View>
                    );
                  })()}
                </TouchableOpacity>
              </View>
            </View>

            {/* CTA pinned towards the bottom */}
            <View style={styles.introBottom}>
              <AppButton
                label={t("onboarding.lets_go", "Let's go!")}
                onPress={next}
                variant="cta"
                fullWidth
              />
              <Text style={{ color: "#fff", opacity: 0.9, fontSize: 13, textAlign: "center", marginTop: 10 }}>
                {tr("onboarding.change_later_note", "You can change these anytime later in your Profile area.")}
              </Text>
            </View>
            {/* Language modal list (like Profile) */}
            <Modal
              visible={modalLanguage}
              animationType="slide"
              transparent
              onRequestClose={() => setModalLanguage(false)}
            >
              <TouchableOpacity
                activeOpacity={1}
                onPress={() => setModalLanguage(false)}
                style={styles.modalOverlay}
              >
                <View style={[styles.modalContent, { backgroundColor: "#fff" }]} onStartShouldSetResponder={() => true}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={[styles.h2, { color: "#111", marginBottom: 8 }]}>
                      {tr("profile.select_language", "Select language")}
                    </Text>
                    <TouchableOpacity onPress={() => setModalLanguage(false)}>
                      <MaterialIcons name="close" size={24} color="#333" />
                    </TouchableOpacity>
                  </View>

                  {languageOptions.map((option) => (
                    <TouchableOpacity
                      key={option.code}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        paddingVertical: 12,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: "#e0e0e0",
                      }}
                      onPress={async () => {
                        const lng = option.code as SupportedLanguage;
                        setLanguage(lng);
                        try { await i18n.changeLanguage(lng); } catch {}
                        try {
                          await AsyncStorage.setItem("userLanguage", lng);
                          await AsyncStorage.setItem(KEYS.LANGUAGE, lng);
                          await saveUserPrefs({ userLanguage: lng });
                        } catch {}
                        setModalLanguage(false);
                      }}
                    >
                      <Text style={{ fontSize: 20, marginRight: 10 }}>{option.flag}</Text>
                      <Text style={{
                        color: "#111",
                        fontWeight: language === option.code ? "bold" : "normal",
                        fontSize: 16,
                      }}>
                        {option.label}
                      </Text>
                      {language === option.code && (
                        <MaterialIcons name="check" size={20} color="#E27D60" style={{ marginLeft: "auto" }} />
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              </TouchableOpacity>
            </Modal>
          </View>
        )}

        {step === 2 && (
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={[
              styles.content,
              { paddingBottom: 120 + (keyboardVisible ? keyboardHeight : 0) },
            ]}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          >
            <Text style={[styles.p, { color: "#fff", fontSize: 18, marginBottom: 22 }]}>
              {tt(t, "profile.food_preferences_explainer", "These questions help us personalize your AI Kitchen experience.")}
            </Text>
            <Text style={[styles.h2, { color: "#fff", marginTop: 6, marginBottom: 12 }]}>
              {tt(t, "profile.dietary_restrictions", "Dietary restrictions")}
            </Text>
            <View style={[styles.rowWrap, { marginTop: 4 }]}>
              {Object.entries(dietaryOptions).map(([k, opt]) => (
                <TouchableOpacity
                  key={k}
                  style={[
                    styles.chip,
                    dietary.includes(k)
                      ? { backgroundColor: "#E27D60", borderColor: "#E27D60", borderWidth: 1 }
                      : { backgroundColor: "#E0E0E0", borderColor: "transparent", borderWidth: 1 }
                  ]}
                  onPress={() => toggleDietary(k)}
                >
                  <Text style={{ color: dietary.includes(k) ? "#fff" : "#000" }}>{opt.icon} {opt.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[
                  styles.chip,
                  dietary.length === 0
                    ? { backgroundColor: "#E27D60", borderColor: "#E27D60", borderWidth: 1 }
                    : { backgroundColor: "#E0E0E0", borderColor: "transparent", borderWidth: 1 }
                ]}
                onPress={() => setDietary([])}
              >
                <Text style={{ color: dietary.length === 0 ? "#fff" : "#000" }}>{tr("common.none", "None")}</Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.h2, { color: "#fff", marginTop: 28, marginBottom: 12 }]}>
              {tt(t, "profile.ingredients_to_avoid", "Ingredients to avoid")}
            </Text>
            <View style={[styles.rowWrap, { marginTop: 4 }]}>
              {Object.entries(avoidOptions).map(([k, opt]) => (
                <TouchableOpacity
                  key={k}
                  style={[
                    styles.chip,
                    avoid.includes(k)
                      ? { backgroundColor: "#E27D60", borderColor: "#E27D60", borderWidth: 1 }
                      : { backgroundColor: "#E0E0E0", borderColor: "transparent", borderWidth: 1 }
                  ]}
                  onPress={() => toggleAvoid(k)}
                >
                  <Text style={{ color: avoid.includes(k) ? "#fff" : "#000" }}>{opt.icon} {opt.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[
                  styles.chip,
                  avoid.length === 0
                    ? { backgroundColor: "#E27D60", borderColor: "#E27D60", borderWidth: 1 }
                    : { backgroundColor: "#E0E0E0", borderColor: "transparent", borderWidth: 1 }
                ]}
                onPress={() => { setAvoid([]); setAvoidOther(""); }}
              >
                <Text style={{ color: avoid.length === 0 ? "#fff" : "#000" }}>{tr("common.none", "None")}</Text>
              </TouchableOpacity>
            </View>

            {avoid.includes("other") && (
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: "#ffffff",
                    color: "#111111",
                    borderColor: "#ccc",
                    textAlignVertical: "top",
                    marginBottom: keyboardVisible ? keyboardHeight + 16 : 16,
                  },
                ]}
                placeholder={t("profile.avoid_other_placeholder")}
                placeholderTextColor="#888"
                value={avoidOther}
                onChangeText={setAvoidOther}
                multiline
                onFocus={() => {
                  setTimeout(() => {
                    scrollRef.current?.scrollToEnd({ animated: true });
                  }, 50);
                }}
              />
            )}

            <View style={{ height: 8 }} />
            <View style={[styles.footerRow, { marginTop: "auto", paddingTop: 16 }]}>
              <AppButton label={tr("common.back", "Back")} onPress={back} variant="secondary" style={{ flex: 1, marginRight: 8 }} />
              <AppButton label={tr("common.next", "Next")} onPress={next} variant="cta" style={{ flex: 1, marginLeft: 8 }} />
            </View>
          </ScrollView>
        )}

        {step === 3 && (
          <View style={styles.contentStep}>
            <Text style={[styles.p, { color: "#fff", fontSize: 18, marginBottom: 22 }]}>
              {tt(
                t,
                "onboarding.final_prefs_explainer",
                "You're almost ready! Set your appearance, measurement units, and, if you like, create or sign in to a free account now or later from your Profile."
              )}
            </Text>
            {/* Appearance */}
            <Text style={[styles.h2, { color: "#fff", marginTop: 4, marginBottom: 12 }]}>
              {tr("profile.theme_title", "Appearance")}
            </Text>
            <View style={styles.rowWrap}>
              {[
                { k: "light", label: tr("onboarding.theme_light", "Light") },
                { k: "dark",  label: tr("onboarding.theme_dark",  "Dark")  },
              ].map(m => (
                <TouchableOpacity
                  key={m.k}
                  style={[
                    styles.chip,
                    themeMode === m.k
                      ? { backgroundColor: "#E27D60", borderColor: "#E27D60", borderWidth: 1 }
                      : { backgroundColor: "#E0E0E0", borderColor: "transparent", borderWidth: 1 }
                  ]}
                  onPress={() => setThemeMode(m.k as ThemeMode)}
                >
                  <Text style={{ color: themeMode === m.k ? "#fff" : "#000" }}>{m.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Measurement */}
            <Text style={[styles.h2, { color: "#fff", marginTop: 28, marginBottom: 12 }]}>
              {tr("profile.measure_system_title", "Measurement system")}
            </Text>
            <View style={styles.rowWrap}>
              {[
                { k: "metric",   label: tr("onboarding.measurement_metric", "Metric") },
                { k: "imperial", label: tr("onboarding.measurement_imperial", "Imperial") },
              ].map(m => (
                <TouchableOpacity
                  key={m.k}
                  style={[
                    styles.chip,
                    measure === m.k
                      ? { backgroundColor: "#E27D60", borderColor: "#E27D60", borderWidth: 1 }
                      : { backgroundColor: "#E0E0E0", borderColor: "transparent", borderWidth: 1 }
                  ]}
                  onPress={() => setMeasure(m.k as Measure)}
                >
                  <Text style={{ color: measure === m.k ? "#fff" : "#000" }}>{m.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Optional account creation section */}
            <View style={{ marginTop: 28 }}>
              <Text style={[styles.h2, { color: "#fff", marginBottom: 12 }]}>
                {tr("onboarding.account_title", "Create a free account (optional)")}
              </Text>
              <Text style={[styles.p, { color: "#fff", fontSize: 15, marginBottom: 14 }]}>
                {tr(
                  "onboarding.account_explainer",
                  "Save your cookbooks and preferences across devices and get ready for future premium features."
                )}
              </Text>
              <View style={{ flexDirection: "row" }}>
                <AppButton
                  label={tr("onboarding.account_create", "Create account")}
                  onPress={handleCreateAccount}
                  variant="cta"
                  style={{ flex: 1, marginRight: 8 }}
                />
                <AppButton
                  label={tr("onboarding.account_signin", "Sign in")}
                  onPress={handleSignInInstead}
                  variant="secondary"
                  style={{ flex: 1, marginLeft: 8 }}
                />
              </View>
            </View>

            {/* Footer */}
            <View style={[styles.footerRow, { marginTop: "auto", paddingTop: 16 }]}>
              <AppButton
                label={tr("common.back", "Back")}
                onPress={back}
                variant="secondary"
                style={{ flex: 1, marginRight: 8 }}
              />
              <AppButton
                label={tr("onboarding.skip_account", "Continue without account")}
                onPress={finalize}
                variant="cta"
                style={{ flex: 1, marginLeft: 8 }}
              />
            </View>
          </View>
        )}
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, padding: 20, justifyContent: "flex-start" },
  contentStep: { flex: 1, padding: 20 },
  h1: { fontSize: 24, fontWeight: "800", marginBottom: 8 },
  h2: { fontSize: 18, fontWeight: "700", marginBottom: 6 },
  p: { fontSize: 15, lineHeight: 22 },
  rowWrap: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "transparent",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    minHeight: 48,
    marginTop: 8,
  },
  footerRow: { flexDirection: "row", marginTop: 10 },
  footerCol: { marginTop: 10 },
  contentIntro: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 24,
    justifyContent: "space-between",
  },
  introHero: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  introBottom: {
    marginTop: 16,
  },
  sloganText: {
    color: "#fff",
    opacity: 0.95,
    fontSize: 17,
    fontWeight: "600",
    marginTop: 6,
    textAlign: "center",
  },
  descText: {
    color: "#fff",
    opacity: 0.98,
    fontSize: 18,
    lineHeight: 24,
    marginTop: 40,
    textAlign: "center",
    maxWidth: 340,
    alignSelf: "center",
  },
  languageBlock: {
    marginTop: 20,
    marginBottom: 0,
    alignSelf: "stretch",
  },
  languagePicker: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 48,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.25)",
    justifyContent: "flex-end",
  },
  modalContent: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    maxHeight: "80%",
  },
});