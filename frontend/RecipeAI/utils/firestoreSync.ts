// import { db } from "../firebaseConfig";
// import { collection, getDocs, setDoc, doc } from "firebase/firestore";

export const saveRecipeToFirestore = async (uid: string, recipe: any) => {
  // if (!uid || !recipe?.id) return;
  try {
    console.log("Firestore sync is disabled: saveRecipeToFirestore not saving data.");
    // await setDoc(doc(db, "users", uid, "recipes", recipe.id), recipe);
  } catch (err) {
    // console.error("🔥 Error saving recipe to Firestore:", err);
  }
};

export const loadRecipesFromFirestore = async (uid: string) => {
  // if (!uid) return [];
  try {
    console.log("Firestore sync is disabled: loadRecipesFromFirestore not loading data.");
    return [];
    // const querySnapshot = await getDocs(collection(db, "users", uid, "recipes"));
    // return querySnapshot.docs.map(doc => doc.data());
  } catch (err) {
    // console.error("🔥 Error loading recipes from Firestore:", err);
    return [];
  }
};