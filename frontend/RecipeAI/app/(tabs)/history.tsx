import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Modal,
  Image,
  Alert,
  NativeSyntheticEvent,
  NativeScrollEvent,
  ScrollView,
  TouchableWithoutFeedback,
} from "react-native";
import { ActivityIndicator } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "@react-navigation/native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import { useThemeColors } from "../../context/ThemeContext";
import AppButton from "../../components/AppButton";
import { Ionicons } from "@expo/vector-icons";
import AppCard from "../../components/AppCard";

import { useTranslation } from "react-i18next";

const defaultImage = require("../../assets/default_recipe.png");

interface Recipe {
  id: string;
  title: string;
  cookingTime: number;
  difficulty: "Easy" | "Moderate" | "Challenging";
  servings: number;
  cost: "Cheap" | "Medium" | "Expensive";
  ingredients: string[];
  steps: string[];
  tags: string[];
  createdAt: string;
  image?: string;
  imageUrl?: string;
  cookbooks?: (string | { id: string; name: string })[];
}

interface Cookbook {
  id: string;
  name: string;
  image?: string;
  imageUrl?: string;
}

const defaultCookbookImagesById: Record<string, string> = {
  "cb-favorites": "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600",
  "cb-breakfast": "https://images.unsplash.com/photo-1504754524776-8f4f37790ca0?w=600",
  "cb-lunch": "https://images.unsplash.com/photo-1525755662778-989d0524087e?w=600",
  "cb-snacks": "https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=600",
  "cb-dinner": "https://images.unsplash.com/photo-1543353071-873f17a7a088?w=600",
};

// These will be assigned after t is available

let difficultyMap: Record<string, string>;
let costMap: Record<string, string>;

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL;

async function trackAnalyticsEvent(
  eventType: string,
  payload: Record<string, any> = {}
) {
  if (!API_BASE_URL) {
    if (__DEV__) {
      console.warn(
        "[Analytics] EXPO_PUBLIC_API_URL is not set, cannot send event:",
        eventType
      );
    }
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/analytics/track/simple`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventType,
        metadata: {
          sourceScreen: "history",
          ...payload,
        },
      }),
    });
    if (!res.ok && __DEV__) {
      console.warn(
        "[Analytics] Event request failed",
        eventType,
        "status:",
        res.status
      );
    }
  } catch (err) {
    if (__DEV__) {
      console.warn("[Analytics] Failed to send event", eventType, err);
    }
  }
}

export default function History() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [cookbooks, setCookbooks] = useState<Cookbook[]>([]);
  const [activeTab, setActiveTab] = useState<"all" | "cookbooks">(
    () => (params?.tab === "cookbooks" ? "cookbooks" : "all")
  );
  const [search, setSearch] = useState("");

  // filter modal
  const [filterVisible, setFilterVisible] = useState(false);
  const [selectedDifficulties, setSelectedDifficulties] = useState<string[]>([]);
  const [selectedCosts, setSelectedCosts] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // new cookbook modal
  const [newCookbookVisible, setNewCookbookVisible] = useState(false);
  const [newCookbookName, setNewCookbookName] = useState("");

  // new recipe modal (FAB)
  const [newRecipeVisible, setNewRecipeVisible] = useState(false);

  // import from URL modal
  const [importUrlVisible, setImportUrlVisible] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [successVisible, setSuccessVisible] = useState(false);
  const [importedRecipe, setImportedRecipe] = useState<Recipe | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const router = useRouter();
  const { bg, text, subText, card, border } = useThemeColors();
  const { t } = useTranslation();
  // Use translations for difficulty and cost maps (matching i18n.ts structure)
  difficultyMap = {
    Easy: t("difficulty.easy"),
    Moderate: t("difficulty.moderate"),
    Challenging: t("difficulty.challenging"),
  };
  costMap = {
    Cheap: t("cost.cheap"),
    Medium: t("cost.medium"),
    Expensive: t("cost.expensive"),
  };
  // --- Scroll position persistence
  const listRef = useRef<FlatList>(null);
  // Key for AsyncStorage for scroll position
  const RECIPES_SCROLL_Y_KEY = "recipesScrollY";

  // // Clear "recipes" key in AsyncStorage once
  // useEffect(() => {
  //   const clearRecipes = async () => {
  //     try {
  //       await AsyncStorage.removeItem("recipes");
  //       console.log("✅ Recipes cleared from AsyncStorage");
  //     } catch (err) {
  //       console.error("❌ Error clearing recipes:", err);
  //     }
  //   };
  //   clearRecipes();
  // }, []);

  // Handler for saving scroll position
  const handleScroll = async (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y;
    try {
      await AsyncStorage.setItem(RECIPES_SCROLL_Y_KEY, JSON.stringify(y));
    } catch (err) {
      // ignore
    }
  };


  // --- Load recipes
  const loadRecipes = useCallback(async () => {
    try {
      const stored = await AsyncStorage.getItem("recipes");
      let parsed = stored ? JSON.parse(stored) : [];
      if (Array.isArray(parsed)) {
        parsed = parsed.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        // Normalize each recipe's image property, also supporting legacy keys like imageUrl
        parsed = parsed.map((recipe: any) => {
          // Prefer canonical "image", but fall back to "imageUrl" if needed
          let image = recipe.image;
          if ((!image || typeof image !== "string") && typeof recipe.imageUrl === "string") {
            image = recipe.imageUrl;
          }

          // Only keep image if it's a non-empty string; we don't enforce URL shape here
          if (typeof image !== "string" || !image.trim()) {
            image = null;
          }

          return { ...recipe, image };
        });
      }
      setRecipes(parsed);
    } catch (err) {
      console.error("Error loading recipes:", err);
    }
  }, []);

  // --- Load cookbooks
  const loadCookbooks = useCallback(async () => {
    try {
      const stored = await AsyncStorage.getItem("cookbooks");
      let parsed: Cookbook[] | null = null;

      if (stored) {
        try {
          parsed = JSON.parse(stored);
        } catch {
          console.warn("⚠️ Corrupted cookbooks in storage, resetting.");
        }
      }

      if (Array.isArray(parsed)) {
        const normalized = parsed.map((cb: any) => ({
          ...cb,
          image: cb.image || cb.imageUrl || undefined,
        }));
        setCookbooks(normalized);
      } else {
        setCookbooks([]);
      }
    } catch (err) {
      console.error("Error loading cookbooks:", err);
      setCookbooks([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      let timeout: NodeJS.Timeout | null = null;
      // Load recipes and cookbooks, then restore scroll position
      const restoreScroll = async () => {
        await loadRecipes();
        await loadCookbooks();
        // Wait for FlatList to render
        timeout = setTimeout(async () => {
          try {
            const yStr = await AsyncStorage.getItem(RECIPES_SCROLL_Y_KEY);
            const y = yStr ? JSON.parse(yStr) : 0;
            if (listRef.current && y && isActive) {
              // @ts-ignore
              listRef.current.scrollToOffset({ offset: y, animated: false });
            }
          } catch (err) {
            // ignore
          }
        }, 80); // delay to ensure FlatList is rendered
      };
      restoreScroll();
      return () => {
        isActive = false;
        if (timeout) clearTimeout(timeout);
      };
    }, [loadRecipes, loadCookbooks])
  );

  // --- Delete modal state
  const [deleteTarget, setDeleteTarget] = useState<{id: string, type: "recipe" | "cookbook"} | null>(null);

  // --- Create cookbook
  const createCookbook = async () => {
    if (!newCookbookName.trim()) {
      Alert.alert(t("common.validation"), t("recipes.validation_name"));
      return;
    }

    const newBook: Cookbook = {
      id: `${Date.now()}`,
      name: newCookbookName.trim(),
      image: undefined,
    };

    const safeCookbooks = Array.isArray(cookbooks) ? cookbooks : [];
    const updated = [...safeCookbooks, newBook];

    setCookbooks(updated);
    await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));
    trackAnalyticsEvent("cookbook_created", {
      cookbookId: newBook.id,
      cookbookName: newBook.name,
    });

    setNewCookbookName("");
    setNewCookbookVisible(false);
  };

  // --- Delete recipe
  const deleteRecipe = (id: string) => {
    setDeleteTarget({id, type: "recipe"});
  };

  // --- Delete cookbook
  const deleteCookbook = (id: string) => {
    setDeleteTarget({id, type: "cookbook"});
  };

  // --- Confirm delete
  const confirmDelete = async () => {
    if (!deleteTarget) return;

    if (deleteTarget.type === "recipe") {
      // capture the recipe before removing it, so we can log useful metadata
      const targetRecipe = recipes.find((r) => r.id === deleteTarget.id) || null;

      let updated = recipes.filter((r) => r.id !== deleteTarget.id);
      updated = updated.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setRecipes(updated);
      await AsyncStorage.setItem("recipes", JSON.stringify(updated));

      trackAnalyticsEvent("manual_recipe_deleted", {
        recipeId: deleteTarget.id,
        recipeTitle: targetRecipe?.title ?? null,
        // how many recipes remain after deletion
        remainingRecipes: updated.length,
      });
    } else {
      // capture the cookbook before removing it, so we can log useful metadata
      const targetCookbook =
        cookbooks.find((c) => c.id === deleteTarget.id) || null;

      const updated = cookbooks.filter((c) => c.id !== deleteTarget.id);
      setCookbooks(updated);
      await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));

      trackAnalyticsEvent("cookbook_deleted", {
        cookbookId: deleteTarget.id,
        cookbookName: targetCookbook?.name ?? null,
        remainingCookbooks: updated.length,
      });
    }

    setDeleteTarget(null);
  };

  // --- Normalize tags
  const getNormalizedTags = (tags: string[] = []) =>
    tags
      .flatMap((t) => t.split(","))
      .map((t) => t.trim())
      .filter(Boolean);

  // --- All tags (for filters)
  const allTags = Array.from(
    new Set(recipes.flatMap((r) => getNormalizedTags(r.tags)))
  );

  // --- Filtered recipes
  const filteredRecipes = recipes.filter((r) => {
    const matchesSearch = r.title.toLowerCase().includes(search.toLowerCase());
    const matchesDiff =
      selectedDifficulties.length === 0 ||
      selectedDifficulties.includes(r.difficulty);
    const matchesCost =
      selectedCosts.length === 0 || selectedCosts.includes(r.cost);

    const normalizedTags = getNormalizedTags(r.tags).map((t) =>
      t.toLowerCase()
    );
    const matchesTags =
      selectedTags.length === 0 ||
      normalizedTags.some((t) =>
        selectedTags.map((ft) => ft.toLowerCase()).includes(t)
      );

    return matchesSearch && matchesDiff && matchesCost && matchesTags;
  });

  // --- Toggle filter chip
  const toggleFilter = (
    arr: string[],
    value: string,
    setFn: (v: string[]) => void
  ) => {
    if (arr.includes(value)) {
      setFn(arr.filter((v) => v !== value));
    } else {
      setFn([...arr, value]);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          title: t("recipes.my_recipes"),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
        }}
      />

      {/* Tabs */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[
            styles.tab,
            { backgroundColor: activeTab === "all" ? "#F5F5F5" : "#ddd" },
          ]}
          onPress={() => setActiveTab("all")}
        >
          <Text>{t("recipes.all_recipes")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.tab,
            { backgroundColor: activeTab === "cookbooks" ? "#F5F5F5" : "#ddd" },
          ]}
          onPress={() => setActiveTab("cookbooks")}
        >
          <Text>{t("recipes.cookbooks")}</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {activeTab === "all" ? (
        <>
          {/* Search + filter */}
          <View style={styles.searchRow}>
            <MaterialIcons
              name="search"
              size={22}
              color={subText}
              style={{ marginRight: 6 }}
            />
            <TextInput
              style={{ flex: 1, color: text }}
              placeholder={t("recipes.search_placeholder")}
              placeholderTextColor={subText}
              value={search}
              onChangeText={setSearch}
            />
            <TouchableOpacity onPress={() => setFilterVisible(true)}>
              <MaterialIcons name="filter-list" size={24} color="#293a53" />
            </TouchableOpacity>
          </View>

          <FlatList
            ref={listRef}
            data={filteredRecipes}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() =>
                  router.push({
                    pathname: `/recipe/${item.id}`,
                    params: { from: "history" },
                  })
                }
              >
                <AppCard style={styles.recipeCard}>
                  <Image
                    source={item.image ? { uri: item.image } : defaultImage}
                    style={styles.recipeImage}
                  />
                  <View style={{ flex: 1 }}>
                    <View style={styles.cardHeader}>
                      <Text style={[styles.cardTitle, { color: text }]}>
                        {item.title}
                      </Text>
                      <TouchableOpacity onPress={() => deleteRecipe(item.id)}>
                        <MaterialIcons
                          name="delete-outline"
                          size={22}
                          color={subText}
                        />
                      </TouchableOpacity>
                    </View>
                    <Text style={{ color: subText }}>
                      ⏱ {item.cookingTime} min • {difficultyMap[item.difficulty] || item.difficulty} • {costMap[item.cost] || item.cost}
                    </Text>
                    <View style={styles.tagRow}>
                      {getNormalizedTags(item.tags).slice(0, 3).map((t, i) => (
                        <View key={i} style={styles.tagChip}>
                          <Text style={styles.tagText}>{t}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                </AppCard>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <View style={{ alignItems: "center", marginTop: 40 }}>
                <Text style={{ color: subText, marginBottom: 8 }}>
                  {t("recipes.no_recipes")}
                </Text>
                <TouchableOpacity onPress={() => router.push("/(tabs)/")}>
                  <Text style={{ color: "#E27D60", fontWeight: "600" }}>
                    {t("recipes.create_in_ai_kitchen")}
                  </Text>
                </TouchableOpacity>
              </View>
            }
            onScroll={handleScroll}
            scrollEventThrottle={16}
          />
        </>
      ) : (
        <>
          <FlatList
            data={cookbooks}
            keyExtractor={(item) => item.id}
            numColumns={2}
            contentContainerStyle={{ paddingBottom: 10 }}
            renderItem={({ item }) => {
              const firstRecipe = recipes.find(
                (r) =>
                  Array.isArray(r.cookbooks) &&
                  r.cookbooks.some((cb) =>
                    typeof cb === "string" ? cb === item.id : cb.id === item.id
                  )
              );
              const img =
                item.image ||
                (item as any).imageUrl ||
                defaultCookbookImagesById[item.id] ||
                firstRecipe?.image ||
                Image.resolveAssetSource(defaultImage).uri;
              return (
                <TouchableOpacity
                  onPress={() => router.push(`/cookbook/${item.id}`)}
                  style={{ flex: 1 }}
                >
                  <AppCard style={styles.cookbookCard}>
                    <Image source={{ uri: img }} style={styles.cookbookImage} resizeMode="cover"/>
                    <View style={styles.cookbookOverlay}>
                      <Text style={styles.cookbookTitle}>{item.name}</Text>
                      <TouchableOpacity onPress={() => deleteCookbook(item.id)}>
                        <MaterialIcons
                          name="delete-outline"
                          size={22}
                          color="#fff"
                        />
                      </TouchableOpacity>
                    </View>
                  </AppCard>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <View style={{ alignItems: "center", marginTop: 40, paddingHorizontal: 16 }}>
                <Text style={{ color: subText, marginBottom: 8, textAlign: "center" }}>
                  {t("recipes.no_cookbooks") || "No cookbooks yet."}
                </Text>
                <TouchableOpacity onPress={() => setNewCookbookVisible(true)}>
                  <Text style={{ color: "#E27D60", fontWeight: "600", textAlign: "center" }}>
                    {t("recipes.add_cookbook") || "Add cookbook"}
                  </Text>
                </TouchableOpacity>
              </View>
            }
          />
        </>
      )}

      {/* FAB */}
      {activeTab === "all" ? (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => setNewRecipeVisible(true)}
        >
          <MaterialIcons name="edit" size={22} color="#fff" />
          <Text style={styles.fabText}>{t("recipes.new_recipe")}</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => setNewCookbookVisible(true)}
        >
          <MaterialIcons name="add" size={22} color="#fff" />
          <Text style={styles.fabText}>{t("recipes.add_cookbook")}</Text>
        </TouchableOpacity>
      )}
      {/* New Recipe modal */}
      <Modal visible={newRecipeVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setNewRecipeVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: card }]}>
            <View style={styles.modalHeader}>
              <Text
                style={[
                  styles.modalTitle,
                  // If dark mode, override color to text for visibility
                  bg !== "#fff" ? { color: text } : null,
                ]}
              >
                {t("recipes.new_recipe")}
              </Text>
              <TouchableOpacity onPress={() => setNewRecipeVisible(false)}>
                <MaterialIcons name="close" size={24} color="#293a53" />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={styles.addOptionRow}
              onPress={() => {
                setNewRecipeVisible(false);
                router.push("/add-recipe");
              }}
            >
              <Text style={styles.addOptionEmoji}>✍️</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.addOptionText}>{t("recipes.manual_recipe")}</Text>
                <Text style={styles.addOptionSub}>{t("recipes.manual_recipe_sub")}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={24} color={subText} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.addOptionRow}
              onPress={() => {
                setNewRecipeVisible(false);
                setImportUrlVisible(true);
              }}
            >
              <Text style={styles.addOptionEmoji}>🌐</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.addOptionText}>{t("recipes.import_from_url")}</Text>
                <Text style={styles.addOptionSub}>{t("recipes.import_desc")}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={24} color={subText} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.addOptionRow}
              onPress={() => {
                setNewRecipeVisible(false);
                Alert.alert(t("common.coming_soon"), t("common.coming_soon_desc"));
              }}
            >
              <Text style={styles.addOptionEmoji}>📷</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.addOptionText}>{t("recipes.import_from_image")}</Text>
                <Text style={styles.addOptionSub}>{t("recipes.import_from_image_sub")}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={24} color={subText} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.addOptionRow}
              onPress={() => {
                setNewRecipeVisible(false);
                Alert.alert(t("common.coming_soon"), t("common.coming_soon_desc"));
              }}
            >
              <Text style={styles.addOptionEmoji}>📁</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.addOptionText}>{t("recipes.import_from_file")}</Text>
                <Text style={styles.addOptionSub}>{t("recipes.import_from_file_sub")}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={24} color={subText} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Import from URL modal */}
      <Modal visible={importUrlVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => {
            setImportUrlVisible(false);
            setImportError(null);
          }}
        >
          <View style={[styles.modalContent, { backgroundColor: card }]}>
            <View style={styles.modalHeader}>
              <Text
                style={[
                  styles.modalTitle,
                  // If dark mode, override color to text for visibility
                  bg !== "#fff" ? { color: text } : null,
                ]}
              >
                {t("recipes.import_from_url")}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setImportUrlVisible(false);
                  setImportError(null);
                }}
              >
                <MaterialIcons
                  name="close"
                  size={24}
                  color={bg !== "#fff" ? text : "#293a53"}
                />
              </TouchableOpacity>
            </View>
            <TextInput
              style={[
                styles.input,
                {
                  borderColor: border,
                  color: text,
                  marginBottom: 10,
                },
              ]}
              placeholder={t("recipes.paste_url")}
              placeholderTextColor={subText}
              value={importUrl}
              onChangeText={setImportUrl}
              editable={!importing}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {importError ? (
              <Text style={{ color: "#E27D60", marginBottom: 6, fontSize: 13 }}>
                {importError}
              </Text>
            ) : null}
            <TouchableOpacity
              style={{
                backgroundColor: "#E27D60",
                borderRadius: 8,
                paddingVertical: 12,
                alignItems: "center",
                marginTop: 4,
                opacity: importing ? 0.7 : 1,
              }}
              disabled={importing}
              onPress={async () => {
                setImportError(null);
                setImporting(true);
                try {
                  const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/importRecipeFromUrl`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ url: importUrl }),
                  });
                  if (!res.ok) {
                    let errMsg = t("recipes.invalid_import"); // default translated message
                    try {
                      const errData = await res.json();
                      if (errData && errData.errorCode) {
                        if (errData.errorCode === "INVALID_RECIPE_STRUCTURE") {
                          errMsg = t("recipes.invalid_import");
                        }
                      } else if (errData && errData.error) {
                        errMsg = errData.error; // fallback to any raw message
                      }
                    } catch (_) {
                      // ignore JSON parse errors
                    }
                    setImportError(errMsg);
                    setImportUrl("");
                    return;
                  }
                  const data = await res.json();
                  const recipe = data.recipe;

                  const stored = await AsyncStorage.getItem("recipes");
                  let parsed = stored ? JSON.parse(stored) : [];
                  parsed = [recipe, ...parsed];
                  await AsyncStorage.setItem("recipes", JSON.stringify(parsed));
                  setRecipes(parsed);

                  setImportUrl("");
                  setImportUrlVisible(false);
                  setImportedRecipe(recipe);
                  setSuccessVisible(true);
                } catch (err: any) {
                  console.error("Import error:", err);
                  setImportError(
                    err?.message || "Failed to import recipe. Please check the URL."
                  );
                  setImportUrl("");
                } finally {
                  setImporting(false);
                }
              }}
            >
              {importing ? (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Ionicons name="reload" size={18} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 15 }}>
                    Importing...
                  </Text>
                </View>
              ) : (
                <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 16 }}>
                  {t("recipes.import_button")}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Success Modal */}
      <Modal visible={successVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setSuccessVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: card, width: 320 }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: text }]}>{t("recipes.success_import_title")}</Text>
              <TouchableOpacity onPress={() => setSuccessVisible(false)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  color={bg !== "#fff" ? text : "#293a53"}
                />
              </TouchableOpacity>
            </View>
            <Text style={{ color: subText, marginBottom: 18, fontSize: 16 }}>
              {t("recipes.success_import_desc")}
            </Text>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 18 }}>
              <TouchableOpacity
                onPress={() => {
                  setSuccessVisible(false);
                  if (importedRecipe) {
                    router.push({
                      pathname: `/recipe/${importedRecipe.id}`,
                      params: { from: "history" },
                    });
                  }
                }}
                style={{ paddingHorizontal: 8, paddingVertical: 6 }}
              >
                <Text
                  style={{
                    color: bg !== "#fff" ? text : "#3b4a6b",
                    fontWeight: "bold",
                    fontSize: 15,
                    textTransform: "uppercase",
                  }}
                >
                  {t("recipes.open_recipe")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Filter modal */}
      <Modal visible={filterVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setFilterVisible(false)}
        >
          <TouchableWithoutFeedback>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{t("recipes.filters")}</Text>
                <TouchableOpacity onPress={() => setFilterVisible(false)}>
                  <MaterialIcons name="close" size={24} color="#293a53" />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={{ flexGrow: 0 }}
                contentContainerStyle={{ paddingBottom: 8, paddingHorizontal: 0 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={true}
              >
                <Text style={styles.modalSubtitle}>{t("recipes.difficulty")}</Text>
                <View style={styles.filterRow}>
                  {["Easy", "Moderate", "Challenging"].map((d) => (
                    <TouchableOpacity
                      key={d}
                      style={[
                        styles.filterOption,
                        {
                          backgroundColor: selectedDifficulties.includes(d)
                            ? "#293a53"
                            : "#E0E0E0",
                        },
                      ]}
                      onPress={() =>
                        toggleFilter(selectedDifficulties, d, setSelectedDifficulties)
                      }
                    >
                      <Text
                        style={{
                          color: selectedDifficulties.includes(d) ? "#fff" : "#000",
                        }}
                      >
                        {t(`difficulty.${d.toLowerCase()}`)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.modalSubtitle}>{t("recipes.cost")}</Text>
                <View style={styles.filterRow}>
                  {["Cheap", "Medium", "Expensive"].map((c) => (
                    <TouchableOpacity
                      key={c}
                      style={[
                        styles.filterOption,
                        {
                          backgroundColor: selectedCosts.includes(c)
                            ? "#293a53"
                            : "#E0E0E0",
                        },
                      ]}
                      onPress={() => toggleFilter(selectedCosts, c, setSelectedCosts)}
                    >
                      <Text
                        style={{
                          color: selectedCosts.includes(c) ? "#fff" : "#000",
                        }}
                      >
                        {t(`cost.${c.toLowerCase()}`)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {allTags.length > 0 && (
                  <>
                    <Text style={styles.modalSubtitle}>{t("recipes.tags")}</Text>
                    <View style={styles.filterRow}>
                      {allTags.map((tag) => (
                        <TouchableOpacity
                          key={tag}
                          style={[
                            styles.filterOption,
                            {
                              backgroundColor: selectedTags.includes(tag)
                                ? "#293a53"
                                : "#E0E0E0",
                            },
                          ]}
                          onPress={() => toggleFilter(selectedTags, tag, setSelectedTags)}
                        >
                          <Text
                            style={{
                              color: selectedTags.includes(tag) ? "#fff" : "#000",
                            }}
                          >
                            {tag}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}

                <TouchableOpacity
                  style={[
                    styles.filterOption,
                    { backgroundColor: "#E0E0E0", marginTop: 12 },
                  ]}
                  onPress={() => {
                    setSelectedDifficulties([]);
                    setSelectedCosts([]);
                    setSelectedTags([]);
                  }}
                >
                  <Text
                    style={{
                      color: "#293a53",
                      fontWeight: "600",
                      textAlign: "center",
                    }}
                  >
                    {t("recipes.clear_filters")}
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>
        </TouchableOpacity>
      </Modal>

      {/* New Cookbook modal */}
      <Modal visible={newCookbookVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setNewCookbookVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: card }]}>
            <View style={styles.modalHeader}>
              <Text
                style={[
                  styles.modalTitle,
                  bg !== "#fff" ? { color: text } : null,
                ]}
              >
                {t("recipes.add_cookbook")}
              </Text>
              <TouchableOpacity onPress={() => setNewCookbookVisible(false)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  color={bg !== "#fff" ? text : "#293a53"}
                />
              </TouchableOpacity>
            </View>
            <TextInput
              style={[styles.input, { borderColor: border, color: text }]}
              placeholder={t("recipes.cookbook_name_placeholder")}
              placeholderTextColor={subText}
              value={newCookbookName}
              onChangeText={setNewCookbookName}
            />
            <AppButton label={t("common.confirm")} onPress={createCookbook} variant="cta" />
          </View>
        </TouchableOpacity>
      </Modal>
      {/* Delete confirmation modal */}
      <Modal visible={!!deleteTarget} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setDeleteTarget(null)}
        >
          <View style={[styles.modalContent, { backgroundColor: card, width: 320 }]}>
            <View style={styles.modalHeader}>
              <Text
                style={[
                  styles.modalTitle,
                  // If dark mode, override color to text for visibility
                  bg !== "#fff" ? { color: text } : null,
                ]}
              >
                {deleteTarget?.type === "recipe"
                  ? t("recipes.delete_recipe_confirm")
                  : t("recipes.delete_cookbook_confirm")}
              </Text>
              <TouchableOpacity onPress={() => setDeleteTarget(null)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  // If dark mode, use text color for icon, else original
                  color={bg !== "#fff" ? text : "#293a53"}
                />
              </TouchableOpacity>
            </View>
            <Text style={{ color: subText, marginBottom: 18, fontSize: 15 }}>
              {deleteTarget?.type === "recipe"
                ? t("recipes.delete_recipe_desc")
                : t("recipes.delete_cookbook_desc")}
            </Text>
            <TouchableOpacity
              style={{
                backgroundColor: "#E53935",
                borderRadius: 8,
                paddingVertical: 12,
                alignItems: "center",
                marginTop: 4,
              }}
              onPress={confirmDelete}
            >
              <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 16 }}>
                {t("common.delete")}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  tabRow: {
    flexDirection: "row",
    justifyContent: "center",
    padding: 6,
    backgroundColor: "#293a53", // same as header background
  },
  tab: {
    flex: 1,
    marginHorizontal: 6,
    paddingVertical: 8,
    borderRadius: 20,
    alignItems: "center",
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "#F5F5F5",
  },
  recipeCard: { flexDirection: "row", padding: 10 },
  recipeImage: { width: 80, height: 80, borderRadius: 12, marginRight: 12 },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardTitle: { fontSize: 16, fontWeight: "600", flexShrink: 1 },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 4,
  },
  tagChip: {
    backgroundColor: "#E27D60",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginRight: 6,
    marginBottom: 4,
  },
  tagText: {
    color: "#fff",
    fontSize: 12,
    lineHeight: 14,
  },
  fab: {
    flexDirection: "row",
    alignItems: "center",
    position: "absolute",
    bottom: 80,
    right: 20,
    backgroundColor: "#E27D60",
    borderRadius: 28,
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 5,
  },
  fabText: { color: "#fff", fontWeight: "600", marginLeft: 6 },
  cookbookCard: {
    flex: 1,
    margin: 6,
    borderRadius: 12,
    overflow: "hidden",
  },
  cookbookImage: { width: "100%", height: 140 },
  cookbookOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    padding: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cookbookTitle: { color: "#fff", fontWeight: "bold", fontSize: 16 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    width: 320,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 20,
    maxHeight: "80%",
    // Remove alignItems: "center" to allow content to fill width and scroll properly
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#293a53",
  },
  modalSubtitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#293a53",
    marginTop: 10,
    marginBottom: 6,
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 8,
  },
  filterOption: {
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    // marginBottom now set inline for import modal
  },
  // Add Option Row Styles (consistent with cookbook/[id].tsx)
  addOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 10,
    backgroundColor: "#F5F5F5",
    borderRadius: 12,
    marginBottom: 10,
    marginTop: 0,
    gap: 10,
  },
  addOptionEmoji: {
    fontSize: 22,
    marginRight: 10,
  },
  addOptionText: {
    fontWeight: "600",
    color: "#293a53",
    fontSize: 16,
    marginBottom: 2,
  },
  addOptionSub: {
    color: "#78849E",
    fontSize: 13,
  },
});