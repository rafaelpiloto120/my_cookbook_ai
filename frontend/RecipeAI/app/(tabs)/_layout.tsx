import { Tabs, Stack, useRouter, usePathname } from "expo-router";
import { useThemeColors } from "../../context/ThemeContext";
import { MaterialIcons } from "@expo/vector-icons";
import { View, Text, Platform } from "react-native";
import React, { useEffect, useState, useRef } from "react";
import { getAuth } from "firebase/auth";
import { getDeviceId } from "../../utils/deviceId";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncEngine } from "../../lib/sync/SyncEngine";
import { useFocusEffect } from "@react-navigation/native";
import { getApiBaseUrl } from "../../lib/config/api";
import { loadLastMainTab, mainTabFromPathname, saveLastMainTab } from "../../lib/navigation/lastMainTab";

export default function TabLayout() {
  const { isDark, bg, text } = useThemeColors();

  const { t } = useTranslation();

  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [restoredInitialTab, setRestoredInitialTab] = useState(false);
  const appOpenLoggedRef = useRef(false);
  const initialTabRestoreInFlightRef = useRef(false);
  const syncEngine = useSyncEngine();

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const done = await AsyncStorage.getItem("hasSeenOnboarding");
        if (!done && pathname !== "/onboarding") {
          // Redirect to onboarding only on first run (avoid loop if already on onboarding)
          router.replace("/onboarding");
        } else if (done && !restoredInitialTab) {
          const currentMainTab = mainTabFromPathname(pathname);
          const lastMainTab = await loadLastMainTab();
          if (currentMainTab === "index" && lastMainTab && lastMainTab !== "index") {
            initialTabRestoreInFlightRef.current = true;
            router.replace(`/${lastMainTab}` as any);
          }
        }
      } finally {
        if (isMounted) setRestoredInitialTab(true);
        if (isMounted) setReady(true);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [pathname, restoredInitialTab, router]);

  useEffect(() => {
    if (!ready || !restoredInitialTab) return;
    let isMounted = true;
    (async () => {
      const done = await AsyncStorage.getItem("hasSeenOnboarding");
      if (!isMounted || !done) return;

      const currentMainTab = mainTabFromPathname(pathname);
      if (!currentMainTab) return;
      if (initialTabRestoreInFlightRef.current && currentMainTab === "index") return;
      initialTabRestoreInFlightRef.current = false;
      await saveLastMainTab(currentMainTab);
    })().catch((err) => {
      console.warn("[Navigation] Failed to save last main tab", err);
    });
    return () => {
      isMounted = false;
    };
  }, [pathname, ready, restoredInitialTab]);

  useEffect(() => {
    if (!ready || appOpenLoggedRef.current) return;

    appOpenLoggedRef.current = true;

    (async () => {
      try {
        const backendUrl = getApiBaseUrl();
        const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
        console.log("[Analytics] app_open env", { backendUrl, appEnv });
        if (!backendUrl) {
          console.warn("[Analytics] EXPO_PUBLIC_API_URL not set; skipping app_open log.");
          return;
        }

        const auth = getAuth();
        const currentUser = auth.currentUser;
        const userId = currentUser?.uid ?? null;

        let deviceId: string | null = null;
        try {
          deviceId = await getDeviceId();
        } catch (err) {
          console.warn("[Analytics] getDeviceId failed for app_open", err);
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (deviceId) headers["x-device-id"] = deviceId;
        if (userId) headers["x-user-id"] = userId;

        await fetch(`${backendUrl}/analytics-event`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            eventType: "app_open",
            userId,
            deviceId,
            metadata: {
              route: pathname,
              isDark,
              platform: Platform.OS ?? "unknown",
              appEnv, // 👈 local / preview / production
            },
          }),
        });
      } catch (e) {
        console.warn("[Analytics] Failed to log app_open", e);
      }
    })();
  }, [ready, pathname, isDark]);

  useFocusEffect(
    React.useCallback(() => {
      if (syncEngine) {
        syncEngine.syncAll("tab-focus").catch(err => {
          console.warn("[SyncEngine] tab-focus sync error", err);
        });
      }
    }, [syncEngine])
  );

  if (!ready) return null;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

      <Tabs
        screenOptions={({ route }) => ({
          headerStyle: { backgroundColor: bg },
          headerTintColor: text,
          headerTitleStyle: { fontWeight: "600" },
          tabBarStyle: { backgroundColor: "#293a53" },
          tabBarActiveTintColor: "#ffbd80ff",
          tabBarInactiveTintColor: "#fff",
          tabBarIcon: ({ color, focused }) => {
            const tintColor = focused ? "#ffbd80ff" : "#fff";
            const scale = focused ? 1.1 : 1;
            let iconName: keyof typeof MaterialIcons.glyphMap = "book";

            if (route.name === "index") iconName = "restaurant";
            else if (route.name === "my-day") iconName = "insights";
            else if (route.name === "profile") iconName = "person-outline";

            return (
              <View style={{ transform: [{ scale }] }}>
                <MaterialIcons name={iconName} size={22} color={tintColor} />
                {route.name === "index" && (
                  <Text style={{ fontSize: 14, marginLeft: 4 }}>🔥</Text>
                )}
              </View>
            );
          },
          tabBarLabelStyle: {
            fontWeight: "600",
          },
        })}
      >
        <Tabs.Screen
          name="history"
          options={{
            title: t("recipes.my_recipes"),
            tabBarLabel: t("recipes.my_recipes"),
            tabBarIcon: ({ color }) => (
              <MaterialIcons name="book" size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="index"
          options={{
            title: t("app_titles.ai_kitchen"),
            tabBarLabel: t("app_titles.ai_kitchen"),
            tabBarIcon: ({ color }) => (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <MaterialIcons name="restaurant" size={22} color={color} />
                <Text style={{ fontSize: 14, marginLeft: 4 }}>🔥</Text>
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="my-day"
          options={{
            title: t("app_titles.my_day"),
            tabBarLabel: t("app_titles.my_day"),
            tabBarIcon: ({ color, size }) => (
              <MaterialIcons name="insights" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: t("profile.title"),
            tabBarLabel: t("profile.title"),
            tabBarIcon: ({ color, size }) => (
              <MaterialIcons name="person-outline" size={size} color={color} />
            ),
          }}
        />
        {/* Hide RecipeDetail from tab bar */}
        <Tabs.Screen
          name="recipe/[id]"
          options={{
            href: null, // ✅ hides from tab bar & deep links
            headerShown: false, // we'll render our own header inside the screen
          }}
        />
        <Tabs.Screen
          name="recipe/start-cooking"
          options={{
            href: null, // ✅ hides from tab bar & deep links
            headerShown: false, // we'll render our own header inside the screen
          }}
        />
        <Tabs.Screen
          name="discover"
          options={{
            href: null, // ✅ hides from tab bar & deep links
            headerShown: false, // we'll render our own header inside the screen
          }}
        />
        <Tabs.Screen
          name="my-day/history"
          options={{
            href: null,
            headerShown: false,
          }}
        />
        <Tabs.Screen
          name="my-day/trends"
          options={{
            href: null,
            headerShown: false,
          }}
        />
        <Tabs.Screen
          name="my-day/weight"
          options={{
            href: null,
            headerShown: false,
          }}
        />
      </Tabs>
    </>
  );
}
