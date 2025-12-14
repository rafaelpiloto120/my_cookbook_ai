import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Image,
  Modal,
  TextInput,
  Alert,
  ScrollView,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import AppCard from "../../components/AppCard";
import AppButton from "../../components/AppButton";
import { useThemeColors } from "../../context/ThemeContext";
import { useTranslation } from "react-i18next";

import { auth } from "../../firebaseConfig";
import { signInAnonymously } from "firebase/auth";
import { storage } from "../../firebaseConfig";
import { ref, deleteObject } from "firebase/storage";
import { useAuth } from "../../context/AuthContext";
import { syncEngine as syncEngineSingleton } from "../../lib/sync/SyncEngine";


const difficultyMap = (t: any) => ({
  Easy: t("difficulty.easy"),
  Moderate: t("difficulty.moderate"),
  Challenging: t("difficulty.challenging"),
});
const costMap = (t: any) => ({
  Cheap: t("cost.cheap"),
  Medium: t("cost.medium"),
  Expensive: t("cost.expensive"),
});
const defaultImage = require("../../assets/default_recipe.png");

export default function CookbookDetail() {
  const { id } = useLocalSearchParams(); // cookbook id from route
  const router = useRouter();
  const { bg, text, subText, card, border } = useThemeColors();
  const { t } = useTranslation();

  const { syncEngine: authSyncEngine } = useAuth();
  // Some screens can render before AuthContext has finished wiring the engine.
  // Fallback to the named singleton so we can always persist + sync.
  const syncEngine = (authSyncEngine ?? syncEngineSingleton) as any;

  const backendUrl = process.env.EXPO_PUBLIC_API_URL!;
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  console.log("Using backend URL:", backendUrl, "env:", appEnv);

  const [cookbookName, setCookbookName] = useState("");
  const [recipes, setRecipes] = useState<any[]>([]);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string, type: "recipe" } | null>(null);

  // edit modal
  const [editVisible, setEditVisible] = useState(false);
  const [newName, setNewName] = useState("");
  const [cookbookImage, setCookbookImage] = useState<string | null>(null);

  // search and filter states
  const [search, setSearch] = useState("");
  const [filterVisible, setFilterVisible] = useState(false);
  const [selectedDifficulties, setSelectedDifficulties] = useState<string[]>([]);
  const [selectedCosts, setSelectedCosts] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Add Recipe Modal
  const [addVisible, setAddVisible] = useState(false);
  // Import from URL Modal
  const [importUrlVisible, setImportUrlVisible] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState("");

  // Success Modal for import
  const [successVisible, setSuccessVisible] = useState(false);
  const [importedRecipe, setImportedRecipe] = useState<any | null>(null);

  // --- Load recipes + cookbook name
  useEffect(() => {
    const load = async () => {
      try {
        const storedRecipes = await AsyncStorage.getItem("recipes");
        const storedCookbooks = await AsyncStorage.getItem("cookbooks");

        const parsedRecipes = storedRecipes ? JSON.parse(storedRecipes) : [];
        const parsedCookbooks = storedCookbooks ? JSON.parse(storedCookbooks) : [];

        const thisCookbook = parsedCookbooks.find((c: any) => c.id === id);
        setCookbookName(thisCookbook?.name || "Cookbook");
        // Support both legacy `image` and newer `imageUrl` fields
        setCookbookImage(thisCookbook?.imageUrl ?? thisCookbook?.image ?? null);

        const filtered = parsedRecipes.filter((r: any) => {
          if (r?.isDeleted) return false;
          if (!Array.isArray(r.cookbooks)) return false;
          return r.cookbooks.some(
            (cb: any) =>
              (typeof cb === "string" && cb === id) ||
              (typeof cb === "object" && cb.id === id)
          );
        });
        setRecipes(filtered);
      } catch (err) {
        console.error("Error loading cookbook detail:", err);
      }
    };
    load();
  }, [id, editVisible]); // reload if edited

  // Ensure we have a Firebase auth user (real or anonymous) and return uid + ID token
  const ensureAuthUid = async (): Promise<{ uid: string; token: string } | null> => {
    try {
      if (auth.currentUser) {
        const token = await auth.currentUser.getIdToken();
        return { uid: auth.currentUser.uid, token };
      }
      const cred = await signInAnonymously(auth);
      const token = await cred.user.getIdToken();
      return { uid: cred.user.uid, token };
    } catch (e) {
      console.warn("[Cookbook] ensureAuthUid failed", e);
      return null;
    }
  };

  // Upload a cookbook image to backend -> Firebase Storage; returns public URL or null
  const uploadCookbookImage = async (localUri: string, cookbookId: string): Promise<string | null> => {
    try {
      const authInfo = await ensureAuthUid();
      if (!authInfo) return null;

      const apiUrl = `${backendUrl}/uploadRecipeImage`;
      const filename = `cover.jpg`;
      const storagePath = `users/${authInfo.uid}/cookbooks/${cookbookId}/${filename}`;

      const form = new FormData();
      form.append("path", storagePath as any);
      form.append("contentType", "image/jpeg" as any);
      form.append("file", { uri: localUri, name: filename, type: "image/jpeg" } as any);

      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authInfo.token}`,
          "x-app-env": appEnv,
        },
        body: form,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[Cookbook] Backend upload failed", data);
        return null;
      }
      if (data && data.downloadURL) return data.downloadURL as string;
      if (data && data.url) return data.url as string;
      return null;
    } catch (e) {
      console.warn("[Cookbook] Backend upload exception", e);
      return null;
    }
  };

  // Remove current cookbook cover image: delete from Firebase Storage (best-effort) and clear locally
  const removeCookbookCover = async () => {
    if (!cookbookImage) return;
    try {
      // Try to delete the object if this is a download URL or a gs:// path
      try {
        const objRef = ref(storage, cookbookImage);
        await deleteObject(objRef);
        console.log("[Cookbook] Deleted cover from storage");
      } catch (e) {
        console.warn("[Cookbook] deleteObject failed (continuing):", e);
      }

      // Clear from AsyncStorage so the change persists
      const storedCookbooks = await AsyncStorage.getItem("cookbooks");
      const parsedCookbooks = storedCookbooks ? JSON.parse(storedCookbooks) : [];
      const updated = parsedCookbooks.map((c: any) =>
        c.id === id ? { ...c, image: null, imageUrl: null } : c
      );

      // Persist legacy snapshot used by UI screens
      await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));

      // Save via sync engine + trigger remote sync
      const anyEngine = syncEngine as any;
      try {
        if (typeof anyEngine.saveLocalCookbooksSnapshot === "function") {
          await anyEngine.saveLocalCookbooksSnapshot(updated);
        }
        console.log("[CookbookDetail] requesting sync after cover removal");
        // Trigger a full sync NOW.
        if (typeof anyEngine.forceSyncNow === "function") {
          await anyEngine.forceSyncNow("manual");
        } else if (typeof anyEngine.syncAll === "function") {
          try {
            await anyEngine.syncAll("manual", { bypassThrottle: true });
          } catch {
            await anyEngine.syncAll("manual");
          }
        } else if (typeof anyEngine.requestSync === "function") {
          anyEngine.requestSync("manual");
        }
      } catch (syncErr) {
        console.warn("[Cookbook] sync after cover removal failed", syncErr);
      }

      // Update UI state
      setCookbookImage(null);
    } catch (err) {
      console.error("[Cookbook] Error removing cover:", err);
    }
  };

  // --- Save updated cookbook name and image
  const saveCookbookName = async () => {
    if (!newName.trim()) {
      Alert.alert("Validation", "Please enter a name.");
      return;
    }
    try {
      // If the selected image is a local file, upload it to Firebase Storage first
      let finalCookbookImage: string | null = cookbookImage;
      if (cookbookImage && (cookbookImage.startsWith("file:") || cookbookImage.startsWith("content:"))) {
        const uploaded = await uploadCookbookImage(cookbookImage, String(id));
        if (uploaded) {
          console.log("[Cookbook] Image uploaded =>", uploaded);
          finalCookbookImage = uploaded;
        } else {
          console.warn("[Cookbook] Upload failed; removing local image reference");
          finalCookbookImage = null; // avoid persisting file:// that won't render later
        }
      }
      const storedCookbooks = await AsyncStorage.getItem("cookbooks");
      const parsedCookbooks = storedCookbooks ? JSON.parse(storedCookbooks) : [];

      const updated = parsedCookbooks.map((c: any) =>
        c.id === id
          ? {
              ...c,
              name: newName.trim(),
              // Keep legacy `image` for existing UI, but also persist `imageUrl` for sync.
              image: finalCookbookImage,
              imageUrl: finalCookbookImage,
              updatedAt: Date.now(),
            }
          : c
      );

      // Persist legacy snapshot used by UI screens
      await AsyncStorage.setItem("cookbooks", JSON.stringify(updated));
      // NOTE: `saveLocalCookbooksSnapshot` mirrors this legacy snapshot into the sync-store.

      // Save via sync engine + trigger remote sync
      const anyEngine = syncEngine as any;
      try {
        if (typeof anyEngine.saveLocalCookbooksSnapshot === "function") {
          await anyEngine.saveLocalCookbooksSnapshot(updated);
        }
        console.log("[CookbookDetail] requesting sync after cookbook edit");
        // Trigger a full sync NOW.
        if (typeof anyEngine.forceSyncNow === "function") {
          await anyEngine.forceSyncNow("manual");
        } else if (typeof anyEngine.syncAll === "function") {
          try {
            await anyEngine.syncAll("manual", { bypassThrottle: true });
          } catch {
            await anyEngine.syncAll("manual");
          }
        } else if (typeof anyEngine.requestSync === "function") {
          anyEngine.requestSync("manual");
        }
      } catch (syncErr) {
        console.warn("[Cookbook] sync after cookbook rename failed", syncErr);
      }

      setCookbookName(newName.trim());
      setCookbookImage(finalCookbookImage);
      setEditVisible(false);
    } catch (err) {
      console.error("Error updating cookbook name:", err);
    }
  };

  // --- Pick image for cookbook
  const pickCookbookImage = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (!result.canceled && result.assets && result.assets.length > 0) {
      setCookbookImage(result.assets[0].uri);
    }
  };

  const getNormalizedTags = (tags: any) => {
    if (!tags) return [];
    if (Array.isArray(tags)) {
      return tags.map((t) => (typeof t === "string" ? t : t.name));
    }
    return [];
  };

  const filteredRecipes = recipes.filter((recipe) => {
    const titleMatch = recipe.title.toLowerCase().includes(search.toLowerCase());
    const difficultyMatch =
      selectedDifficulties.length === 0 || selectedDifficulties.includes(recipe.difficulty);
    const costMatch = selectedCosts.length === 0 || selectedCosts.includes(recipe.cost);
    const recipeTags = getNormalizedTags(recipe.tags);
    const tagsMatch =
      selectedTags.length === 0 ||
      selectedTags.every((tag) => recipeTags.includes(tag));
    return titleMatch && difficultyMatch && costMatch && tagsMatch;
  });

  // Collect all tags from recipes for filter chips
  const allTags = Array.from(
    new Set(
      recipes.reduce((acc: string[], recipe) => {
        const t = getNormalizedTags(recipe.tags);
        return acc.concat(t);
      }, [])
    )
  ).sort();

  const difficulties = ["Easy", "Medium", "Hard"];
  const costs = ["Low", "Medium", "High"];

  const toggleSelection = (item: string, selected: string[], setSelected: (v: string[]) => void) => {
    if (selected.includes(item)) {
      setSelected(selected.filter((i) => i !== item));
    } else {
      setSelected([...selected, item]);
    }
  };

  // --- Delete recipe (modal confirmation)
  const deleteRecipe = (recipeId: string) => {
    setDeleteTarget({ id: recipeId, type: "recipe" });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const recipeId = deleteTarget.id;

    try {
      const stored = await AsyncStorage.getItem("recipes");
      const all = stored ? JSON.parse(stored) : [];

      const now = Date.now();
      let deletedRecipe: any | null = null;

      const updatedAll = Array.isArray(all)
        ? all.map((r: any) => {
            if (!r || r.id !== recipeId) return r;
            deletedRecipe = {
              ...r,
              isDeleted: true,
              updatedAt: now,
            };
            return deletedRecipe;
          })
        : [];

      // Persist legacy snapshot used by UI screens
      await AsyncStorage.setItem("recipes", JSON.stringify(updatedAll));

      // Save via sync engine + mark dirty + trigger remote sync
      const anyEngine = syncEngine as any;
      try {
        if (typeof anyEngine.saveLocalRecipesSnapshot === "function") {
          await anyEngine.saveLocalRecipesSnapshot(updatedAll);
        }

        // Ensure the deletion becomes a dirty item in the sync store
        if (deletedRecipe && typeof anyEngine.markRecipeDirty === "function") {
          await anyEngine.markRecipeDirty(deletedRecipe);
        }

        // Trigger a full sync NOW.
        if (typeof anyEngine.forceSyncNow === "function") {
          await anyEngine.forceSyncNow("manual");
        } else if (typeof anyEngine.syncAll === "function") {
          try {
            await anyEngine.syncAll("manual", { bypassThrottle: true });
          } catch {
            await anyEngine.syncAll("manual");
          }
        } else if (typeof anyEngine.requestSync === "function") {
          anyEngine.requestSync("manual");
        }
      } catch (syncErr) {
        console.warn("[Cookbook] sync after recipe delete failed", syncErr);
      }

      // Update UI state (remove from this cookbook list immediately)
      setRecipes((prev) => prev.filter((r) => r.id !== recipeId));
    } catch (err) {
      console.error("Error deleting recipe:", err);
    }

    setDeleteTarget(null);
  };

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          title: cookbookName,
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
          headerLeft: () => (
            <TouchableOpacity
              onPress={() =>
                router.replace({
                  pathname: "/(tabs)/history",
                  params: { tab: "cookbooks" },
                })
              }
            >
              <MaterialIcons name="arrow-back" size={24} color="#fff" />
            </TouchableOpacity>
          ),
          headerRight: () => (
            <TouchableOpacity
              onPress={() => {
                setNewName(cookbookName);
                setEditVisible(true);
              }}
            >
              <MaterialIcons name="edit" size={24} color="#fff" />
            </TouchableOpacity>
          ),
        }}
      />

      {/* Search and Filter Bar */}
      <View style={[styles.searchRow]}>
        <MaterialIcons name="search" size={24} color={subText} style={{ marginRight: 8 }} />
        <TextInput
          placeholder={t("recipes.search_placeholder")}
          placeholderTextColor={subText}
          value={search}
          onChangeText={setSearch}
          style={{ flex: 1, color: text, fontSize: 16, height: 40 }}
        />
        <TouchableOpacity onPress={() => setFilterVisible(true)}>
          <MaterialIcons name="filter-list" size={24} color={subText} />
        </TouchableOpacity>
      </View>

      {filteredRecipes.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={{ color: subText, marginBottom: 8 }}>
            {t("recipes.no_recipes")}
          </Text>
          <TouchableOpacity onPress={() => router.push("/(tabs)/")}>
            <Text style={{ color: "#E27D60", fontWeight: "600" }}>
              {t("recipes.create_in_ai_kitchen")}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filteredRecipes}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const recipeTags = getNormalizedTags(item.tags).slice(0, 3);
            return (
              <TouchableOpacity
                onPress={() =>
                  router.push({
                    pathname: `/recipe/${item.id}`,
                    params: { from: `cookbook:${id}` },
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
                      <Text
                        style={[styles.cardTitle, { color: text }]}
                        numberOfLines={2}
                        ellipsizeMode="tail"
                      >
                        {item.title}
                      </Text>
                      <TouchableOpacity
                        onPress={() => deleteRecipe(item.id)}
                        style={styles.deleteButton}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <MaterialIcons name="delete-outline" size={22} color={subText} />
                      </TouchableOpacity>
                    </View>
                    <Text style={{ color: subText }}>
                      ⏱ {item.cookingTime} min • {difficultyMap(t)[item.difficulty] || item.difficulty} • {costMap(t)[item.cost] || item.cost}
                    </Text>
                    {recipeTags.length > 0 && (
                      <View style={styles.tagRow}>
                        {recipeTags.map((tag) => (
                          <View key={tag} style={[styles.tagChip, { backgroundColor: "#E27D60" }]}>
                            <Text style={styles.tagText}>{tag}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                </AppCard>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setAddVisible(true)}
      >
        <MaterialIcons name="edit" size={22} color="#fff" />
        <Text style={styles.fabText}>{t("recipes.new_recipe")}</Text>
      </TouchableOpacity>

      {/* Edit Cookbook Modal */}
      <Modal visible={editVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setEditVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: text }]}>
                {t("recipes.edit_cookbook")}
              </Text>
              <TouchableOpacity onPress={() => setEditVisible(false)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  color={bg === "#fff" ? "#293a53" : "#fff"}
                />
              </TouchableOpacity>
            </View>
            {/* Cookbook image picker */}
            <TouchableOpacity
              style={{ alignItems: "center", marginBottom: 16 }}
              onPress={pickCookbookImage}
              activeOpacity={0.7}
            >
              <Image
                source={
                  cookbookImage
                    ? { uri: cookbookImage }
                    : defaultImage
                }
                style={{ width: 80, height: 80, borderRadius: 40, marginBottom: 6, borderWidth: 1, borderColor: border }}
              />
              <Text style={{ color: "#E27D60", fontSize: 13 }}>
                {cookbookImage ? t("recipes.tap_to_change_image") : t("recipes.tap_to_upload_image")}
              </Text>
            </TouchableOpacity>
            {cookbookImage ? (
              <TouchableOpacity
                onPress={removeCookbookCover}
                style={{ alignSelf: "center", marginTop: 4, marginBottom: 8, paddingVertical: 6, paddingHorizontal: 10 }}
                activeOpacity={0.7}
              >
                <Text style={{ color: "#E53935", fontWeight: "600" }}>
                  {t("profile.remove_photo", { defaultValue: "Remove Photo" })}
                </Text>
              </TouchableOpacity>
            ) : null}
            <TextInput
              style={[styles.input, { borderColor: border, color: text }]}
              placeholder={t("recipes.cookbook_name_placeholder")}
              placeholderTextColor={subText}
              value={newName}
              onChangeText={setNewName}
            />
            <AppButton label={t("common.confirm")} onPress={saveCookbookName} variant="cta" />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Filter Modal */}
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
                  {Object.entries(difficultyMap(t)).map(([key, label]) => (
                    <TouchableOpacity
                      key={key}
                      style={[
                        styles.filterOption,
                        {
                          backgroundColor: selectedDifficulties.includes(key)
                            ? "#293a53"
                            : "#E0E0E0",
                        },
                      ]}
                      onPress={() =>
                        toggleSelection(key, selectedDifficulties, setSelectedDifficulties)
                      }
                    >
                      <Text
                        style={{
                          color: selectedDifficulties.includes(key) ? "#fff" : "#000",
                        }}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.modalSubtitle}>{t("recipes.cost")}</Text>
                <View style={styles.filterRow}>
                  {Object.entries(costMap(t)).map(([key, label]) => (
                    <TouchableOpacity
                      key={key}
                      style={[
                        styles.filterOption,
                        {
                          backgroundColor: selectedCosts.includes(key)
                            ? "#293a53"
                            : "#E0E0E0",
                        },
                      ]}
                      onPress={() => toggleSelection(key, selectedCosts, setSelectedCosts)}
                    >
                      <Text
                        style={{
                          color: selectedCosts.includes(key) ? "#fff" : "#000",
                        }}
                      >
                        {label}
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
                          onPress={() => toggleSelection(tag, selectedTags, setSelectedTags)}
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

      {/* Add Recipe Modal (styled like History.tsx) */}
      <Modal visible={addVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setAddVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: card, width: 320, alignItems: "stretch", padding: 0 }]}>
            <View style={[styles.modalHeader, { width: "100%", padding: 20, paddingBottom: 8 }]}>
              <Text style={[styles.modalTitle, { color: text }]}>{t("recipes.new_recipe")}</Text>
              <TouchableOpacity onPress={() => setAddVisible(false)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  color={bg === "#fff" ? "#293a53" : "#fff"}
                />
              </TouchableOpacity>
            </View>
            <View style={{ paddingHorizontal: 12, paddingBottom: 16 }}>
              {/* Manual Recipe */}
              <TouchableOpacity
                style={styles.addOptionRow}
                onPress={() => {
                  setAddVisible(false);
                  router.push({ pathname: "/add-recipe", params: { cookbookId: id } });
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.addOptionEmoji}>✍️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.addOptionText, { color: text }]}>{t("recipes.manual_recipe")}</Text>
                  <Text style={[styles.addOptionSub, { color: subText }]}>
                    {t("recipes.manual_recipe_sub")}
                  </Text>
                </View>
                <MaterialIcons name="chevron-right" size={24} color={subText} />
              </TouchableOpacity>

              {/* Import from URL */}
              <TouchableOpacity
                style={styles.addOptionRow}
                onPress={() => {
                  setAddVisible(false);
                  setTimeout(() => setImportUrlVisible(true), 200);
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.addOptionEmoji}>🌐</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.addOptionText, { color: text }]}>{t("recipes.import_from_url")}</Text>
                  <Text style={[styles.addOptionSub, { color: subText }]}>
                    {t("recipes.import_desc")}
                  </Text>
                </View>
                <MaterialIcons name="chevron-right" size={24} color={subText} />
              </TouchableOpacity>

              {/* Import from Image */}
              <TouchableOpacity
                style={styles.addOptionRow}

                onPress={() => {
                  setAddVisible(false);
                  setTimeout(() => {
                    Alert.alert(t("common.coming_soon"), t("common.coming_soon_desc") || "Import from image is not yet available.");
                  }, 200);
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.addOptionEmoji}>📷</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.addOptionText, { color: text }]}>{t("recipes.import_from_image")}</Text>
                  <Text style={[styles.addOptionSub, { color: subText }]}>
                    {t("recipes.import_from_image_sub")}
                  </Text>
                </View>
                <MaterialIcons name="chevron-right" size={24} color={subText} />
              </TouchableOpacity>

              {/* Import from File/App */}
              <TouchableOpacity
                style={styles.addOptionRow}
                onPress={() => {
                  setAddVisible(false);
                  setTimeout(() => {
                    Alert.alert(t("common.coming_soon"), t("common.coming_soon_desc") || "Import from file or app is not yet available.");
                  }, 200);
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.addOptionEmoji}>📁</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.addOptionText, { color: text }]}>{t("recipes.import_from_file")}</Text>
                  <Text style={[styles.addOptionSub, { color: subText }]}>
                    {t("recipes.import_from_file_sub")}
                  </Text>
                </View>
                <MaterialIcons name="chevron-right" size={24} color={subText} />
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Import from URL Modal */}
      <Modal visible={importUrlVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => {
            if (!importLoading) {
              setImportUrlVisible(false);
              setImportUrl("");
              setImportError("");
            }
          }}
        >
          <View style={[styles.modalContent, { backgroundColor: card, width: 340 }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: text }]}>{t("recipes.import_from_url")}</Text>
              <TouchableOpacity
                onPress={() => {
                  if (!importLoading) {
                    setImportUrlVisible(false);
                    setImportUrl("");
                    setImportError("");
                  }
                }}
              >
                <MaterialIcons name="close" size={24} color="#293a53" />
              </TouchableOpacity>
            </View>
            <TextInput
              style={[
                styles.input,
                { borderColor: border, color: text, marginBottom: 8 },
              ]}
              placeholder={t("recipes.paste_url")}
              placeholderTextColor={subText}
              value={importUrl}
              onChangeText={setImportUrl}
              editable={!importLoading}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            {importError ? (
              <Text style={{ color: "#E27D60", marginBottom: 8 }}>{importError}</Text>
            ) : null}
            <TouchableOpacity
              style={[
                {
                  backgroundColor: "#E27D60",
                  borderRadius: 8,
                  paddingVertical: 12,
                  alignItems: "center",
                  marginTop: 4,
                  opacity: importLoading ? 0.7 : 1,
                },
              ]}
              disabled={importLoading}
              onPress={async () => {
                setImportError("");
                if (!importUrl.trim() || !/^https?:\/\/.+/i.test(importUrl.trim())) {
                  setImportError(t("recipes.invalid_url"));
                  return;
                }
                setImportLoading(true);
                try {
                  const apiUrl = `${backendUrl}/importRecipeFromUrl`;
                  const res = await fetch(apiUrl, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "x-app-env": appEnv,
                    },
                    body: JSON.stringify({ url: importUrl.trim() }),
                  });
                  let data;
                  try {
                    data = await res.json();
                  } catch (jsonErr) {
                    // Could not parse server response
                    let errMsg = t("recipes.invalid_import");
                    setImportError(errMsg);
                    setImportLoading(false);
                    return;
                  }
                  if (!res.ok) {
                    let errMsg = t("recipes.invalid_import");
                    try {
                      if (data && data.errorCode) {
                        if (data.errorCode === "INVALID_RECIPE_STRUCTURE") {
                          errMsg = t("recipes.invalid_import");
                        }
                      } else if (data && data.error) {
                        errMsg = data.error;
                      }
                    } catch (_) {
                      // ignore JSON parse errors
                    }
                    setImportError(errMsg);
                    setImportLoading(false);
                    return;
                  }
                  if (!data || !data.recipe) {
                    let errMsg = t("recipes.invalid_import");
                    setImportError(errMsg);
                    setImportLoading(false);
                    return;
                  }
                  // Validate minimal fields (title, ingredients, steps)
                  const r = data.recipe;
                  if (!r.title || !r.ingredients || !r.steps) {
                    let errMsg = t("recipes.invalid_import");
                    setImportError(errMsg);
                    setImportLoading(false);
                    return;
                  }
                  // Save to AsyncStorage
                  const storedRecipes = await AsyncStorage.getItem("recipes");
                  const recipesArr = storedRecipes ? JSON.parse(storedRecipes) : [];
                  // Add cookbook id to cookbooks array
                  const now = Date.now();
                  const newRecipe = {
                    ...r,
                    id:
                      r.id ||
                      "r-" +
                        Math.random().toString(36).slice(2) +
                        Date.now().toString(36),
                    cookbooks: [id],
                    createdAt: now,
                    updatedAt: now,
                    isDeleted: false,
                  };
                  recipesArr.unshift(newRecipe);

                  // Persist legacy snapshot for UI screens
                  await AsyncStorage.setItem("recipes", JSON.stringify(recipesArr));

                  // Save via sync engine + mark dirty + trigger remote sync
                  const anyEngine = syncEngine as any;
                  try {
                    if (typeof anyEngine.saveLocalRecipesSnapshot === "function") {
                      await anyEngine.saveLocalRecipesSnapshot(recipesArr);
                    }
                    if (typeof anyEngine.markRecipeDirty === "function") {
                      await anyEngine.markRecipeDirty(newRecipe);
                    }
                    // Trigger a full sync NOW.
                    if (typeof anyEngine.forceSyncNow === "function") {
                      await anyEngine.forceSyncNow("manual");
                    } else if (typeof anyEngine.syncAll === "function") {
                      try {
                        await anyEngine.syncAll("manual", { bypassThrottle: true });
                      } catch {
                        await anyEngine.syncAll("manual");
                      }
                    } else if (typeof anyEngine.requestSync === "function") {
                      anyEngine.requestSync("manual");
                    }
                  } catch (syncErr) {
                    console.warn(
                      "[Cookbook] sync after import-from-URL create failed",
                      syncErr
                    );
                  }

                  setRecipes((prev) => [newRecipe, ...prev]);
                  setImportLoading(false);
                  setImportUrlVisible(false);
                  setImportUrl("");
                  setImportError("");
                  setImportedRecipe(newRecipe);
                  setSuccessVisible(true);
                } catch (err: any) {
                  setImportLoading(false);
                  let msg = t("recipes.invalid_import");
                  if (err && err.message) msg = err.message;
                  setImportError(msg);
                }
              }}
            >
              {importLoading ? (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Ionicons name="reload" size={18} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={{ color: "#fff", fontWeight: "600" }}>{t("recipes.importing")}</Text>
                </View>
              ) : (
                <Text style={{ color: "#fff", fontWeight: "600" }}>{t("recipes.import_button")}</Text>
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
                <MaterialIcons name="close" size={24} color="#293a53" />
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
                      params: { from: `cookbook:${id}` },
                    });
                  }
                }}
                style={{ paddingHorizontal: 8, paddingVertical: 6 }}
              >
                <Text style={{ color: "#3b4a6b", fontWeight: "bold", fontSize: 15, textTransform: "uppercase" }}>
                  {t("recipes.open_recipe")}
                </Text>
              </TouchableOpacity>
            </View>
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
                  {
                    color: text,
                    flex: 1,
                    paddingRight: 12,
                  },
                ]}
                numberOfLines={2}
                ellipsizeMode="tail"
              >
                {t("recipes.delete_recipe_confirm")}
              </Text>
              <TouchableOpacity onPress={() => setDeleteTarget(null)}>
                <MaterialIcons
                  name="close"
                  size={24}
                  color={text}
                />
              </TouchableOpacity>
            </View>
            <Text style={{ color: subText, marginBottom: 18, fontSize: 15 }}>
              {t("recipes.delete_recipe_desc")}
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
  recipeCard: { flexDirection: "row", padding: 10 },
  recipeImage: { width: 80, height: 80, borderRadius: 12, marginRight: 12 },
  cardTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 4,
    flex: 1,
    flexShrink: 1,
    paddingRight: 10,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  deleteButton: {
    paddingLeft: 6,
    paddingTop: 2,
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
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center" },
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
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    marginRight: 8,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "#F5F5F5",
  },
  tagRow: {
    flexDirection: "row",
    marginTop: 6,
    flexWrap: "wrap",
    paddingRight: 3, // small right padding so last tag doesn't touch the edge
  },
  tagChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    marginRight: 8,
    marginBottom: 8,
  },
  tagText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#fff",
  },
  filterSectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginTop: 10,
    marginBottom: 6,
  },
  addOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: "#ececec",
    backgroundColor: "transparent",
  },
  addOptionEmoji: {
    fontSize: 26,
    marginRight: 14,
  },
  addOptionText: {
    fontSize: 16,
    fontWeight: "600",
  },
  addOptionSub: {
    fontSize: 13,
    color: "#888",
    marginTop: 2,
  },
});