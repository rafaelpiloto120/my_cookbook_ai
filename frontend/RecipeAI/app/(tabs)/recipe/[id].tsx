import React, { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Image,
  Animated,
  Share,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "../../../context/ThemeContext";
import { getAuth } from "firebase/auth";
import { getDeviceId } from "../../../utils/deviceId";
import AppCard from "../../../components/AppCard";
import { MaterialIcons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";

const defaultImage = require("../../../assets/default_recipe.png");

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
  cookbooks?: (string | { id: string; name: string })[];
}

interface Cookbook {
  id: string;
  name: string;
}

export default function RecipeDetail() {
  const insets = useSafeAreaInsets();
  const auth = getAuth();
  const { id, recipe, from } = useLocalSearchParams<{ id?: string; recipe?: string; from?: string }>();
  const [currentRecipe, setCurrentRecipe] = useState<Recipe | null>(null);
  const [servings, setServings] = useState<number>(1);
  const [cookbookNames, setCookbookNames] = useState<string[]>([]);
  const [isSaved, setIsSaved] = useState(false);
  const router = useRouter();
  const { bg, text, subText } = useThemeColors();
  const { t } = useTranslation();

  // ✅ Persisted animation value
  const fabAnim = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      (async () => {
        try {
          let storedRecipe: Recipe | null = null;
          let paramRecipe: Recipe | null = null;

          // 1) Try to load from AsyncStorage using id (this is our source of truth)
          if (id) {
            const stored = await AsyncStorage.getItem("recipes");
            const arr: Recipe[] = stored ? JSON.parse(stored) : [];
            const found = arr.find((r) => r.id === id);
            if (found) {
              storedRecipe = found;
            }
          }

          // 2) Also parse recipe param if present (may come from navigation)
          if (recipe) {
            try {
              paramRecipe = JSON.parse(recipe as string) as Recipe;
            } catch (e) {
              console.warn("[RecipeDetail] Failed to parse recipe param:", e);
            }
          }

          // 3) Merge both, preferring storedRecipe but falling back to paramRecipe for any missing fields
          let merged: Recipe | null = null;
          if (storedRecipe && paramRecipe) {
            merged = {
              ...paramRecipe,
              ...storedRecipe,
            };
            // Make sure we keep a valid image if one of them has it
            const storedImg = storedRecipe.image;
            const paramImg = paramRecipe.image;
            if ((storedImg === undefined || storedImg === null || storedImg === "" || storedImg === "null" || storedImg === "undefined") && paramImg) {
              merged.image = paramImg;
            } else if (!merged.image && (paramImg || storedImg)) {
              merged.image = (storedImg || paramImg) as any;
            }
          } else {
            merged = storedRecipe || paramRecipe;
          }

          if (isActive && merged) {
            setCurrentRecipe(merged);
            setServings(merged.servings || 1);
            if (merged.cookbooks && merged.cookbooks.length > 0) {
              await loadCookbookNames(merged.cookbooks);
            } else {
              setCookbookNames([]);
            }
          }
        } catch (err) {
          console.error("Failed to load recipe:", err);
        }
      })();

      // Animate FAB in
      Animated.timing(fabAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();

      return () => {
        isActive = false;
      };
    }, [id, recipe])
  );

  useEffect(() => {
    if (currentRecipe?.cookbooks && currentRecipe.cookbooks.length > 0) {
      loadCookbookNames(currentRecipe.cookbooks);
    } else {
      setCookbookNames([]);
    }
  }, [currentRecipe?.cookbooks]);

  // Check if recipe is saved
  useEffect(() => {
    const checkIsSaved = async () => {
      if (!currentRecipe) {
        setIsSaved(false);
        return;
      }
      try {
        const stored = await AsyncStorage.getItem("recipes");
        const arr: Recipe[] = stored ? JSON.parse(stored) : [];
        const exists = arr.find((r) => r.id === currentRecipe.id);
        setIsSaved(!!exists);
      } catch (error) {
        setIsSaved(false);
      }
    };
    checkIsSaved();
  }, [currentRecipe]);

  const loadCookbookNames = async (cookbookField: (string | { id: string; name: string })[]) => {
    try {
      const storedCookbooks = await AsyncStorage.getItem("cookbooks");
      const allCookbooks: Cookbook[] = storedCookbooks ? JSON.parse(storedCookbooks) : [];
      const names = cookbookField.map(cb => {
        if (typeof cb === "string") {
          const match = allCookbooks.find(c => c.id === cb);
          return match ? match.name : "";
        } else if (cb && cb.name) {
          return cb.name;
        }
        return "";
      }).filter(Boolean);
      setCookbookNames(names);
    } catch (error) {
      console.error("Failed to load cookbooks:", error);
      setCookbookNames([]);
    }
  };

  const handleBack = () => {
    if (from === "history") {
      router.replace("/(tabs)/history");
    } else if (from && from.startsWith("cookbook:")) {
      const cookbookId = from.split(":")[1];
      router.push(`/cookbook/${cookbookId}`);
    } else {
      router.replace("/(tabs)/history");
    }
  };

  const deleteRecipe = async () => {
    if (!currentRecipe) return;
    Alert.alert("Delete Recipe", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const stored = await AsyncStorage.getItem("recipes");
          const arr: Recipe[] = stored ? JSON.parse(stored) : [];
          const updated = arr.filter((r) => r.id !== currentRecipe.id);
          await AsyncStorage.setItem("recipes", JSON.stringify(updated));

          // 🔹 Analytics: manual recipe deleted (reuses /analytics-event)
          try {
            const backendUrl = process.env.EXPO_PUBLIC_API_URL;
            if (backendUrl && currentRecipe) {
              const currentUser = auth.currentUser;
              const userId = currentUser?.uid ?? null;

              let deviceId: string | null = null;
              try {
                deviceId = await getDeviceId();
              } catch (e) {
                console.warn("[RecipeDetail] getDeviceId failed for delete analytics", e);
              }

              const headers: Record<string, string> = {
                "Content-Type": "application/json",
              };
              if (deviceId) headers["x-device-id"] = deviceId;
              if (userId) headers["x-user-id"] = userId;

              fetch(`${backendUrl}/analytics-event`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  eventType: "manual_recipe_deleted",
                  userId,
                  deviceId,
                  metadata: {
                    source: "recipe_detail",
                    recipeId: currentRecipe.id,
                    title: currentRecipe.title,
                    hasImage: !!currentRecipe.image,
                    ingredientsCount: currentRecipe.ingredients.length,
                    stepsCount: currentRecipe.steps.length,
                    tagsCount: currentRecipe.tags.length,
                    cookbooksCount: currentRecipe.cookbooks ? currentRecipe.cookbooks.length : 0,
                  },
                }),
              }).catch((err) => {
                console.warn("[RecipeDetail] analytics-event fetch failed", err);
              });
            }
          } catch (e) {
            console.warn("[RecipeDetail] analytics logging failed", e);
          }

          router.back();
        },
      },
    ]);
  };

  const editRecipe = async () => {
    if (!currentRecipe) return;
    if (!isSaved) {
      await saveRecipe();
    }
    router.push({
      pathname: "/add-recipe",
      params: { edit: JSON.stringify(currentRecipe) },
    });
  };

  const startCooking = () => {
    if (!currentRecipe) return;

    // fade out FAB then navigate
    Animated.timing(fabAnim, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => {
      router.push({
        pathname: "/recipe/start-cooking", // ✅ correct route
        params: { recipe: JSON.stringify(currentRecipe) },
      });
    });
  };

  const shareRecipe = async () => {
    if (!currentRecipe) return;
    try {
      const message = `${currentRecipe.title}\n\nIngredients:\n${currentRecipe.ingredients.join(
        "\n"
      )}\n\nSteps:\n${currentRecipe.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
      await Share.share({
        message,
        title: currentRecipe.title,
      });
    } catch (error) {
      Alert.alert("Error", "Failed to share recipe");
    }
  };

  const scaleIngredient = (ingredient: string) => {
    // This helper attempts to find numbers in the ingredient string and scale them
    // For example: "2 cups flour" with servings 4 and base servings 2 => "4 cups flour"
    if (!currentRecipe) return ingredient;
    const baseServings = currentRecipe.servings;
    if (baseServings === servings) return ingredient;

    return ingredient.replace(/(\d+(\.\d+)?)/g, (match) => {
      const num = parseFloat(match);
      if (isNaN(num)) return match;
      const scaled = (num * servings) / baseServings;
      // Format to max 2 decimals, remove trailing zeros
      return scaled % 1 === 0 ? scaled.toString() : scaled.toFixed(2).replace(/\.?0+$/, "");
    });
  };

  const saveRecipe = async () => {
    if (!currentRecipe) return;
    try {
      const stored = await AsyncStorage.getItem("recipes");
      const arr: Recipe[] = stored ? JSON.parse(stored) : [];
      const exists = arr.find((r) => r.id === currentRecipe.id);
      if (exists) {
        Alert.alert("Info", "Recipe already saved");
        setIsSaved(true);
        return;
      }
      // Save currentRecipe as is (do not modify cookbooks field)
      arr.push(currentRecipe);
      await AsyncStorage.setItem("recipes", JSON.stringify(arr));
      Alert.alert("Success", "Recipe saved successfully");
      setIsSaved(true);
    } catch (error) {
      Alert.alert("Error", "Failed to save recipe");
      console.error("Failed to save recipe:", error);
    }
  };


  // Safely resolve recipe image source (supports string or { uri } object)
  const getRecipeImageSource = () => {
    if (!currentRecipe || !currentRecipe.image) {
      return defaultImage;
    }

    const img: any = currentRecipe.image;

    // Case 1: image is a simple string URL/URI
    if (typeof img === "string") {
      const trimmed = img.trim();
      if (!trimmed || trimmed === "null" || trimmed === "undefined") {
        return defaultImage;
      }
      // Let React Native try to load any non-empty URI string (http, file, content, data:, etc.)
      return { uri: trimmed };
    }

    // Case 2: image is an object like { uri: "..." }
    if (typeof img === "object" && img !== null && typeof img.uri === "string") {
      const trimmed = img.uri.trim();
      if (!trimmed || trimmed === "null" || trimmed === "undefined") {
        return defaultImage;
      }
      return { uri: trimmed };
    }

    // Fallback
    return defaultImage;
  };

  const imageSource = getRecipeImageSource();


  // Mappings for difficulty and cost
  const difficultyMap = {
    Easy: t("difficulty.easy"),
    Moderate: t("difficulty.moderate"),
    Challenging: t("difficulty.challenging"),
  };
  const costMap = {
    Cheap: t("cost.cheap"),
    Medium: t("cost.medium"),
    Expensive: t("cost.expensive"),
  };

  // Use map to always show emoji label
  const difficultyDisplay = currentRecipe ? (difficultyMap[currentRecipe.difficulty] || currentRecipe.difficulty) : "";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t("recipes.open_recipe"),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
          headerLeft: () => (
            <TouchableOpacity
              onPress={handleBack}
              style={{ padding: 8 }}
            >
              <MaterialIcons name="arrow-back" size={26} color="#fff" />
            </TouchableOpacity>
          ),
          headerRight: () => (
            <View style={{ flexDirection: "row" }}>
              <TouchableOpacity onPress={shareRecipe} style={{ padding: 8 }}>
                <MaterialIcons name="share" size={26} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={editRecipe} style={{ padding: 8 }}>
                <MaterialIcons name="edit" size={26} color="#fff" />
              </TouchableOpacity>
            </View>
          ),
        }}
      />

      {!currentRecipe ? (
        <View style={[styles.center, { flex: 1 }]}>
          <Text style={{ color: text }}>{t("recipes.not_found", "Recipe not found")}</Text>
        </View>
      ) : (
        <>
          <ScrollView
            style={styles.container}
            contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
          >
            <Image
              source={imageSource}
              style={styles.detailImage}
              resizeMode="cover"
            />

            <Text style={[styles.title, { color: text }]}>{currentRecipe.title}</Text>
            <Text style={{ color: subText, marginBottom: 16 }}>
              {t("recipes.created_on")}{" "}
              {new Date(currentRecipe.createdAt).toLocaleDateString()}
            </Text>

            {/* Quick Info */}
            <AppCard>
              <View style={styles.quickInfo}>
                <Text style={[styles.quickInfoText, { color: text }]}>
                  ⏱ {currentRecipe.cookingTime} min
                </Text>
                <Text style={[styles.quickInfoText, { color: text }]}>
                  {difficultyDisplay}
                </Text>
                <Text style={[styles.quickInfoText, { color: text }]}>
                  {costMap[currentRecipe.cost]}
                </Text>
              </View>
            </AppCard>

            {/* Ingredients */}
            <Text style={[styles.sectionTitle, { color: text }]}>
              {t("recipes.ingredients")}
            </Text>
            <AppCard>
              <View style={styles.servingsRow}>
                <Text style={[styles.servingsLabel, { color: text }]}>
                  {t("recipes.servings", { count: servings })}
                </Text>
                <View style={{ flexDirection: "row" }}>
                  <TouchableOpacity
                    style={styles.stepperBtn}
                    onPress={() =>
                      setServings((prev) => (prev > 1 ? prev - 1 : 1))
                    }
                  >
                    <Text style={styles.stepper}>−</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.stepperBtn}
                    onPress={() => setServings((prev) => prev + 1)}
                  >
                    <Text style={styles.stepper}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {currentRecipe.ingredients.map((ing, i) => (
                <Text key={i} style={[styles.text, { color: text }]}>
                  • {scaleIngredient(ing)}
                </Text>
              ))}
            </AppCard>

            {/* Preparation */}
            <Text style={[styles.sectionTitle, { color: text }]}>
              {t("recipes.preparation")}
            </Text>
            <AppCard>
              {currentRecipe.steps.map((step, i) => (
                <Text key={i} style={[styles.text, { color: text }]}>
                  {step}
                </Text>
              ))}
            </AppCard>

            {/* Cookbook */}
            <Text style={[styles.sectionTitle, { color: text }]}>
              {t("recipes.cookbooks")}
            </Text>
            <AppCard style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {cookbookNames.length > 0 ? (
                cookbookNames.map((name, index) => (
                  <View key={index} style={styles.cookbookChip}>
                    <Text
                      style={[
                        styles.cookbookChipText,
                        { color: bg === "#fff" ? text : "#000" },
                      ]}
                    >
                      {name}
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={{ color: subText }}>
                  {t("recipes.not_in_cookbook")}
                </Text>
              )}
            </AppCard>

            {/* Tags */}
            {currentRecipe.tags.length > 0 && (
              <>
                <Text style={[styles.sectionTitle, { color: text }]}>
                  {t("recipes.tags")}
                </Text>
                <AppCard style={{ flexDirection: "row", flexWrap: "wrap" }}>
                  {currentRecipe.tags.map((tag, i) => (
                    <Text key={i} style={styles.tag}>
                      {tag}
                    </Text>
                  ))}
                </AppCard>
              </>
            )}
          </ScrollView>

          {/* FAB with animation */}
          <Animated.View
            style={[
              styles.fabContainer,
              {
                bottom: insets.bottom + 20,
                opacity: fabAnim,
                flexDirection: "row",
                justifyContent: "flex-end",
                alignItems: "center",
              },
            ]}
          >
            <TouchableOpacity style={styles.fab} onPress={startCooking}>
              <MaterialIcons name="restaurant-menu" size={22} color="#fff" />
              <Text style={styles.fabText}>{t("recipes.start_cooking")}</Text>
            </TouchableOpacity>
            {!isSaved && (
              <TouchableOpacity
                style={[styles.fab, { marginLeft: 12 }]}
                onPress={saveRecipe}
              >
                <MaterialIcons name="save" size={22} color="#fff" />
                <Text style={styles.fabText}>{t("recipes.save_recipe")}</Text>
              </TouchableOpacity>
            )}
          </Animated.View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  detailImage: {
    width: "100%",
    height: 200,
    borderRadius: 12,
    marginTop: 10,
    marginBottom: 16,
  },
  title: { fontSize: 24, fontWeight: "bold", marginBottom: 4 },
  quickInfo: { flexDirection: "row", justifyContent: "space-between" },
  quickInfoText: { fontSize: 14 },
  sectionTitle: { fontSize: 18, fontWeight: "600", marginTop: 0, marginBottom: 6 },
  text: { fontSize: 16, marginBottom: 6, lineHeight: 22 },
  tag: {
    backgroundColor: "#FFECB3",
    paddingHorizontal: 10,
    borderRadius: 16,
    fontSize: 13,
    marginRight: 6,
    marginBottom: 6,
    height: 26,
    lineHeight: 26,
  },
  cookbookChip: {
    backgroundColor: "#B3D4FC",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
    marginBottom: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  cookbookChipText: {
    fontSize: 13,
  },
  fabContainer: {
    position: "absolute",
    right: 20,
  },
  fab: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E27D60",
    borderRadius: 28,
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 5,
  },
  fabText: { color: "#fff", fontWeight: "600", marginLeft: 6 },
  servingsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  servingsLabel: {
    fontSize: 16,
    fontWeight: "600",
  },
  stepper: {
    fontSize: 20,
    fontWeight: "600",
    color: "#E27D60",
    textAlign: "center",
  },
  stepperBtn: {
    borderWidth: 1,
    borderColor: "#E27D60",
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 2,
    marginLeft: 8,
  },
});