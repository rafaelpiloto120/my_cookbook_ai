import type { EconomyLedgerEntry } from "./client";

export function formatEconomyActivityDate(
  value: string | null | undefined,
  locale?: string
) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(locale || undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getEconomyActivityLabel(
  entry: EconomyLedgerEntry,
  t: (key: string, options?: any) => string
) {
  if (entry.reason === "signup_bonus") {
    return t("economy.history_signup_bonus", {
      defaultValue: "Account creation bonus",
    });
  }
  if (entry.reason === "starting_cookies" || entry.reason === "initial_grant") {
    return t("economy.history_initial_grant", {
      defaultValue: "Starting Eggs",
    });
  }
  if (entry.reason === "reward_profile_health_goals") {
    return t("economy.history_profile_health", {
      defaultValue: "Completed profile and Health & Goals",
    });
  }
  if (entry.reason === "reward_first_recipe_saved") {
    return t("economy.history_first_recipe", {
      defaultValue: "First recipe saved",
    });
  }
  if (entry.reason === "reward_recipes_10") {
    return t("economy.history_recipes_10", {
      defaultValue: "Saved 10 recipes",
    });
  }
  if (entry.reason === "reward_recipes_25") {
    return t("economy.history_recipes_25", {
      defaultValue: "Saved 25 recipes",
    });
  }
  if (entry.reason === "reward_first_meal_logged") {
    return t("economy.history_first_meal", {
      defaultValue: "First meal logged",
    });
  }
  if (entry.reason === "reward_meals_10") {
    return t("economy.history_meals_10", {
      defaultValue: "Logged 10 meals",
    });
  }
  if (entry.reason === "reward_meals_25") {
    return t("economy.history_meals_25", {
      defaultValue: "Logged 25 meals",
    });
  }
  if (entry.reason === "reward_first_cookbook_created") {
    return t("economy.history_first_cookbook", {
      defaultValue: "First cookbook created",
    });
  }
  if (entry.reason === "reward_first_instagram_reel_import") {
    return t("economy.history_first_instagram_reel", {
      defaultValue: "First Instagram Reel recipe imported",
    });
  }
  if (entry.reason === "purchase_verified" || entry.reason === "cookie_purchase") {
    return t("economy.history_purchase", {
      defaultValue: "Egg purchase",
    });
  }

  const spendKey = String(entry.actionKey || entry.reason || "").trim();
  if (spendKey === "ai_recipe") {
    return t("economy.history_ai_recipe", {
      defaultValue: "AI Kitchen full recipe opened",
    });
  }
  if (spendKey === "recipe_nutrition_estimate") {
    return t("economy.history_recipe_estimate", {
      defaultValue: "Recipe nutrition estimated",
    });
  }
  if (spendKey === "meal_photo_log") {
    return t("economy.history_meal_photo", {
      defaultValue: "Meal logged by photo",
    });
  }
  if (spendKey === "import_instagram_reel") {
    return t("economy.history_instagram_import", {
      defaultValue: "Instagram Reel recipe imported",
    });
  }

  if (entry.kind === "spend" || (typeof entry.delta === "number" && entry.delta < 0)) {
    return t("economy.history_spend", {
      defaultValue: "Premium action",
    });
  }

  return entry.reason || entry.actionKey || t("economy.history_default", {
    defaultValue: "Egg update",
  });
}
