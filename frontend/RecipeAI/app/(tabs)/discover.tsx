// app/(tabs)/discover.tsx
import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Image,
  TouchableOpacity,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import { useThemeColors } from "../../context/ThemeContext";
import AppCard from "../../components/AppCard";

// Import da imagem default
import defaultImage from "../../assets/default_recipe.png";

// Dummy recipes
const dummyRecipes = [
  {
    id: "1",
    title: "Spaghetti Carbonara",
    image: "https://picsum.photos/300/200?1",
    cookingTime: 25,
    difficulty: "Easy",
    cost: "Medium",
    tags: ["Italian", "Dinner"],
  },
  {
    id: "2",
    title: "Avocado Toast",
    image: "", // 🔹 sem imagem → vai cair no default
    cookingTime: 10,
    difficulty: "Easy",
    cost: "Cheap",
    tags: ["Vegan", "Breakfast"],
  },
  {
    id: "3",
    title: "Grilled Chicken Salad",
    image: "https://picsum.photos/300/200?3",
    cookingTime: 20,
    difficulty: "Medium",
    cost: "Cheap",
    tags: ["Healthy", "Lunch"],
  },
];

export default function Discover() {
  const { bg, text, subText, border, card } = useThemeColors();
  const [search, setSearch] = useState("");
  const router = useRouter();

  const getImage = (uri?: string) => {
    return uri && uri.trim() !== "" ? { uri } : defaultImage;
  };

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      <Stack.Screen options={{ title: "Discover" }} />

      {/* 🔍 Search Bar */}
      <TextInput
        style={[
          styles.searchInput,
          { borderColor: border, color: text, backgroundColor: card },
        ]}
        placeholder="Search recipes..."
        placeholderTextColor={subText}
        value={search}
        onChangeText={setSearch}
      />

      <ScrollView>
        {/* Trending */}
        <Text style={[styles.sectionTitle, { color: text }]}>🔥 Trending</Text>
        {dummyRecipes.map((recipe) => (
          <TouchableOpacity
            key={recipe.id}
            onPress={() =>
              router.push({
                pathname: `/recipe/${recipe.id}`,
                params: { recipe: JSON.stringify(recipe) },
              })
            }
          >
            <AppCard>
              <Image
                source={getImage(recipe.image)}
                style={styles.image}
                resizeMode="cover"
              />
              <Text style={[styles.cardTitle, { color: text }]}>{recipe.title}</Text>
              <View style={styles.quickInfo}>
                <Text style={{ color: subText }}>⏱ {recipe.cookingTime} min</Text>
                <Text style={{ color: subText }}>🎯 {recipe.difficulty}</Text>
                <Text style={{ color: subText }}>💰 {recipe.cost}</Text>
              </View>
              <View style={styles.tagsContainer}>
                {recipe.tags.slice(0, 2).map((tag, i) => (
                  <Text key={i} style={styles.tag}>
                    {tag}
                  </Text>
                ))}
              </View>
            </AppCard>
          </TouchableOpacity>
        ))}

        {/* Meal of the Week */}
        <Text style={[styles.sectionTitle, { color: text }]}>⭐ Meal of the Week</Text>
        <AppCard>
          <Image
            source={getImage("https://picsum.photos/300/200?4")}
            style={styles.image}
            resizeMode="cover"
          />
          <Text style={[styles.cardTitle, { color: text }]}>BBQ Ribs with Corn</Text>
          <View style={styles.quickInfo}>
            <Text style={{ color: subText }}>⏱ 90 min</Text>
            <Text style={{ color: subText }}>🎯 Hard</Text>
            <Text style={{ color: subText }}>💰 Expensive</Text>
          </View>
          <View style={styles.tagsContainer}>
            <Text style={styles.tag}>Dinner</Text>
            <Text style={styles.tag}>American</Text>
          </View>
        </AppCard>

        {/* Categories */}
        <Text style={[styles.sectionTitle, { color: text }]}>🍽 Categories</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginBottom: 20 }}
        >
          {["Breakfast", "Lunch", "Snacks", "Dinner", "Drinks"].map((cat) => (
            <View key={cat} style={[styles.categoryChip, { borderColor: border }]}>
              <Text style={{ color: text }}>{cat}</Text>
            </View>
          ))}
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  searchInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    marginBottom: 16,
  },
  sectionTitle: { fontSize: 20, fontWeight: "700", marginVertical: 12 },
  image: { width: "100%", height: 160, borderRadius: 12, marginBottom: 8 },
  cardTitle: { fontSize: 18, fontWeight: "bold", marginBottom: 6 },
  quickInfo: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  tagsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  tag: {
    backgroundColor: "#C2B2B4",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    fontSize: 12,
    marginRight: 6,
    marginBottom: 6,
    color: "#fff",
  },
  categoryChip: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 10,
  },
});