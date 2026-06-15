import { Alert } from "react-native";

type TranslationFn = (key: string, options?: any) => string;

export function maybeShowEggsUnlockedPrompt(
  payload: any,
  t: TranslationFn,
  onManageEggs?: () => void
) {
  if (!payload || payload.unlockedEggs !== true) return false;

  const unlockBonus =
    typeof payload.unlockBonus === "number" && Number.isFinite(payload.unlockBonus)
      ? Math.max(0, Math.floor(payload.unlockBonus))
      : 10;

  Alert.alert(
    t("economy.eggs_unlocked_title", { defaultValue: "You've unlocked Eggs" }),
    t("economy.eggs_unlocked_body", {
      count: unlockBonus,
      defaultValue:
        "Your 25 free AI actions are complete, so Eggs are now available for selected premium AI features. Most of Cook N'Eat stays free, and we added {{count}} Eggs so you can keep exploring.",
    }),
    [
      {
        text: t("common.continue", { defaultValue: "Continue" }),
        style: "cancel",
      },
      ...(onManageEggs
        ? [
            {
              text: t("economy.manage_cookies_title", { defaultValue: "Manage Eggs" }),
              onPress: onManageEggs,
            },
          ]
        : []),
    ]
  );

  return true;
}
