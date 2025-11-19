import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeAuth,
  getReactNativePersistence,
} from "firebase/auth";
import ReactNativeAsyncStorage from "@react-native-async-storage/async-storage";
// Firestore imports removed
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyB9cZ8sU_9NAROg2kVFfN27wkhQwJuqF5E",
  authDomain: "recipeai-frontend.firebaseapp.com",
  projectId: "recipeai-frontend",
  storageBucket: "recipeai-frontend.firebasestorage.app",
  messagingSenderId: "742340260619",
  appId: "1:742340260619:web:1ec75777d245f7322ea80e",
  measurementId: "G-SBSFRPWREX",
};

// --- Initialize Firebase ---
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
console.log("🔥 Firebase initialized");

// --- Auth (React Native persistent) ---
const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(ReactNativeAsyncStorage),
});
console.log("✅ Auth initialized with React Native persistence");

// Firestore initialization removed

// --- Storage ---
const storage = getStorage(app);
console.log("✅ Storage initialized");

export { app, auth, storage };