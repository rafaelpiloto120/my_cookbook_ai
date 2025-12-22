// frontend/RecipeAI/app/economy/_layout.tsx
import React from "react";
import { Stack } from "expo-router";

export default function EconomyLayout() {
  return (
    <Stack
      screenOptions={{
        presentation: "modal",
        headerShown: true,
        headerStyle: { backgroundColor: "#293a53" },
        headerTintColor: "#fff",
        headerTitleAlign: "center",
        headerBackTitleVisible: false,
      }}
    >
      <Stack.Screen
        name="store"
        options={{
          title: "Buy cookies",
        }}
      />
    </Stack>
  );
}