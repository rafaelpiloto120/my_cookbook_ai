import React from "react";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";

import { useThemeColors } from "../context/ThemeContext";

type MaterialIconName = keyof typeof MaterialIcons.glyphMap;

type NewRecipeOptionsModalProps = {
  visible: boolean;
  onClose: () => void;
  onManualRecipe: () => void;
  onImportUrl: () => void;
  onImportFile: () => void;
};

export default function NewRecipeOptionsModal({
  visible,
  onClose,
  onManualRecipe,
  onImportUrl,
  onImportFile,
}: NewRecipeOptionsModalProps) {
  const { t } = useTranslation();
  const { text, subText, card, border, cta, secondary, isDark, modalBackdrop } = useThemeColors();
  const inlineAccentColor = isDark ? secondary : cta;

  const options = [
    {
      key: "manual",
      icon: "edit-note" as MaterialIconName,
      title: t("recipes.manual_recipe"),
      subtitle: t("recipes.manual_recipe_sub"),
      onPress: onManualRecipe,
    },
    {
      key: "url",
      icon: "link" as MaterialIconName,
      title: t("recipes.import_from_url"),
      subtitle: t("recipes.import_desc"),
      onPress: onImportUrl,
    },
    {
      key: "file",
      icon: "folder-open" as MaterialIconName,
      title: t("recipes.import_from_file"),
      subtitle: t("recipes.import_from_file_sub"),
      onPress: onImportFile,
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.overlay, { backgroundColor: modalBackdrop }]} onPress={onClose}>
        <View
          style={[styles.card, { backgroundColor: card, borderColor: border }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: text }]}>{t("recipes.new_recipe")}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} activeOpacity={0.8}>
              <MaterialIcons name="close" size={24} color={inlineAccentColor} />
            </TouchableOpacity>
          </View>
          <View style={styles.optionsWrap}>
            {options.map((option, index) => (
              <TouchableOpacity
                key={option.key}
                style={[
                  styles.optionRow,
                  { borderColor: index < options.length - 1 ? border : "transparent" },
                ]}
                onPress={option.onPress}
                activeOpacity={0.8}
              >
                <View style={[styles.optionIconBox, { backgroundColor: `${inlineAccentColor}18` }]}>
                  <MaterialIcons name={option.icon} size={21} color={inlineAccentColor} />
                </View>
                <View style={styles.optionCopy}>
                  <Text style={[styles.optionTitle, { color: text }]}>{option.title}</Text>
                  <Text style={[styles.optionSubtitle, { color: subText }]}>{option.subtitle}</Text>
                </View>
                <MaterialIcons name="chevron-right" size={24} color={subText} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  card: {
    width: 320,
    maxWidth: "100%",
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  header: {
    width: "100%",
    padding: 20,
    paddingBottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    flex: 1,
    paddingRight: 12,
    fontSize: 18,
    fontWeight: "bold",
  },
  optionsWrap: {
    paddingHorizontal: 12,
    paddingBottom: 16,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: "transparent",
  },
  optionIconBox: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  optionCopy: {
    flex: 1,
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: "600",
  },
  optionSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
});
