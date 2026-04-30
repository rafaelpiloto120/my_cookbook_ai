import React from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";

type EggIconProps = {
  size?: number;
  variant?: "color" | "mono";
  tintColor?: string;
  style?: StyleProp<ImageStyle>;
};

const colorEgg = require("../assets/images/economy/egg-color-small.png");
const monoEgg = require("../assets/images/economy/egg-mono-small.png");

export default function EggIcon({
  size = 20,
  variant = "color",
  tintColor,
  style,
}: EggIconProps) {
  return (
    <Image
      source={variant === "mono" ? monoEgg : colorEgg}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
      style={[
        {
          width: size,
          height: size,
          tintColor: variant === "mono" ? tintColor : undefined,
        },
        style,
      ]}
    />
  );
}
