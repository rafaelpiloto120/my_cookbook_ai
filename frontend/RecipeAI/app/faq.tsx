import React, { useMemo, useState } from "react";
import {
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";

import { useThemeColors, useTheme } from "../context/ThemeContext";
import { faqCategoryMeta, getFaqItems, type FaqCategoryId } from "../lib/faq";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function FaqScreen() {
  const { t } = useTranslation();
  const { bg, text, card, border, subText } = useThemeColors();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<"all" | FaqCategoryId>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const faqItems = useMemo(() => getFaqItems(t), [t]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    return faqItems.filter((item) => {
      const categoryMatches = selectedCategory === "all" || item.category === selectedCategory;
      if (!categoryMatches) return false;
      if (!normalizedQuery) return true;
      return (
        item.question.toLowerCase().includes(normalizedQuery) ||
        item.answer.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [faqItems, normalizedQuery, selectedCategory]);

  const toggleItem = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedId((current) => (current === id ? null : id));
  };

  return (
    <View style={[styles.screen, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          title: t("profile.faq", { defaultValue: "FAQ" }),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.title, { color: text }]}>
          {t("faq.page_title", { defaultValue: "How can we help?" })}
        </Text>

        <View style={[styles.searchBox, { backgroundColor: card, borderColor: border }]}>
          <MaterialIcons name="search" size={20} color={subText} />
          <TextInput
            style={[styles.searchInput, { color: text }]}
            placeholder={t("faq.search_placeholder", { defaultValue: "Search FAQ..." })}
            placeholderTextColor={subText}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <Pressable hitSlop={8} onPress={() => setQuery("")}>
              <MaterialIcons name="close" size={18} color={subText} />
            </Pressable>
          ) : null}
        </View>

        <View style={styles.categoryList}>
          {faqCategoryMeta.map((category) => {
            const selected = selectedCategory === category.id;
            return (
              <Pressable
                key={category.id}
                onPress={() => {
                  setSelectedCategory(category.id);
                  setExpandedId(null);
                }}
                style={[
                  styles.categoryChip,
                  {
                    backgroundColor: selected ? "#E27D60" : card,
                    borderColor: selected ? "#E27D60" : border,
                  },
                ]}
              >
                <MaterialIcons
                  name={category.icon as any}
                  size={16}
                  color={selected ? "#fff" : subText}
                />
                <Text style={[styles.categoryText, { color: selected ? "#fff" : text }]}>
                  {t(category.labelKey, { defaultValue: category.fallback })}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {filteredItems.length === 0 ? (
          <View style={[styles.emptyState, { backgroundColor: card, borderColor: border }]}>
            <Text style={[styles.emptyText, { color: subText }]}>
              {t("faq.no_results", { defaultValue: "No results found" })}
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {filteredItems.map((item) => {
              const expanded = expandedId === item.id;
              return (
                <View
                  key={item.id}
                  style={[
                    styles.faqCard,
                    {
                      backgroundColor: card,
                      borderColor: border,
                    },
                  ]}
                >
                  <Pressable
                    onPress={() => toggleItem(item.id)}
                    android_ripple={{ color: "#00000010" }}
                    style={styles.questionRow}
                  >
                    <Text style={[styles.questionText, { color: text }]}>{item.question}</Text>
                    <MaterialIcons
                      name={expanded ? "expand-less" : "expand-more"}
                      size={24}
                      color={subText}
                    />
                  </Pressable>
                  {expanded ? (
                    <View style={[styles.answerBlock, { borderTopColor: border }]}>
                      <Text style={[styles.answerText, { color: isDark ? "#d7dce5" : "#5f6978" }]}>
                        {item.answer}
                      </Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    padding: 18,
    paddingBottom: 34,
  },
  title: {
    fontSize: 24,
    fontWeight: "900",
    marginBottom: 14,
  },
  searchBox: {
    borderWidth: 1,
    borderRadius: 12,
    minHeight: 48,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 8,
  },
  categoryList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 14,
  },
  categoryChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  categoryText: {
    fontSize: 13,
    fontWeight: "800",
  },
  list: {
    gap: 10,
  },
  faqCard: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  questionRow: {
    minHeight: 54,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  questionText: {
    flex: 1,
    fontSize: 15,
    fontWeight: "800",
    lineHeight: 21,
  },
  answerBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
  },
  answerText: {
    fontSize: 14,
    lineHeight: 21,
  },
  emptyState: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 16,
  },
  emptyText: {
    fontSize: 14,
    fontStyle: "italic",
  },
});
