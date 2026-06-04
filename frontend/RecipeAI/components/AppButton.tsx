import React from "react";
import { TouchableOpacity, Text, StyleSheet, View, ViewStyle } from "react-native";
import { useThemeColors } from "../context/ThemeContext";

interface AppButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "cta" | "danger";
  fullWidth?: boolean;
  style?: ViewStyle;
  disabled?: boolean;
  leftIcon?: React.ReactNode;
}

export default function AppButton({
  label,
  onPress,
  variant = "primary",
  fullWidth = true,
  style,
  disabled = false,
  leftIcon,
}: AppButtonProps) {
  const { primary, secondary, cta, onSecondary, onCta, danger } = useThemeColors();

  const backgroundColor =
    variant === "primary"
      ? primary
      : variant === "secondary"
      ? secondary
      : variant === "cta"
      ? cta
      : danger;

  const textColor = variant === "secondary" ? onSecondary : onCta;

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
      <View style={styles.content}>
        {leftIcon ? <View style={styles.iconWrap}>{leftIcon}</View> : null}
        <Text style={[styles.label, { color: textColor }]}>{label}</Text>
      </View>
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
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrap: {
    marginRight: 8,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
    includeFontPadding: false,
    textAlignVertical: "center",
  },
});
