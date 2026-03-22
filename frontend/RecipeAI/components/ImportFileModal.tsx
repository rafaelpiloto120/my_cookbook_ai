import React from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";

type Props = {
  visible: boolean;
  onClose: () => void;
  onImport: () => void;
  onHelpPress: () => void;
  loading?: boolean;
  loadingText?: string | null;
  error?: string | null;
  cardColor: string;
  textColor: string;
  subTextColor: string;
  borderColor: string;
};

export default function ImportFileModal({
  visible,
  onClose,
  onImport,
  onHelpPress,
  loading = false,
  loadingText,
  error,
  cardColor,
  textColor,
  subTextColor,
  borderColor,
}: Props) {
  const { t } = useTranslation();
  const formats = [
    t("recipes.file_import_format_recipe_box", {
      defaultValue: "My Recipe Box (.rtk)",
    }),
    t("recipes.file_import_format_paprika", {
      defaultValue: "Paprika (.paprikarecipes)",
    }),
    t("recipes.file_import_format_backup_zip", {
      defaultValue: "Recipe Backup (.zip)",
    }),
    t("recipes.file_import_format_html", {
      defaultValue: "HTML Export (.html, .htm)",
    }),
    t("recipes.file_import_format_csv", {
      defaultValue: "CSV (.csv)",
    }),
  ];

  return (
    <Modal visible={visible} transparent animationType="fade">
      <Pressable style={styles.overlay} onPress={loading ? undefined : onClose}>
        <Pressable
          style={[styles.content, { backgroundColor: cardColor, borderColor }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: textColor }]}>
              {t("recipes.import_from_file", { defaultValue: "Import from File / App" })}
            </Text>
            <TouchableOpacity onPress={onClose} disabled={loading}>
              <MaterialIcons name="close" size={24} color={textColor} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.body, { color: subTextColor }]}>
            {t("recipes.file_import_description", {
              defaultValue:
                "Import recipes from a supported backup or export file. Choose one file from your device. If the file is invalid, no recipes will be imported.",
            })}
          </Text>

          <View style={styles.formatList}>
            {formats.map((format) => (
              <View key={format} style={styles.formatRow}>
                <Text style={styles.bullet}>•</Text>
                <Text style={[styles.formatText, { color: textColor }]}>{format}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity onPress={onHelpPress} disabled={loading}>
            <Text style={[styles.helpLink, { color: "#E27D60" }]}>
              {t("recipes.file_import_help_link", {
                defaultValue: "How to export from supported apps",
              })}
            </Text>
          </TouchableOpacity>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={onImport}
            disabled={loading}
          >
            <Text style={styles.buttonText}>
              {loading
                ? loadingText ||
                  t("recipes.importing", { defaultValue: "Importing..." })
                : t("recipes.import_button", { defaultValue: "Import" })}
            </Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  content: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    flex: 1,
    marginRight: 12,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  formatList: {
    marginBottom: 12,
  },
  formatRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 4,
  },
  bullet: {
    marginRight: 8,
    fontSize: 16,
    color: "#E27D60",
    lineHeight: 20,
  },
  formatText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  helpLink: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 12,
  },
  error: {
    color: "#E27D60",
    fontSize: 13,
    marginBottom: 12,
  },
  button: {
    backgroundColor: "#E27D60",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
});
