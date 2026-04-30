import React from "react";
import { TouchableOpacity, Text, StyleSheet, ViewStyle } from "react-native";
import { useThemeColors } from "../context/ThemeContext";

interface AppButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "cta" | "danger";
  fullWidth?: boolean;
  style?: ViewStyle;
  disabled?: boolean;
}

export default function AppButton({
  label,
  onPress,
  variant = "primary",
  fullWidth = true,
  style,
  disabled = false,
}: AppButtonProps) {
  const { primary, secondary, cta, text, bg } = useThemeColors();

  const backgroundColor =
    variant === "primary"
      ? primary
      : variant === "secondary"
      ? secondary
      : variant === "cta"
      ? cta
      : "#D9534F"; // 🔴 danger (vermelho)

  const textColor = variant === "secondary" ? "#212121" : "#fff";

  return (
    <TouchableOpacity
      style={[
        styles.button,
        { backgroundColor, width: fullWidth ? "100%" : undefined },
        disabled ? { opacity: 0.7 } : null,
        style,
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      disabled={disabled}
    >
      <Text style={[styles.label, { color: textColor }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 6,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
    includeFontPadding: false,
    textAlignVertical: "center",
  },
});
