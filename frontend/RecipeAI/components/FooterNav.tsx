import React from "react";
import { View, TouchableOpacity, Text, StyleSheet } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import { useThemeColors } from "../context/ThemeContext";

export default function FooterNav() {
  const router = useRouter();
  const pathname = usePathname();
  const { bg, text, subText } = useThemeColors();

  return (
    <View style={[styles.footer, { backgroundColor: bg }]}>
      <TouchableOpacity
        style={styles.tab}
        onPress={() => router.push("/(tabs)/index")}
      >
        <MaterialIcons
          name="psychology"
          size={22}
          color={pathname.includes("/index") ? "#E27D60" : subText}
        />
        <Text
          style={{
            color: pathname.includes("/index") ? "#E27D60" : subText,
            fontSize: 12,
          }}
        >
          AI Kitchen
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.tab}
        onPress={() => router.push("/(tabs)/history")}
      >
        <MaterialIcons
          name="book"
          size={22}
          color={pathname.includes("/history") ? "#E27D60" : subText}
        />
        <Text
          style={{
            color: pathname.includes("/history") ? "#E27D60" : subText,
            fontSize: 12,
          }}
        >
          My Recipes
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    paddingVertical: 8,
    borderTopWidth: 1,
    borderColor: "#444",
  },
  tab: {
    alignItems: "center",
  },
});
