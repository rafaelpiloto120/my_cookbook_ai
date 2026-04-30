import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AppCard from "../components/AppCard";
import { useThemeColors } from "../context/ThemeContext";
import { useTranslation } from "react-i18next";

const CSV_EXAMPLE = `title,ingredients,steps,servings,cookingTime
"Tomato Toast","2 slices bread
1 tomato
1 tbsp olive oil","Toast the bread.
Slice the tomato.
Top toast with tomato and olive oil.",1,10`;

const HTML_EXAMPLE = `<h1>Recipe title</h1>
<ul>
  <li>1 tomato</li>
  <li>2 slices bread</li>
</ul>
<ol>
  <li>Toast the bread.</li>
  <li>Add the tomato.</li>
</ol>`;

type StepListProps = {
  steps: string[];
  textColor: string;
  subTextColor: string;
  noteText: string;
};

function StepList({ steps, textColor, subTextColor, noteText }: StepListProps) {
  return (
    <View style={styles.stepList}>
      {steps.map((step, index) => (
        <View key={`${index}-${step}`} style={styles.stepRow}>
          <View style={styles.stepNumber}>
            <Text style={styles.stepNumberText}>{index + 1}</Text>
          </View>
          <Text style={[styles.stepText, { color: textColor }]}>{step}</Text>
        </View>
      ))}
      <Text style={[styles.note, { color: subTextColor }]}>{noteText}</Text>
    </View>
  );
}

export default function ImportHelpScreen() {
  const { bg, text, subText } = useThemeColors();
  const { t } = useTranslation();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }} edges={["left", "right", "bottom"]}>
      <Stack.Screen
        options={{
          title: t("recipes.import_help_title", { defaultValue: "Import Help" }),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
        }}
      />

      <ScrollView contentContainerStyle={styles.container}>
        <Text style={[styles.lead, { color: subText }]}>
          {t("recipes.import_help_intro", {
            defaultValue:
              "Use this guide to export recipes from supported apps and file types, then import the file into Cook N'Eat AI.",
          })}
        </Text>

        <AppCard>
          <Text style={[styles.title, { color: text }]}>
            {t("recipes.file_import_format_recipe_box", {
              defaultValue: "My Recipe Box (.rtk)",
            })}
          </Text>
          <StepList
            textColor={text}
            subTextColor={subText}
            noteText={t("recipes.import_help_step_note", {
              defaultValue:
                "Import one file at a time. If the file is invalid, no recipes will be imported.",
            })}
            steps={[
              t("recipes.import_help_recipe_box_step_1", {
                defaultValue: "Open your application The Recipe Box.",
              }),
              t("recipes.import_help_recipe_box_step_2", {
                defaultValue: "Open the Sync area.",
              }),
              t("recipes.import_help_recipe_box_step_3", {
                defaultValue: 'Find the Backup section and press "Export your backup (.rtk)".',
              }),
              t("recipes.import_help_recipe_box_step_4", {
                defaultValue: "Save the exported file to your device or cloud storage.",
              }),
              t("recipes.import_help_recipe_box_step_5", {
                defaultValue:
                  "In Cook N'Eat AI, open Import from File / App and choose the exported .rtk file.",
              }),
            ]}
          />
        </AppCard>

        <AppCard>
          <Text style={[styles.title, { color: text }]}>
            {t("recipes.file_import_format_paprika", {
              defaultValue: "Paprika (.paprikarecipes)",
            })}
          </Text>
          <StepList
            textColor={text}
            subTextColor={subText}
            noteText={t("recipes.import_help_step_note", {
              defaultValue:
                "Import one file at a time. If the file is invalid, no recipes will be imported.",
            })}
            steps={[
              t("recipes.import_help_paprika_step_1", {
                defaultValue: "Open your application Paprika.",
              }),
              t("recipes.import_help_paprika_step_2", {
                defaultValue: "Open the Settings area.",
              }),
              t("recipes.import_help_paprika_step_3", {
                defaultValue: 'Find the Backup & Sync section and press "Export Recipes".',
              }),
              t("recipes.import_help_paprika_step_4", {
                defaultValue: 'Keep the option "Unicode names" active and press "Export".',
              }),
              t("recipes.import_help_paprika_step_5", {
                defaultValue:
                  "Save the exported .paprikarecipes file and then choose it in Cook N'Eat AI.",
              }),
            ]}
          />
        </AppCard>

        <AppCard>
          <Text style={[styles.title, { color: text }]}>
            {t("recipes.file_import_format_backup_zip", {
              defaultValue: "Recipe Backup (.zip)",
            })}
          </Text>
          <Text style={[styles.body, { color: text }]}>
            {t("recipes.import_help_zip_body", {
              defaultValue:
                "Supported ZIP files must be recipe export archives, not generic ZIP files. If you exported a recipe app backup as a ZIP, choose that file directly.",
            })}
          </Text>
          <Text style={[styles.note, { color: subText }]}>
            {t("recipes.import_help_zip_note", {
              defaultValue:
                "If the ZIP file is not a recognized recipe export format, import will fail without saving any recipes.",
            })}
          </Text>
        </AppCard>

        <AppCard>
          <Text style={[styles.title, { color: text }]}>
            {t("recipes.file_import_format_csv", {
              defaultValue: "CSV (.csv)",
            })}
          </Text>
          <Text style={[styles.body, { color: text }]}>
            {t("recipes.import_help_csv_body_1", {
              defaultValue:
                "CSV files should include at least these columns: title, ingredients, and steps.",
            })}
          </Text>
          <Text style={[styles.body, { color: text }]}>
            {t("recipes.import_help_csv_body_2", {
              defaultValue:
                "Optional columns: servings, cookingTime, difficulty, cost, tags.",
            })}
          </Text>
          <View style={styles.codeBlock}>
            <Text style={styles.codeText}>{CSV_EXAMPLE}</Text>
          </View>
        </AppCard>

        <AppCard>
          <Text style={[styles.title, { color: text }]}>
            {t("recipes.file_import_format_html", {
              defaultValue: "HTML Export (.html, .htm)",
            })}
          </Text>
          <Text style={[styles.body, { color: text }]}>
            {t("recipes.import_help_html_body", {
              defaultValue:
                "HTML recipe exports work best when they include a clear title, ingredient list, and numbered steps. Standard recipe pages with schema.org recipe markup are also supported.",
            })}
          </Text>
          <View style={styles.codeBlock}>
            <Text style={styles.codeText}>{HTML_EXAMPLE}</Text>
          </View>
        </AppCard>

        <AppCard>
          <Text style={[styles.title, { color: text }]}>
            {t("recipes.import_help_tips_title", {
              defaultValue: "Helpful Tips",
            })}
          </Text>
          <View style={styles.tipList}>
            <Text style={[styles.tip, { color: text }]}>
              •{" "}
              {t("recipes.import_help_tip_1", {
                defaultValue: "Import one file at a time.",
              })}
            </Text>
            <Text style={[styles.tip, { color: text }]}>
              •{" "}
              {t("recipes.import_help_tip_2", {
                defaultValue: "Keep backup filenames and extensions unchanged whenever possible.",
              })}
            </Text>
            <Text style={[styles.tip, { color: text }]}>
              •{" "}
              {t("recipes.import_help_tip_3", {
                defaultValue:
                  "If a cloud storage provider gives an error, download the file locally first and try again.",
              })}
            </Text>
            <Text style={[styles.tip, { color: text }]}>
              •{" "}
              {t("recipes.import_help_tip_4", {
                defaultValue: "If import fails, no recipes are saved, so you can safely try again.",
              })}
            </Text>
          </View>
        </AppCard>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 28,
  },
  lead: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 10,
  },
  body: {
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 8,
  },
  stepList: {
    gap: 10,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  stepNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#E27D60",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    marginTop: 1,
  },
  stepNumberText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  stepText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 21,
  },
  note: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 2,
  },
  codeBlock: {
    backgroundColor: "#17212f",
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  codeText: {
    color: "#f5f5f5",
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 18,
  },
  mono: {
    fontFamily: "monospace",
  },
  tipList: {
    gap: 8,
  },
  tip: {
    fontSize: 14,
    lineHeight: 21,
  },
});
