import { useEffect, useState, useRef } from "react";
import { Stack, useRouter, usePathname } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, useThemeColors } from "../context/ThemeContext";
import i18n from "../i18n";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ActivityIndicator, View, Platform, AppState, AppStateStatus } from "react-native";
import { AuthProvider } from "../context/AuthContext";
import { useSyncEngine } from "../lib/sync/SyncEngine";
import { getOrCreateDeviceId } from "../utils/deviceId";
import { auth } from "../firebaseConfig";

function RootStack() {
  const { bg, text } = useThemeColors();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: bg },
        headerTintColor: text,
        headerTitleStyle: { fontWeight: "600" },
      }}
    >
      {/* Tabs app */}
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      {/* Auth sign-in screen (matches app/auth/signin.tsx) */}
      <Stack.Screen name="auth/signin" options={{ headerShown: false }} />
      {/* Onboarding flow root (matches app/onboarding/index.tsx) */}
      <Stack.Screen name="onboarding/index" options={{ headerShown: false }} />
      <Stack.Screen name="economy" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const hasLoggedSessionRef = useRef(false);
  const syncEngine = useSyncEngine();

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Load saved language (we use the key `userLanguage` everywhere else)
        const savedLang = (await AsyncStorage.getItem("userLanguage")) || "en";
        if (savedLang) {
          await i18n.changeLanguage(savedLang);
        }

        // Check onboarding flag
        const hasSeen = await AsyncStorage.getItem("hasSeenOnboarding");
        const shouldShowOnboarding = !hasSeen;

        // Avoid redirect loop if we're already on onboarding
        if (shouldShowOnboarding && pathname !== "/onboarding") {
          router.replace("/onboarding");
        }
      } catch (err) {
        console.warn("[RootLayout] init error:", err);
      } finally {
        if (!cancelled) setIsReady(true);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  useEffect(() => {
    let cancelled = false;

    async function initDeviceAndAnalytics() {
      try {
        const id = await getOrCreateDeviceId();
        if (cancelled) return;

        console.log("[Analytics] deviceId =>", id);

        const url = process.env.EXPO_PUBLIC_API_URL;
        if (!url) {
          console.warn("[Analytics] No EXPO_PUBLIC_API_URL set, skipping session_start logging.");
          return;
        }

        // Avoid logging the same session multiple times
        if (hasLoggedSessionRef.current) return;
        hasLoggedSessionRef.current = true;

        const currentUser = auth.currentUser;
        const userId = currentUser?.uid ?? null;

        const payload = {
          eventType: "session_start",
          userId,
          deviceId: id,
          metadata: {
            platform: Platform.OS,
          },
        };

        console.log("[Analytics] Sending session_start =>", payload);

        try {
          await fetch(`${url}/analytics-event`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(id ? { "x-device-id": id } : {}),
              ...(userId ? { "x-user-id": userId } : {}),
            },
            body: JSON.stringify(payload),
          });
        } catch (err) {
          console.warn("[Analytics] Failed to log session_start:", err);
        }
      } catch (e) {
        console.warn("[Analytics] Failed to get deviceId:", e);
      }
    }

    initDeviceAndAnalytics();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!syncEngine) {
      console.warn("[RootLayout] syncEngine unavailable; skipping AppState foreground sync");
      return;
    }

    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        if (nextState === "active") {
          console.log("[SyncEngine] App returned to foreground, requesting sync (app-foreground)");
          // requestSync already handles errors internally
          syncEngine.requestSync("app-foreground");
        }
      }
    );

    return () => {
      subscription.remove();
    };
  }, [syncEngine]);

  if (!isReady) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <RootStack />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}