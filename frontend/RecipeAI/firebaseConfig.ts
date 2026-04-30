// Thin wrapper that re-exports the initialized Firebase instances
// from the root-level firebaseConfig.ts so there is a single
// source of truth for config and initialization.

import { Platform } from "react-native";
import { initializeApp, getApp, getApps, FirebaseApp } from "firebase/app";
import {
  Auth,
  getAuth,
  initializeAuth,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Firebase config for the recipeai-frontend project
// These values are safe to be in the client (they are not secrets).
// They are aligned with your google-services.json and backend .env.
const firebaseConfig = {
  apiKey: "AIzaSyDuPZ3__DSl0K1XPU6XivUHqVt1A5e-zr4",
  authDomain: "recipeai-frontend.firebaseapp.com",
  projectId: "recipeai-frontend",
  storageBucket: "recipeai-frontend.firebasestorage.app",
  messagingSenderId: "742340260619",
  appId: "1:742340260619:android:c618fa7607e607ad2ea80e",
};

// Ensure we only ever initialize the app once
let app: FirebaseApp;
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
  console.log("🔥 Firebase initialized");
} else {
  app = getApp();
  console.log("🔄 Firebase app already initialized, reusing instance");
}

// Initialize Auth with proper React Native persistence
// IMPORTANT: On React Native we must initialize Auth *with* AsyncStorage persistence
// before any code calls `getAuth(app)`, otherwise Auth will default to in-memory
// persistence and anonymous users will change on every cold start.
let auth: Auth;
if (Platform.OS === "web") {
  // On web we just use the default auth instance
  auth = getAuth(app);
} else {
  try {
    const authModule = require("firebase/auth") as {
      getReactNativePersistence?: (storage: typeof AsyncStorage) => unknown;
    };
    if (typeof authModule.getReactNativePersistence === "function") {
      console.log("🔥 Initializing Firebase Auth with React Native persistence");
      auth = initializeAuth(app, {
        persistence: authModule.getReactNativePersistence(AsyncStorage) as any,
      });
    } else {
      console.warn("⚠️ React Native Firebase persistence helper is unavailable in this build; falling back to default auth instance.");
      auth = getAuth(app);
    }
  } catch (e) {
    // If Auth was already initialized elsewhere, or persistence wiring is unavailable,
    // reuse the default instance so the app can still boot.
    auth = getAuth(app);
    console.log("🔄 Auth already initialized, reusing instance");
  }
}

const db = getFirestore(app);
const storage = getStorage(app);

export { app, auth, db, storage };
