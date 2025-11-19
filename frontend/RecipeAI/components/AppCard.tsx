import React from "react";
import { View, StyleSheet, ViewStyle } from "react-native";
import { useThemeColors } from "../context/ThemeContext";

interface AppCardProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

export default function AppCard({ children, style }: AppCardProps) {
  const { card, border } = useThemeColors();

  return (
    <View style={[styles.card, { backgroundColor: card, borderColor: border }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
});