export type FaqCategoryId = "getting_started" | "my_day" | "recipes" | "eggs" | "settings";

export type FaqItem = {
  id: string;
  category: FaqCategoryId;
  question: string;
  answer: string;
};

type Translator = (key: string, options?: any) => string;

function question(t: Translator, key: string, defaultValue: string): string {
  return t(key, { defaultValue }).replace(/^[^A-Za-z0-9À-ž¿¡]+/, "");
}

export const faqCategoryMeta: Array<{ id: "all" | FaqCategoryId; icon: string; labelKey: string; fallback: string }> = [
  { id: "all", icon: "apps", labelKey: "faq.category_all", fallback: "All" },
  { id: "getting_started", icon: "info-outline", labelKey: "faq.category_getting_started", fallback: "Getting started" },
  { id: "my_day", icon: "today", labelKey: "faq.category_my_day", fallback: "My Day" },
  { id: "recipes", icon: "restaurant-menu", labelKey: "faq.category_recipes", fallback: "Recipes" },
  { id: "eggs", icon: "card-giftcard", labelKey: "faq.category_eggs", fallback: "Eggs" },
  { id: "settings", icon: "settings", labelKey: "faq.category_settings", fallback: "Settings" },
];

export function getFaqItems(t: Translator): FaqItem[] {
  return [
    {
      id: "faq.what_is_app",
      category: "getting_started",
      question: question(t, "faq.what_is_app", "What is Cook N'Eat AI?"),
      answer: t("faq.what_is_app_answer", {
        defaultValue:
          "Cook N'Eat AI helps you organize recipes, generate ideas with AI, track meals in My Day, and adapt meals to your healthy and happy routine.",
      }),
    },
    {
      id: "faq.do_i_need_account",
      category: "getting_started",
      question: question(t, "faq.do_i_need_account", "Do I need an account to use the app?"),
      answer: t("faq.do_i_need_account_answer", {
        defaultValue:
          "You can use the app as a guest, but creating an account lets you sync recipes, cookbooks, meals, weights, Health & Goals, and preferences across devices.",
      }),
    },
    {
      id: "faq.where_are_recipes_stored",
      category: "getting_started",
      question: question(t, "faq.where_are_recipes_stored", "Where are my recipes stored?"),
      answer: t("faq.where_are_recipes_stored_answer", {
        defaultValue:
          "With an account, your recipes are securely stored in the cloud and synced across devices. As a guest, they stay stored locally on your device.",
      }),
    },
    {
      id: "faq.my_day_what",
      category: "my_day",
      question: question(t, "faq.my_day_what", "What is My Day?"),
      answer: t("faq.my_day_what_answer", {
        defaultValue:
          "My Day is where you log meals, track calories and macros, follow weekly trends, record weight, and compare your day against your Health & Goals.",
      }),
    },
    {
      id: "faq.my_day_logging",
      category: "my_day",
      question: question(t, "faq.my_day_logging", "How can I log meals in My Day?"),
      answer: t("faq.my_day_logging_answer", {
        defaultValue:
          "You can describe a meal, log it with a photo, or add it from a saved recipe. Meal history also lets you add meals to a previous day if you forgot to log them.",
      }),
    },
    {
      id: "faq.health_goals",
      category: "my_day",
      question: question(t, "faq.health_goals", "How are calories and macro goals calculated?"),
      answer: t("faq.health_goals_answer", {
        defaultValue:
          "Health & Goals uses your profile details, goal, pace, and daily plan to suggest calorie and macro targets. You can customize the daily plan at any time.",
      }),
    },
    {
      id: "faq.trends",
      category: "my_day",
      question: question(t, "faq.trends", "How do weekly trends work?"),
      answer: t("faq.trends_answer", {
        defaultValue:
          "Weekly trends use the selected Monday-to-Sunday week. Average intake considers logged days with calories, and days within goal count days where intake was within your daily target.",
      }),
    },
    {
      id: "faq.ai_kitchen_preferences",
      category: "recipes",
      question: question(t, "faq.ai_kitchen_preferences", "How does AI Kitchen use my food preferences?"),
      answer: t("faq.ai_kitchen_preferences_answer", {
        defaultValue:
          "AI Kitchen reads your dietary restrictions and ingredients to avoid from your Profile to suggest better recipes.",
      }),
    },
    {
      id: "faq.ai_kitchen_one_time_changes",
      category: "recipes",
      question: question(t, "faq.ai_kitchen_one_time_changes", "Do changes in AI Kitchen update my Profile?"),
      answer: t("faq.ai_kitchen_one_time_changes_answer", {
        defaultValue:
          "No. Changes made inside AI Kitchen apply only to that specific AI request. Your Profile remains the source of truth for long-term preferences.",
      }),
    },
    {
      id: "faq.ai_unique_recipes",
      category: "recipes",
      question: question(t, "faq.ai_unique_recipes", "Will AI always generate completely unique recipes?"),
      answer: t("faq.ai_unique_recipes_answer", {
        defaultValue:
          "AI generates recipes based on patterns and your inputs. Some recipes may resemble well-known dishes, and you can always edit ingredients or steps after saving.",
      }),
    },
    {
      id: "faq.import_file_app",
      category: "recipes",
      question: question(t, "faq.import_file_app", "How does Import from File / App work?"),
      answer: t("faq.import_file_app_answer", {
        defaultValue:
          "You can import recipes from supported backup or export files, including My Recipe Box (.rtk), Paprika (.paprikarecipes), supported recipe ZIP exports, HTML, and CSV. If a file is invalid, no recipes are imported.",
      }),
    },
    {
      id: "faq.instagram_reel_import",
      category: "recipes",
      question: t("faq.instagram_reel_import_v2", {
        defaultValue: "How does Instagram Reel import work?",
      }),
      answer: t("faq.instagram_reel_import_answer_v2", {
        defaultValue:
          "Paste a public Instagram Reel link into Import from URL. We analyze the Reel and create a recipe draft for you to review before saving. Eggs are only deducted when a valid draft is created successfully.",
      }),
    },
    {
      id: "faq.cookies_what",
      category: "eggs",
      question: question(t, "faq.cookies_what", "What are Eggs and what are they used for?"),
      answer: t("faq.cookies_what_answer", {
        defaultValue:
          "Eggs are credits used for premium actions in Cook N'Eat AI, such as generating AI recipes, estimating nutrition, logging meals with photos, and importing recipes from Instagram Reels.",
      }),
    },
    {
      id: "faq.cookies_charged",
      category: "eggs",
      question: t("faq.cookies_charged_v2", {
        defaultValue: "When do Eggs get deducted and how can I get more?",
      }),
      answer: t("faq.cookies_charged_answer_v2", {
        defaultValue:
          "During your free premium actions, the app stays mostly free of pricing prompts. After that, premium AI features may use Eggs. Eggs are only deducted after a successful action, and you can buy or earn more in the Eggs page.",
      }),
    },
    {
      id: "faq.free_or_paid",
      category: "eggs",
      question: question(t, "faq.free_or_paid", "Is Cook N'Eat AI free?"),
      answer: t("faq.free_or_paid_answer", {
        defaultValue:
          "Yes, the core experience is free. Some premium actions use Eggs, and we always show the cost before charging.",
      }),
    },
    {
      id: "faq.measurement_system",
      category: "settings",
      question: question(t, "faq.measurement_system", "Which measurement systems are supported?"),
      answer: t("faq.measurement_system_answer", {
        defaultValue:
          "You can choose between US (cups, ounces, pounds) and Metric (grams, milliliters, kilograms).",
      }),
    },
    {
      id: "faq.language_change",
      category: "settings",
      question: question(t, "faq.language_change", "How do I change the app language?"),
      answer: t("faq.language_change_answer", {
        defaultValue: "Go to Profile → General → Language and choose a new language.",
      }),
    },
    {
      id: "faq.dark_mode",
      category: "settings",
      question: question(t, "faq.dark_mode", "How do I enable dark mode?"),
      answer: t("faq.dark_mode_answer", {
        defaultValue: "Go to Profile → General and toggle Dark Mode. The app will switch themes immediately.",
      }),
    },
    {
      id: "faq.offline",
      category: "settings",
      question: question(t, "faq.offline", "Does the app work offline?"),
      answer: t("faq.offline_answer", {
        defaultValue:
          "Saved recipes work offline. AI features, image uploads, imports, purchases, and sync actions require an internet connection.",
      }),
    },
    {
      id: "faq.privacy",
      category: "settings",
      question: question(t, "faq.privacy", "Are my photos and recipes private?"),
      answer: t("faq.privacy_answer", {
        defaultValue:
          "Yes. If you use the app as a guest, your data stays on this device. If you are signed in, your recipes and photos are linked to your account for sync. We do not make your recipes public or searchable by other users.",
      }),
    },
    {
      id: "faq.report_bug",
      category: "settings",
      question: question(t, "faq.report_bug", "How can I report a bug or suggest a feature?"),
      answer: t("faq.report_bug_answer", {
        defaultValue: "Use the Contact Support option inside the Help & Support section.",
      }),
    },
  ];
}
