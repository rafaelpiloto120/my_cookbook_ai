// frontend/RecipeAI/app/economy/_layout.tsx
import React from "react";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "../../context/ThemeContext";

export default function EconomyLayout() {
  const { t } = useTranslation();
  const { headerBg, headerText } = useThemeColors();

  return (
    <Stack
      screenOptions={{
        presentation: "modal",
        headerShown: true,
        headerStyle: { backgroundColor: headerBg },
        headerTintColor: headerText,
        headerTitleAlign: "center",
      }}
    >
      <Stack.Screen
        name="store"
        options={{
          title: t("economy.manage_cookies_title", { defaultValue: "Manage Eggs" }),
        }}
      />
    </Stack>
  );
}
