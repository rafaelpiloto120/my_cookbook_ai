import React, { useEffect } from "react";
import { View, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";

export default function SignupRedirectScreen() {
  const router = useRouter();

  useEffect(() => {
    // Always redirect to the unified auth screen in signup mode
    router.replace("/auth/signin?mode=signup");
  }, [router]);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator />
    </View>
  );
}