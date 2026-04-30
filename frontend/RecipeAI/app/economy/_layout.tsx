// frontend/RecipeAI/app/economy/_layout.tsx
import React from "react";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";

export default function EconomyLayout() {
  const { t } = useTranslation();

  return (
    <Stack
      screenOptions={{
        presentation: "modal",
        headerShown: true,
        headerStyle: { backgroundColor: "#293a53" },
        headerTintColor: "#fff",
        headerTitleAlign: "center",
      }}
    >
      <Stack.Screen
        name="store"
        options={{
          title: t("economy.cookies", { defaultValue: "Eggs" }),
        }}
      />
    </Stack>
  );
}
