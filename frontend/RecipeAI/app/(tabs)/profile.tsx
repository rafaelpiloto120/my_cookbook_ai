// app/(tabs)/profile.tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import * as ImagePicker from "expo-image-picker";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Switch,
  Modal,
  Pressable,
  TextInput,
  Image,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Alert,
  LayoutAnimation,
  UIManager,
} from "react-native";
// Enable LayoutAnimation on Android
if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { Stack, useRouter, useFocusEffect } from "expo-router";
import i18n from "../../i18n";
import { supportedLanguages, SupportedLanguage } from "../../i18n";
import { MaterialIcons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useThemeColors, useTheme } from "../../context/ThemeContext";
import Constants from "expo-constants";
import { useAuth } from "../../context/AuthContext";
import { useSyncEngine as useSyncEngineHook } from "../../lib/sync/SyncEngine";
import { getAuth, updateProfile, updatePassword } from "firebase/auth";
import { ref as storageRef, uploadString, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { saveUserPrefs, prefsEvents, PREFS_UPDATED } from "../../lib/prefs";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";

const PROFILE_KEY = "profile";

import { storage } from "../../firebaseConfig";

// Language options helper
function getLanguageLabelAndFlag(code: SupportedLanguage): { label: string; flag: string } {
  switch (code) {
    case "en":
      return { label: "English", flag: "🇬🇧" };
    case "es":
      return { label: "Español", flag: "🇪🇸" };
    case "pt":
      return { label: "Português (PT)", flag: "🇵🇹" };
    case "pt-BR":
      return { label: "Português (BR)", flag: "🇧🇷" };
    case "fr":
      return { label: "Français", flag: "🇫🇷" };
    case "de":
      return { label: "Deutsch", flag: "🇩🇪" };
    default:
      return { label: code, flag: "" };
  }
}
const languageOptions = supportedLanguages.map(code => ({
  code,
  ...getLanguageLabelAndFlag(code as SupportedLanguage),
}));

// Measurement system type
type MeasurementSystem = "US" | "Metric";

export default function Profile() {
  const { bg, text, card, subText, border } = useThemeColors();
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();
  const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "local";
  // Show destructive/dev-only controls only in dev builds or when explicitly enabled.
  const SHOW_RESET = __DEV__ || process.env.EXPO_PUBLIC_SHOW_RESET === "1";

  // Router and real authentication context (needed early for cookie balance)
  const router = useRouter();
  const { user, logout } = useAuth();
  const auth = getAuth();

  // --- Cookies economy (balance UI) ---
  const backendUrl = process.env.EXPO_PUBLIC_API_URL;
  const [cookieBalance, setCookieBalance] = useState<number | null>(null);
  const [cookieLoading, setCookieLoading] = useState(false);
  const [cookieInfoVisible, setCookieInfoVisible] = useState(false);
  const cookieBalanceRef = useRef<number | null>(null);
  // ✅ `auth.currentUser` isn't reactive, so we track uid in state to refresh economy correctly.
  const [economyUid, setEconomyUid] = useState<string | null>(auth.currentUser?.uid ?? null);

  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => {
      setEconomyUid(u?.uid ?? null);
    });
    return () => unsub();
  }, [auth]);

  useEffect(() => {
    cookieBalanceRef.current = cookieBalance;
  }, [cookieBalance]);


  const loadCookieBalance = useCallback(async () => {
    const cacheKey = `economy_cookie_balance_${economyUid || "anon"}`;
    // If backend is not configured, fallback to cached value only.
    if (!backendUrl) {
      try {
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached != null && !Number.isNaN(Number(cached))) {
          setCookieBalance(Number(cached));
        }
      } catch {
        // ignore
      }
      return;
    }

    setCookieLoading(true);
    try {
      // Economy is keyed by Firebase Auth uid on the backend.
      // Always send an ID token so the backend can resolve `uid` and read/write
      // `users/{uid}/economy/default`.
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : undefined;
      const headers: Record<string, string> = {};
      if (idToken) headers.Authorization = `Bearer ${idToken}`;

      // Try GET first; fallback to POST if GET is not supported.
      let res: Response | null = null;
      try {
        const qs = `?env=${encodeURIComponent(appEnv)}`;
        res = await fetch(`${backendUrl}/economy/balance${qs}`, {
          method: "GET",
          headers,
        });
      } catch {
        res = null;
      }

      if (!res || res.status === 404 || res.status === 405) {
        res = await fetch(`${backendUrl}/economy/balance`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ env: appEnv }),
        });
      }

      if (!res.ok) {
        // Helpful debug: auth issues should show up here.
        const bodyText = await res.text().catch(() => "");
        throw new Error(`economy/balance status ${res.status} ${bodyText}`);
      }

      const data = await res.json().catch(() => ({}));
      const next =
        typeof (data as any)?.balance === "number"
          ? (data as any).balance
          : typeof (data as any)?.remaining === "number"
            ? (data as any).remaining
            : null;

      if (typeof next === "number") {
        setCookieBalance(next);
        try {
          await AsyncStorage.setItem(cacheKey, String(next));
        } catch {
          // ignore
        }
      }
    } catch (e) {
      // fallback to cache
      try {
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached != null && !Number.isNaN(Number(cached))) {
          setCookieBalance(Number(cached));
        }
      } catch {
        // ignore
      }
    } finally {
      setCookieLoading(false);
    }
  }, [backendUrl, appEnv, auth, economyUid, t]);

  // Refresh balance when the auth uid changes (e.g., anon sign-in completes).
  useEffect(() => {
    loadCookieBalance();
  }, [economyUid, loadCookieBalance]);

  // Also refresh whenever the Profile tab/screen becomes focused.
  // This is the main mechanism to reflect cookie deductions made in other tabs/screens.
  useFocusEffect(
    useCallback(() => {
      loadCookieBalance();
      return () => {
        // no-op
      };
    }, [loadCookieBalance])
  );

  // Dietary and avoid options from i18n (filter out "None" option immediately)
  const rawDietaryOptions = t("dietary", { returnObjects: true }) as any;
  const rawAvoidOptions = t("avoid", { returnObjects: true }) as any;

  const allDietaryOptions: Record<string, { label: string; icon: string }> =
    rawDietaryOptions && typeof rawDietaryOptions === "object" && !Array.isArray(rawDietaryOptions)
      ? rawDietaryOptions
      : {};

  const allAvoidOptions: Record<string, { label: string; icon: string }> =
    rawAvoidOptions && typeof rawAvoidOptions === "object" && !Array.isArray(rawAvoidOptions)
      ? rawAvoidOptions
      : {};

  const dietaryOptions = Object.fromEntries(
    Object.entries(allDietaryOptions).filter(([key]) => key !== "dietary.none" && key.toLowerCase() !== "none")
  );
  const avoidOptions = Object.fromEntries(
    Object.entries(allAvoidOptions).filter(([key]) => key !== "avoid.none" && key.toLowerCase() !== "none")
  );

  const [darkMode, setDarkMode] = useState(false);
  const [measurement, setMeasurement] = useState<MeasurementSystem>("Metric");
  // Set default to empty arrays
  const [dietary, setDietary] = useState<string[]>([]);
  const [avoid, setAvoid] = useState<string[]>([]);
  const [avoidOther, setAvoidOther] = useState<string>("");
  const [isEditingAvoidOther, setIsEditingAvoidOther] = useState(false);
  const [modalDietary, setModalDietary] = useState(false);
  const [modalAvoid, setModalAvoid] = useState(false);
  const [language, setLanguage] = useState<SupportedLanguage>("en");
  const [modalLanguage, setModalLanguage] = useState(false);
  const [modalAppInfo, setModalAppInfo] = useState(false);
  const syncEngine = useSyncEngineHook();
  const isAnon = !!auth.currentUser?.isAnonymous;
  // Scroll ref to ensure focused inputs are always visible
  const scrollRef = useRef<ScrollView | null>(null);

  // Ref to force focus + soft keyboard on Android for the display name field
  const displayNameRef = useRef<TextInput | null>(null);

  // Edit Profile Modal state
  const [modalEditProfile, setModalEditProfile] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editPhotoURL, setEditPhotoURL] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");
  const [localPhotoUri, setLocalPhotoUri] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  // Track when we've loaded prefs from storage so we don't overwrite them immediately
  const [prefsHydrated, setPrefsHydrated] = useState(false);

  // Debounced sync trigger for preferences changes.
  // We mark preferences as dirty in the sync engine and then request a full sync.
  // This mirrors the snapshot->sync approach used in History.tsx for cookbooks.
  const prefsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildPreferencesPayload = useCallback(() => {
    return {
      userDietary: dietary,
      dietary, // legacy compatibility
      userAvoid: avoid,
      avoid, // legacy compatibility
      userAvoidOther: avoidOther,
      userMeasurement: measurement === "US" ? "imperial" : "metric",
      themeMode: darkMode ? "dark" : "light",
      userLanguage: language,
    };
  }, [dietary, avoid, avoidOther, measurement, darkMode, language]);

  const requestPreferencesSync = useCallback(
    (opts: { reason?: string; debounceMs?: number } = {}) => {
      const { reason = "prefs-change", debounceMs = 0 } = opts;
      if (!syncEngine) {
        console.warn("[Profile] syncEngine is not available; cannot sync preferences");
        return;
      }

      const run = async () => {
        try {
          const payload = buildPreferencesPayload();

          // 1) Mark dirty so PreferencesSync has something to push.
          if (typeof (syncEngine as any).markPreferencesDirty === "function") {
            await (syncEngine as any).markPreferencesDirty(payload);
          }

          // 2) Trigger sync. Prefer requestSync (non-blocking) to avoid UI stalls.
          if (typeof (syncEngine as any).requestSync === "function") {
            (syncEngine as any).requestSync("manual");
          } else if (typeof (syncEngine as any).syncAll === "function") {
            (syncEngine as any).syncAll("manual", { bypassThrottle: true });
          }

          if (__DEV__) console.log("[Profile] preferences sync requested", { reason });
        } catch (err) {
          console.warn("[Profile] requestPreferencesSync failed", err);
        }
      };

      if (prefsSyncTimerRef.current) {
        clearTimeout(prefsSyncTimerRef.current);
        prefsSyncTimerRef.current = null;
      }

      if (debounceMs > 0) {
        prefsSyncTimerRef.current = setTimeout(() => {
          prefsSyncTimerRef.current = null;
          run();
        }, debounceMs);
      } else {
        run();
      }
    },
    [syncEngine, buildPreferencesPayload]
  );

  // Cleanup any pending timer on unmount
  useEffect(() => {
    return () => {
      if (prefsSyncTimerRef.current) {
        clearTimeout(prefsSyncTimerRef.current);
        prefsSyncTimerRef.current = null;
      }
    };
  }, []);

  // Contact Support modal state
  const [contactModalVisible, setContactModalVisible] = useState(false);
  const [contactSubject, setContactSubject] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactMessage, setContactMessage] = useState("");
  const [contactError, setContactError] = useState("");
  const [contactSending, setContactSending] = useState(false);

  // FAQ Modal state
  const [faqModalVisible, setFaqModalVisible] = useState(false);
  const [faqSearchQuery, setFaqSearchQuery] = useState("");
  const [expandedFaqId, setExpandedFaqId] = useState<string | null>(null);

  // Handles picking an image and sets a local URI (editPhotoURL)
  const pickImage = async () => {
    try {
      setEditError("");

      const current = await ImagePicker.getMediaLibraryPermissionsAsync();
      let granted = current.granted;
      if (!granted) {
        const asked = await ImagePicker.requestMediaLibraryPermissionsAsync();
        granted = asked.granted;
      }
      if (!granted) {
        setEditError(t("profile.photo_update_error") || "Permission to access gallery is required!");
        return;
      }

      const mt = (ImagePicker as any).MediaType;
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        aspect: [1, 1],
        quality: 0.8,
        ...(mt && mt.Images ? { mediaTypes: mt.Images } : {}),
      });

      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset?.uri) {
        setEditError(t("profile.photo_update_error") || "Could not read selected image.");
        return;
      }

      // Optionally compress large images before upload to save bandwidth and storage
      const compressedUri = await compressImageIfNeeded(asset.uri);
      setEditPhotoURL(compressedUri);
    } catch (error) {
      console.warn("[ImagePicker] open error:", error);
      setEditError(t("profile.photo_picker_error") || "Failed to open image picker.");
    }
  };

  const removeImage = () => {
    setEditPhotoURL("");
    setLocalPhotoUri(null);
  };

  // When opening modal, prefill fields
  useEffect(() => {
    if (modalEditProfile && user) {
      setEditDisplayName(user.displayName || user.name || "");
      setEditPhotoURL(user.photoURL || "");
      setEditPassword("");
      setEditError("");
    }
  }, [modalEditProfile, user]);


  // Treat any non-http(s) URI as local (e.g., file:// or content:// on Android)
  function isLocalUri(uri: string) {
    return uri && !/^https?:\/\//i.test(uri);
  }

  // Add cache-busting to a URL (for profile images)
  function addCacheBust(url: string | null | undefined): string | null {
    if (!url) return null;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}cb=${Date.now()}`;
  }


  // Ensure we have a file:// URI for upload (copy content:// -> cacheDirectory), preserving extension
  async function ensureFileUriForUpload(srcUri: string): Promise<string> {
    if (srcUri.startsWith("file://")) return srcUri;
    const lower = (srcUri || "").toLowerCase();
    const inferredExt = lower.endsWith(".png") ? ".png" : lower.endsWith(".webp") ? ".webp" : ".jpg";
    const target = FileSystem.cacheDirectory + `profile-avatar-upload${inferredExt}`;
    try {
      await FileSystem.copyAsync({ from: srcUri, to: target });
      return target;
    } catch (e) {
      console.warn("[Profile] ensureFileUriForUpload copy failed, using original uri:", e);
      return srcUri;
    }
  }

  // Optionally compress large images on the client before uploading
  async function compressImageIfNeeded(uri: string): Promise<string> {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      const size = typeof info.size === "number" ? info.size : 0;
      const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB

      // If we know the file is already under the limit, keep as-is
      if (size > 0 && size <= MAX_IMAGE_BYTES) {
        return uri;
      }

      // Resize to a reasonable max width and compress JPEG
      const result = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: 1600 } }],
        {
          compress: 0.75,
          format: ImageManipulator.SaveFormat.JPEG,
        }
      );

      return result.uri || uri;
    } catch (e) {
      console.warn("[Profile] compressImageIfNeeded failed:", e);
      return uri;
    }
  }

  // Delete profile avatar from Firebase Storage (tries common extensions)
  async function deleteProfileImageFromStorage(uid: string) {
    try {
      const exts: Array<"jpg" | "png" | "webp"> = ["jpg", "png", "webp"];
      for (const ext of exts) {
        try {
          const imgRef = storageRef(storage, `users/${uid}/profile/avatar.${ext}`);
          await deleteObject(imgRef);
        } catch (e) {
          // ignore not-found and continue
        }
      }
    } catch {
      // swallow any errors; deletion is best-effort
    }
  }

  // Upload via backend to avoid RN/Hermes Blob issues. The server should write to Firebase Storage using Admin SDK and return a public URL.
  async function uploadProfileImageViaBackend(localUri: string, uid: string): Promise<string> {
    const apiUrl = `${process.env.EXPO_PUBLIC_API_URL}/uploadProfilePhoto`;
    // Ensure file:// path
    const fileUri = await ensureFileUriForUpload(localUri);

    // Infer filename + type from uri
    const lower = (fileUri || "").toLowerCase();
    let ext = lower.endsWith(".png") ? "png" : lower.endsWith(".webp") ? "webp" : "jpg";
    const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const name = `avatar.${ext}`;

    // Get Firebase ID token to authorize the backend
    const idToken = await getAuth().currentUser?.getIdToken?.();
    if (!idToken) throw new Error("Not authenticated");

    const task = FileSystem.createUploadTask(
      apiUrl,
      fileUri,
      {
        httpMethod: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: "file",
        parameters: {
          uid,
          path: `users/${uid}/profile/${name}`,
        },
        mimeType: contentType,
      }
    );

    const resp = await task.uploadAsync();
    if (!resp || !(resp.status >= 200 && resp.status < 300)) {
      console.warn("[Profile] Backend upload failed", resp?.status, resp?.body);
      throw new Error("Backend upload failed");
    }
    let json: any = {};
    try { json = JSON.parse(resp.body); } catch { }
    if (!json?.url) throw new Error("Backend did not return a URL");
    return json.url as string;
  }

  // Upload image using backend, falling back to REST and SDK if needed
  async function uploadProfileImageAsync(localUri: string, uid: string): Promise<string> {
    // 1) Try backend-assisted upload (most reliable for RN/Hermes)
    try {
      if (__DEV__) console.log("[Profile] Trying backend upload...");
      const url = await uploadProfileImageViaBackend(localUri, uid);
      setUploadProgress(null);
      return url;
    } catch (e) {
      console.warn("[Profile] Backend upload failed, trying REST/SDK:", e);
    }

    // 2) Try REST (v0) with Firebase/Bearer retry (existing code)
    try {
      const fileUri = await ensureFileUriForUpload(localUri);
      const lower = (fileUri || "").toLowerCase();
      let ext: "jpg" | "png" | "webp" = lower.endsWith(".png") ? "png" : lower.endsWith(".webp") ? "webp" : "jpg";
      const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const bucket = storage.app.options.storageBucket;
      const objectPath = `users/${uid}/profile/avatar.${ext}`;
      const idToken = await getAuth().currentUser?.getIdToken?.();
      if (!idToken) throw new Error("Not authenticated");
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;

      if (__DEV__) console.log("[Profile] REST attempt A (Firebase token)");
      const attempt = async (authHeaderValue: string) => {
        const task = FileSystem.createUploadTask(
          url,
          fileUri,
          {
            httpMethod: "POST",
            headers: { Authorization: authHeaderValue, "Content-Type": contentType },
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          },
          (progress) => {
            if (progress && progress.totalBytesExpectedToSend) {
              setUploadProgress(progress.totalBytesSent / progress.totalBytesExpectedToSend);
            }
          }
        );
        return task.uploadAsync();
      };

      let resp = await attempt(`Firebase ${idToken}`);
      if (!resp || resp.status === 401 || resp.status === 403 || resp.status === 404) {
        if (__DEV__) {
          console.warn("[Profile] REST attempt A failed", resp?.status, resp?.body);
          console.log("[Profile] REST attempt B (Bearer token)");
        }
        resp = await attempt(`Bearer ${idToken}`);
      }

      setUploadProgress(null);
      if (!resp || !(resp.status >= 200 && resp.status < 300)) {
        console.warn("[Profile] REST upload failed", resp?.status, resp?.body);
        throw new Error(`REST upload failed: ${resp?.status}`);
      }

      let json: any = {};
      try { json = JSON.parse(resp.body); } catch { }
      const token = json?.downloadTokens;
      const dl = token
        ? `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`
        : `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
      return dl;
    } catch (restErr) {
      console.warn("[Profile] REST path failed, falling back to SDK uploadBytes:", restErr);
    }

    // 3) Fallback SDK uploadBytes
    try {
      const fileUri = await ensureFileUriForUpload(localUri);
      const res = await fetch(fileUri);
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const lower = (fileUri || "").toLowerCase();
      let ext: "jpg" | "png" | "webp" = lower.endsWith(".png") ? "png" : lower.endsWith(".webp") ? "webp" : "jpg";
      const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const imageRef = storageRef(storage, `users/${uid}/profile/avatar.${ext}`);
      await uploadBytes(imageRef, bytes, { contentType });
      const url = await getDownloadURL(imageRef);
      setUploadProgress(null);
      return url;
    } catch (e) {
      setUploadProgress(null);
      console.warn("[Profile] uploadBytes failed:", e);
      throw new Error("Failed to upload profile image. [E-UPLOAD-BYTES]");
    }
  }

  // DEV-only: sanity check Storage by uploading a tiny text file
  async function testStorageWrite(uid?: string) {
    try {
      if (!uid) {
        console.warn("[StorageTest] No UID, skipping.");
        return;
      }
      const ts = Date.now();
      const pingRef = storageRef(storage, `users/${uid}/_ping-${ts}.txt`);
      const payload = `ping ${ts}`;
      await uploadString(pingRef, payload, "raw", { contentType: "text/plain" });
      const url = await getDownloadURL(pingRef);
      console.log("[StorageTest] OK, URL:", url);
    } catch (e) {
      try {
        console.warn(
          "[StorageTest] FAILED",
          e && typeof e === "object" ? JSON.stringify(e, Object.getOwnPropertyNames(e)) : String(e)
        );
        // @ts-ignore
        if ((e as any)?.serverResponse) {
          // @ts-ignore
          console.warn("[StorageTest] serverResponse:", (e as any).serverResponse);
        }
      } catch { }
    }
  }

  // Save handler for Edit Profile
  const handleSaveProfile = async () => {
    setEditLoading(true);
    setEditError("");
    // If a display name was set before, do not allow clearing it to empty.
    const previouslyHadDisplayName = !!(auth.currentUser?.displayName && auth.currentUser.displayName.trim().length > 0);
    if (previouslyHadDisplayName && editDisplayName.trim().length === 0) {
      setEditError(t("profile.display_name_required") || "Display name is required.");
      setEditLoading(false);
      return;
    }
    try {
      if (auth.currentUser) {
        let newPhotoURL = editPhotoURL;

        // If local path, upload to Firebase Storage
        if (editPhotoURL && typeof editPhotoURL === "string" && isLocalUri(editPhotoURL)) {
          newPhotoURL = await uploadProfileImageAsync(editPhotoURL, auth.currentUser.uid);
        }

        // Add cache-busting so React Native doesn't reuse the old cached image
        if (newPhotoURL && typeof newPhotoURL === "string") {
          const busted = addCacheBust(newPhotoURL);
          if (busted) {
            newPhotoURL = busted;
            setEditPhotoURL(busted);
          }
        }

        // Only update displayName/photoURL if changed
        const normalizedDisplayName =
          editDisplayName.trim() === "" ? null : editDisplayName.trim();
        const normalizedPhotoURL =
          newPhotoURL && newPhotoURL.trim() !== "" ? newPhotoURL.trim() : null;

        const didChangeName = normalizedDisplayName !== (auth.currentUser.displayName || null);
        const didChangePhoto = (normalizedPhotoURL || null) !== (auth.currentUser.photoURL || null);

        // If photo is being cleared, delete from Storage and force-clear Auth photoURL
        if (!normalizedPhotoURL && (auth.currentUser.photoURL || user.photoURL)) {
          try {
            await deleteProfileImageFromStorage(auth.currentUser.uid);
          } catch { }
          try {
            // Some environments ignore `null` for clearing; try empty string first
            await updateProfile(auth.currentUser, {
              displayName: normalizedDisplayName,
              photoURL: "" as any,
            });
            await auth.currentUser.reload();
          } catch { }
          try {
            if (auth.currentUser.photoURL) {
              // Fallback: explicitly set null if empty string didn't clear
              await updateProfile(auth.currentUser, {
                displayName: normalizedDisplayName,
                photoURL: null as unknown as string,
              });
              await auth.currentUser.reload();
            }
          } catch { }
        }

        if (didChangeName || didChangePhoto) {
          // Normal update path (will set URL or leave it null if cleared above)
          await updateProfile(auth.currentUser, {
            displayName: normalizedDisplayName,
            photoURL: normalizedPhotoURL ?? auth.currentUser.photoURL ?? null as unknown as string,
          });
          await auth.currentUser.reload();
        } else {
          await auth.currentUser.reload();
        }

        // Reflect latest values in UI
        setEditDisplayName(auth.currentUser.displayName || "");
        setModalEditProfile(false);
        if (!normalizedPhotoURL) {
          setLocalPhotoUri(null);
        }

        // Persist local/remote photo references for offline fallback
        try {
          const profileLocal = {
            // After a successful upload we prefer the remote URL.
            // You can later extend this to keep a proper offline copy if desired.
            photoUriLocal: null,
            photoUrlRemote: normalizedPhotoURL || null,
          };
          await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profileLocal));
          setLocalPhotoUri(profileLocal.photoUriLocal);
        } catch { }

        // Password update (optional)
        if (editPassword && editPassword.length >= 6) {
          try {
            await updatePassword(auth.currentUser, editPassword);
          } catch (e: any) {
            if (e?.code === "auth/requires-recent-login") {
              setEditError(t("auth.requires_recent_login") || "For security, please re-authenticate before changing your password.");
            } else {
              const rawMsg =
                (e?.code ? `${e.code}: ` : "") +
                (typeof e?.message === "string" ? e.message : "");
              setEditError(
                rawMsg?.replace("Firebase:", "").trim() ||
                t("profile.edit_error") ||
                "Failed to update profile."
              );
            }
            setEditLoading(false);
            return;
          }
        }
      }
    } catch (err: any) {
      const rawMsg =
        (err?.code ? `${err.code}: ` : "") +
        (typeof err?.message === "string" ? err.message : "");
      setEditError(
        rawMsg?.replace("Firebase:", "").trim() ||
        t("profile.edit_error") ||
        "Failed to update profile."
      );
      console.warn("[Profile] Save error:", err);
      setEditLoading(false);
      return;
    }
    setEditLoading(false);
  };

  // Helper for user displayName
  function getDisplayName(u: any) {
    return u?.displayName || u?.name || "";
  }

  // Load preferences from AsyncStorage
  useEffect(() => {
    (async () => {
      const [
        storedDietary,
        storedAvoid,
        storedMeasurement,
        storedTheme,
        storedLanguage,
        storedAvoidOther,
        storedMeasureSystem,
        storedThemeMode,
      ] = await Promise.all([
        AsyncStorage.getItem("dietary"),
        AsyncStorage.getItem("avoid"),
        AsyncStorage.getItem("measurement"),
        AsyncStorage.getItem("theme"),
        AsyncStorage.getItem("userLanguage"),
        AsyncStorage.getItem("avoidOther"),
        AsyncStorage.getItem("measureSystem"),
        AsyncStorage.getItem("themeMode"),
      ]);

      // Default to empty array if parse fails or value is null
      let parsedDietary: string[] = [];
      let parsedAvoid: string[] = [];

      try {
        if (storedDietary) {
          const val = JSON.parse(storedDietary);
          parsedDietary = Array.isArray(val) ? val : [];
        }
      } catch {
        parsedDietary = [];
      }
      try {
        if (storedAvoid) {
          const val = JSON.parse(storedAvoid);
          parsedAvoid = Array.isArray(val) ? val : [];
        }
      } catch {
        parsedAvoid = [];
      }

      // Filter against valid option keys, but only if the dictionaries are loaded.
      // When the screen mounts before i18n finishes loading, dietaryOptions/avoidOptions
      // can be empty; in that case, we keep whatever is stored and avoid wiping prefs.
      let filteredDietary = parsedDietary;
      let filteredAvoid = parsedAvoid;

      const dietaryKeys = Object.keys(dietaryOptions);
      const avoidKeys = Object.keys(avoidOptions);

      if (dietaryKeys.length > 0) {
        const validDietaryKeys = new Set(dietaryKeys);
        filteredDietary = parsedDietary.filter((d) => validDietaryKeys.has(d));
      }

      if (avoidKeys.length > 0) {
        const validAvoidKeys = new Set(avoidKeys);
        filteredAvoid = parsedAvoid.filter((a) => validAvoidKeys.has(a));
      }

      // Persist cleaned arrays to AsyncStorage to clear legacy "none" / prefixed keys
      await AsyncStorage.setItem("dietary", JSON.stringify(filteredDietary));
      await AsyncStorage.setItem("avoid", JSON.stringify(filteredAvoid));

      // Apply to state
      setDietary(filteredDietary);
      setAvoid(filteredAvoid);

      // Measurement: accept both Profile-style ("US"/"Metric") and onboarding-style ("imperial"/"metric")
      const measurementSource = storedMeasurement || storedMeasureSystem;
      if (measurementSource) {
        if (measurementSource === "US" || measurementSource === "Metric") {
          setMeasurement(measurementSource as MeasurementSystem);
        } else if (measurementSource === "imperial") {
          setMeasurement("US");
        } else {
          // "metric" or anything else defaults to Metric
          setMeasurement("Metric");
        }
      } else {
        setMeasurement("Metric");
      }

      // Theme: accept both "theme" and "themeMode"
      const themeSource = storedTheme || storedThemeMode;
      if (themeSource) {
        setDarkMode(themeSource === "dark");
      }

      // Language
      if (storedLanguage) {
        const validLanguage = supportedLanguages.includes(storedLanguage as SupportedLanguage)
          ? (storedLanguage as SupportedLanguage)
          : "en";
        setLanguage(validLanguage);
        i18n.changeLanguage(validLanguage);
      } else {
        setLanguage("en");
        i18n.changeLanguage("en");
      }

      if (storedAvoidOther) {
        setAvoidOther(storedAvoidOther);
      }
      // Mark prefs as hydrated so later effects can safely persist changes
      setPrefsHydrated(true);
    })();
  }, []);

  // Load local photo URI from AsyncStorage on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PROFILE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.photoUriLocal && typeof parsed.photoUriLocal === "string") {
            setLocalPhotoUri(parsed.photoUriLocal);
          }
        }
      } catch { }
    })();
  }, []);

  // Persist preferences
  useEffect(() => {
    if (!prefsHydrated) return;

    // Persist to central prefs (used by other screens)
    // Send both userDietary and dietary for backwards compatibility.
    saveUserPrefs({ userDietary: dietary, dietary });

    // ALSO persist to the legacy AsyncStorage keys that this screen hydrates from
    // so selections survive app restarts even if other code reads these keys.
    try {
      AsyncStorage.setItem("dietary", JSON.stringify(dietary || []));
    } catch {
      // ignore
    }

    requestPreferencesSync({ reason: "prefs-change", debounceMs: 250 });
  }, [dietary, prefsHydrated]);
  useEffect(() => {
    if (!prefsHydrated) return;

    // Persist to central prefs (used by other screens)
    // Send both userAvoid and avoid for backwards compatibility.
    saveUserPrefs({ userAvoid: avoid, avoid });

    // ALSO persist to the legacy AsyncStorage keys that this screen hydrates from
    // so selections survive app restarts.
    try {
      AsyncStorage.setItem("avoid", JSON.stringify(avoid || []));
    } catch {
      // ignore
    }

    requestPreferencesSync({ reason: "prefs-change", debounceMs: 250 });
  }, [avoid, prefsHydrated]);
  useEffect(() => {
    if (!prefsHydrated) return;
    saveUserPrefs({ userMeasurement: measurement === "US" ? "imperial" : "metric" });
    requestPreferencesSync({ reason: "prefs-change", debounceMs: 250 });
  }, [measurement, prefsHydrated]);
  useEffect(() => {
    if (!prefsHydrated) return;
    // Persist to central prefs (for AI Kitchen, etc.)
    saveUserPrefs({ userAvoidOther: avoidOther });
    // Also persist directly to AsyncStorage so reloads keep the text
    try {
      AsyncStorage.setItem("avoidOther", avoidOther || "");
    } catch { }
    requestPreferencesSync({ reason: "prefs-change", debounceMs: 900 });
  }, [avoidOther, prefsHydrated]);

  // Theme toggle integration
  // Theme toggle integration
  useEffect(() => {
    if (!prefsHydrated) return;

    const mode = darkMode ? "dark" : "light";
    AsyncStorage.setItem("theme", mode);
    saveUserPrefs({ themeMode: mode });
    requestPreferencesSync({ reason: "prefs-change", debounceMs: 250 });

    // IMPORTANT: do not call toggleTheme() here.
    // ThemeContext should be toggled only from the user action handler to avoid loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [darkMode, prefsHydrated]);

  // Language persist
  useEffect(() => {
    if (!prefsHydrated) return;
    AsyncStorage.setItem("userLanguage", language as SupportedLanguage);
    saveUserPrefs({ userLanguage: language });
    requestPreferencesSync({ reason: "prefs-change", debounceMs: 250 });
  }, [language, prefsHydrated]);

  // Reflect changes coming from onboarding (or anywhere else) instantly
  useEffect(() => {
    const onPrefs = (changed: any) => {
      if (changed.userLanguage !== undefined) {
        const lng = changed.userLanguage as SupportedLanguage;
        if (lng && lng !== language) {
          setLanguage(lng);
          i18n.changeLanguage(lng);
        }
      }

      // Accept both "userDietary" (new) and "dietary" (legacy) from prefs
      const dietaryFromPrefs =
        (changed.userDietary !== undefined
          ? (changed.userDietary as string[] | undefined)
          : changed.dietary !== undefined
            ? (changed.dietary as string[] | undefined)
            : undefined);

      if (dietaryFromPrefs !== undefined) {
        const raw = dietaryFromPrefs || [];

        let filtered = raw;
        const dietaryKeys = Object.keys(dietaryOptions);
        if (dietaryKeys.length > 0) {
          const validDietaryKeys = new Set(dietaryKeys);
          filtered = raw.filter((d) => validDietaryKeys.has(d));
        }

        if (!arraysEqual(filtered, dietary)) {
          setDietary(filtered);
          try {
            AsyncStorage.setItem("dietary", JSON.stringify(filtered));
          } catch { }
        }
      }

      // Accept both "userAvoid" (new) and "avoid" (legacy) from prefs
      const avoidFromPrefs =
        (changed.userAvoid !== undefined
          ? (changed.userAvoid as string[] | undefined)
          : changed.avoid !== undefined
            ? (changed.avoid as string[] | undefined)
            : undefined);

      if (avoidFromPrefs !== undefined) {
        const raw = avoidFromPrefs || [];

        let filtered = raw;
        const avoidKeys = Object.keys(avoidOptions);
        if (avoidKeys.length > 0) {
          const validAvoidKeys = new Set(avoidKeys);
          filtered = raw.filter((a) => validAvoidKeys.has(a));
        }

        if (!arraysEqual(filtered, avoid)) {
          setAvoid(filtered);
          try {
            AsyncStorage.setItem("avoid", JSON.stringify(filtered));
          } catch { }
        }
      }
      if (changed.userAvoidOther !== undefined) {
        const nextOther = changed.userAvoidOther || "";
        // Avoid overriding local typing while the user is actively editing.
        // Also skip if the value is already the same to prevent unnecessary re-renders.
        if (!isEditingAvoidOther && nextOther !== avoidOther) {
          setAvoidOther(nextOther);
          // Keep AsyncStorage in sync when prefs are updated from elsewhere (e.g. onboarding)
          try {
            AsyncStorage.setItem("avoidOther", nextOther);
          } catch { }
        }
      }
      if (changed.userMeasurement !== undefined) {
        const val =
          changed.userMeasurement === "imperial"
            ? "US"
            : changed.userMeasurement === "metric"
              ? "Metric"
              : changed.userMeasurement;
        if ((val === "US" || val === "Metric") && val !== measurement) {
          setMeasurement(val as MeasurementSystem);
        }
      }
      if (changed.themeMode !== undefined) {
        const wantDark =
          changed.themeMode === "dark" ||
          (changed.themeMode === "system" ? darkMode : false);
        if (wantDark !== darkMode) {
          setDarkMode(wantDark);
        }
      }
    };
    prefsEvents.on(PREFS_UPDATED, onPrefs);
    return () => {
      prefsEvents.off(PREFS_UPDATED, onPrefs as any);
    };
  }, [language, dietaryOptions, avoidOptions, dietary, avoid, measurement, darkMode, avoidOther, isEditingAvoidOther]);

  // Toggle helpers: just add/remove, leave empty if none selected
  const toggleDietary = (optionKey: string) => {
    setDietary((prev) => {
      let next = [...prev];
      if (next.includes(optionKey)) {
        next = next.filter(d => d !== optionKey);
      } else {
        next.push(optionKey);
      }
      return next;
    });
  };

  const toggleAvoid = (optionKey: string) => {
    setAvoid((prev) => {
      let next = [...prev];
      if (next.includes(optionKey)) {
        next = next.filter(a => a !== optionKey);
        if (optionKey === "other") {
          setAvoidOther(""); // clear custom text when deselecting
        }
      } else {
        next.push(optionKey);
      }
      return next;
    });
  };

  // Language selection
  const getLanguageOption = (code: SupportedLanguage) =>
    languageOptions.find((opt) => opt.code === code) || languageOptions[0];
  const currentLanguageObj = getLanguageOption(language);

  // App version from Constants (use only expoConfig.version, fallback to "1.0.0")
  const appVersion = Constants?.expoConfig?.version || "1.0.0";

  // Open in-app contact form instead of jumping straight to email app
  const handleContactSupport = () => {
    setContactError("");
    setContactSubject("");
    setContactMessage("");
    if (user?.email) {
      setContactEmail(user.email);
    } else {
      setContactEmail("");
    }
    setContactModalVisible(true);
  };

  // Basic email validation
  function isValidEmail(email: string) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(String(email).toLowerCase());
  }

  // Very simple guard against obvious code-injection patterns
  function hasMaliciousPatterns(text: string) {
    if (!text) return false;
    const lowered = text.toLowerCase();
    const badPatterns = [
      "<script",
      "</script",
      "javascript:",
      "<iframe",
      "onerror=",
      "onload=",
      "drop table",
      "delete from",
      "insert into",
      "update set",
      "select * from",
    ];
    return badPatterns.some((p) => lowered.includes(p));
  }

  // Handle sending the contact message (send directly to backend, no mail app)
  const handleSendContact = async () => {
    setContactError("");

    const subject = contactSubject.trim();
    const message = contactMessage.trim();
    const emailToUse = (user?.email || contactEmail || "").trim();

    // Basic required-field validation
    if (!subject || !message || !emailToUse) {
      setContactError(
        t("profile.contact_required_fields") ||
        "Please fill in subject, email and message."
      );
      return;
    }

    // Email format validation
    if (!isValidEmail(emailToUse)) {
      setContactError(
        t("profile.contact_invalid_email") ||
        "Please enter a valid email address."
      );
      return;
    }

    // Simple security/malicious-pattern guard
    if (hasMaliciousPatterns(subject) || hasMaliciousPatterns(message)) {
      setContactError(
        t("profile.contact_security_block") ||
        "Your message contains content that looks like code or a security risk. Please simplify it and try again."
      );
      return;
    }

    const payload = {
      subject,
      message,
      fromEmail: emailToUse,
      appVersion,
      language,
      theme,
      env: appEnv,
    };

    try {
      setContactSending(true);

      const apiUrl = `${process.env.EXPO_PUBLIC_API_URL}/support/contact`;
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let errorText = "";
        try {
          const data = await res.json();
          errorText = data?.error || "";
        } catch {
          // ignore JSON parse errors
        }

        setContactError(
          errorText ||
          (t("profile.contact_send_error") ||
            "We couldn’t send your message. Please try again in a moment.")
        );
        setContactSending(false);
        return;
      }

      // Success: close modal and clear fields
      setContactSending(false);
      setContactModalVisible(false);

      // Show success feedback (toast on Android, alert on iOS/web)
      const successTitle = t("profile.contact_send_success_title") || "Message Sent";
      const successMessage =
        t("profile.contact_send_success") || "Your message was sent successfully!";

      if (Platform.OS === "android") {
        ToastAndroid.show(successMessage, ToastAndroid.SHORT);
      } else {
        Alert.alert(successTitle, successMessage);
      }

      setContactSubject("");
      setContactMessage("");
      if (!user?.email) {
        setContactEmail("");
      }
    } catch (e) {
      console.warn("[Profile] handleSendContact error:", e);
      setContactError(
        t("profile.contact_send_error") ||
        "We couldn’t send your message. Please check your connection and try again."
      );
      setContactSending(false);
    }
  };

  // Helper to get dietary/avoid option object by key
  function getDietaryOption(key: string) {
    return dietaryOptions[key];
  }
  function getAvoidOption(key: string) {
    return avoidOptions[key];
  }

  // Helper for dietary selected text
  function getDietarySelectedText() {
    if (!dietary || dietary.length === 0) {
      return t("common.none_selected_dietary");
    }
    return dietary.map(d => {
      const opt = getDietaryOption(d);
      return opt ? `${opt.icon} ${opt.label}` : d;
    }).join(", ");
  }
  // Helper for avoid selected text
  function getAvoidSelectedText() {
    if (!avoid || avoid.length === 0) {
      return t("common.none_selected_avoid");
    }
    return avoid.map(a => {
      const opt = getAvoidOption(a);
      if (a === "other" && avoidOther && avoidOther.trim().length > 0) {
        // Sanitize & truncate input
        const maxOtherLength = 50;
        let safeOther = avoidOther.trim();
        safeOther = safeOther.replace(/[^a-zA-Z0-9 ,.;:!?áéíóúàèìòùçãõâêîôûÁÉÍÓÚÀÈÌÒÙÇÃÕÂÊÎÔÛ-]/g, "");
        if (safeOther.length > maxOtherLength) {
          safeOther = safeOther.substring(0, maxOtherLength) + "…";
        }
        return opt ? `${opt.icon} ${opt.label}: ${safeOther}` : `Other: ${safeOther}`;
      }
      return opt ? `${opt.icon} ${opt.label}` : a;
    }).join(", ");
  }

  function arraysEqual(a: string[], b: string[]) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Generic helper to send dev/analytics events to the backend
  const sendBackendEvent = async (eventType: string, payload: any = {}) => {
    try {
      const authInstance = getAuth();
      const idToken = await authInstance.currentUser?.getIdToken?.();

      if (!idToken) {
        console.warn("[Profile] No ID token, user not logged in?");
        return;
      }

      const apiUrl = `${process.env.EXPO_PUBLIC_API_URL}/events`;

      const body = {
        type: eventType,
        ts: Date.now(),
        env: appEnv,
        ...payload,
      };

      if (__DEV__) {
        console.log("[Profile] Sending backend event:", body);
      }

      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        console.warn("[Profile] Backend event FAILED", res.status, text);
      } else if (__DEV__) {
        console.log("[Profile] Backend event SUCCESS");
      }
    } catch (err) {
      console.warn("[Profile] sendBackendEvent ERROR:", err);
    }
  };

  // Helper to trigger a preferences sync via SyncEngine.
  // NOTE: SyncEngine.syncAll expects (reason: SyncTriggerReason, options?), not an object.
  function triggerPrefsSync(engine: any, reason: string = "prefs-change") {
    if (!engine) return;
    try {
      if (typeof engine.markPreferencesDirty === "function") {
        engine.markPreferencesDirty(buildPreferencesPayload());
      }

      // Use `manual` so we bypass throttling and run immediately.
      if (typeof engine.syncAll === "function") {
        engine.syncAll("manual", { bypassThrottle: true });
      } else if (typeof engine.requestSync === "function") {
        engine.requestSync("manual");
      }

      if (__DEV__) console.log("[Profile] triggerPrefsSync", { reason });
    } catch (err) {
      console.warn("[Profile] triggerPrefsSync failed", err);
    }
  }

  // DEV-only: test sending an event to the backend (which will write to Firestore via Admin SDK)
  const handleTestBackendEvent = async () => {
    if (!user?.uid) {
      console.log("[Profile] No user, cannot send backend event");
      return;
    }

    await sendBackendEvent("debug_manual_test", {
      source: "profile_button",
      screen: "profile",
      note: "Manual debug event triggered from Profile dev button",
    });
  };

  // Section title color: brighten in dark mode for visibility
  const sectionTitleColor =
    theme === "dark" ? "#f0f0f0" : subText;
  const selectedLabelColor = theme === "dark" ? "#ddd" : "#888";
  const selectedTextColor = theme === "dark" ? "#ddd" : "#888";


  // Reset onboarding state, clear related prefs in AsyncStorage and open onboarding once (no force flag)
  const resetOnboardingNow = async () => {
    try {
      // Clear all AsyncStorage data
      await AsyncStorage.clear();

      // Reset in-memory state to clean defaults
      setDietary([]);
      setAvoid([]);
      setAvoidOther("");
      setMeasurement("Metric");
      setDarkMode(false);
      setLanguage("en");
      i18n.changeLanguage("en");

      // Broadcast cleared prefs so any listeners (Home, Onboarding, etc.) can react
      saveUserPrefs({
        userDietary: [],
        userAvoid: [],
        userAvoidOther: "",
        userMeasurement: "metric",
        themeMode: "light",
        userLanguage: "en",
      });
      requestPreferencesSync({ reason: "reset-onboarding", debounceMs: 0 });

      alert("✅ Onboarding and preferences reset. Opening onboarding now.");

      // Navigate to onboarding without setting any persistent force flag
      try {
        router.replace("/onboarding");
      } catch { }
    } catch (e) {
      console.warn("[Profile] resetOnboardingNow error:", e);
    }
  };

  const handleToggleFaq = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedFaqId((prev) => (prev === id ? null : id));
  };

  const faqItems = [
    {
      id: "faq.what_is_app",
      question: t("faq.what_is_app") || "What is MyCookbook AI?",
      answer:
        t("faq.what_is_app_answer") ||
        "MyCookbook AI helps you organize your recipes, generate new ideas with AI, and adapt meals to your dietary preferences and ingredients you already have at home.",
    },
    {
      id: "faq.do_i_need_account",
      question: t("faq.do_i_need_account") || "Do I need an account to use the app?",
      answer:
        t("faq.do_i_need_account_answer") ||
        "You can explore the app as a guest, but creating an account lets you sync your recipes and preferences across devices and keeps your data safe if you change phones.",
    },
    {
      id: "faq.where_are_recipes_stored",
      question: t("faq.where_are_recipes_stored") || "Where are my recipes stored?",
      answer:
        t("faq.where_are_recipes_stored_answer") ||
        "Your recipes are stored securely in our cloud when you are logged in, and locally on your device for quick access. We do not share your recipes with other users.",
    },
    {
      id: "faq.ai_kitchen_preferences",
      question: t("faq.ai_kitchen_preferences") || "How does AI Kitchen use my food preferences?",
      answer:
        t("faq.ai_kitchen_preferences_answer") ||
        "AI Kitchen reads your dietary restrictions and ingredients to avoid from your Profile to suggest better recipes. You can change these preferences in your Profile at any time.",
    },
    {
      id: "faq.ai_kitchen_one_time_changes",
      question: t("faq.ai_kitchen_one_time_changes") || "Do changes in AI Kitchen update my Profile?",
      answer:
        t("faq.ai_kitchen_one_time_changes_answer") ||
        "No. Any changes to dietary restrictions or ingredients to avoid inside AI Kitchen apply only to that single AI request. Your Profile remains the source of truth for your long-term preferences.",
    },
    {
      id: "faq.cookies_what",
      question: t("faq.cookies_what") || "What are Cookies and what are they used for?",
      answer:
        t("faq.cookies_what_answer") ||
        "Cookies are credits used for premium actions in MyCookbook AI, such as generating recipes with AI and creating additional cookbooks beyond the free limit. Your cookie balance is shown in your Profile.",
    },
    {
      id: "faq.cookies_charged",
      question: t("faq.cookies_charged") || "When do Cookies get deducted and how can I get more?",
      answer:
        t("faq.cookies_charged_answer") ||
        "The first cookbook you create is free. Creating additional cookbooks deducts 1 Cookie from your balance. AI recipe generation also uses Cookies. You can get more Cookies from the Store, and we may occasionally offer free bonus Cookies through promotions.",
    },
    {
      id: "faq.measurement_system",
      question: t("faq.measurement_system") || "Which measurement systems are supported?",
      answer:
        t("faq.measurement_system_answer") ||
        "You can choose between US (cups, ounces, pounds) and Metric (grams, milliliters, kilograms) in your Profile. AI Kitchen will try to generate recipes using your preferred system.",
    },
    {
      id: "faq.language_change",
      question: t("faq.language_change") || "How do I change the app language?",
      answer:
        t("faq.language_change_answer") ||
        "Go to Profile → General → Language and pick your preferred language. Most of the interface and messages will adapt immediately.",
    },
    {
      id: "faq.dark_mode",
      question: t("faq.dark_mode") || "How do I enable dark mode?",
      answer:
        t("faq.dark_mode_answer") ||
        "Go to Profile → General and toggle Dark Mode. The whole app will switch between light and dark themes.",
    },
    {
      id: "faq.offline",
      question: t("faq.offline") || "Does the app work offline?",
      answer:
        t("faq.offline_answer") ||
        "Most of your saved recipes are available offline. However, AI features, image uploads and sync actions require an internet connection.",
    },
    {
      id: "faq.ai_unique_recipes",
      question: t("faq.ai_unique_recipes") || "Will AI always generate completely unique recipes?",
      answer:
        t("faq.ai_unique_recipes_answer") ||
        "AI generates recipes based on patterns it has learned and your inputs. Some recipes may be similar to well-known dishes, and you can always edit ingredients or steps after saving.",
    },
    {
      id: "faq.privacy",
      question: t("faq.privacy") || "Are my photos and recipes private?",
      answer:
        t("faq.privacy_answer") ||
        "Your recipe photos and content are only linked to your account. We do not make them public or searchable by other users.",
    },
    {
      id: "faq.free_or_paid",
      question: t("faq.free_or_paid") || "Is MyCookbook AI free?",
      answer:
        t("faq.free_or_paid_answer") ||
        "The core experience is free to use. In the future, some advanced features may require a paid plan, but we will always be clear before charging anything.",
    },
    {
      id: "faq.report_bug",
      question: t("faq.report_bug") || "How can I report a bug or suggest a feature?",
      answer:
        t("faq.report_bug_answer") ||
        "Use the Contact Support option in the Help & Support section of your Profile. Tell us what happened, which device you are using and, if possible, steps to reproduce the issue.",
    },
  ];

  const normalizedFaqQuery = faqSearchQuery.trim().toLowerCase();
  const visibleFaqItems = normalizedFaqQuery
    ? faqItems.filter((item) => {
      const q = item.question.toLowerCase();
      const a = item.answer.toLowerCase();
      return q.includes(normalizedFaqQuery) || a.includes(normalizedFaqQuery);
    })
    : faqItems;

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      <Stack.Screen
        options={{
          title: t("profile.title"), // profile.title
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
        }}
      />

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.sectionCard, { backgroundColor: card }]}>
          <Text style={[styles.sectionTitle, { color: sectionTitleColor }]}>{t("profile.authentication")}</Text>

          {(!user || isAnon) ? (
            <View>
              <TouchableOpacity
                style={[styles.row, { borderBottomColor: "transparent" }]}
                activeOpacity={0.7}
                onPress={() => router.push("/auth/signin")}
              >
                <MaterialIcons name="person-outline" size={22} color={text} />
                <Text style={[styles.rowText, { color: text }]}>{t("profile.signin_signup")}</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: 13, color: subText, marginTop: 6 }}>
                {t("profile.signin_explainer")}
              </Text>
            </View>
          ) : (
            <View>
              {/* User Info Block with Profile Picture */}
              <View style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "flex-start",
                paddingVertical: 16,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: border,
              }}>
                {(auth.currentUser?.photoURL || localPhotoUri) ? (
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      overflow: "hidden",
                      backgroundColor: "#ddd",
                      justifyContent: "center",
                      alignItems: "center",
                    }}
                  >
                    <Image
                      source={{ uri: (auth.currentUser?.photoURL || localPhotoUri) as string }}
                      style={{ width: 56, height: 56, borderRadius: 28 }}
                      resizeMode="cover"
                    />
                  </View>
                ) : (
                  <MaterialIcons name="account-circle" size={56} color={text} />
                )}
                <View style={{ marginLeft: 16 }}>
                  {getDisplayName(user) ? (
                    <>
                      <Text style={{ color: text, fontWeight: "600", fontSize: 18 }}>
                        {getDisplayName(user)}
                      </Text>
                      <Text style={{ color: subText, fontSize: 14 }}>{user.email}</Text>
                    </>
                  ) : (
                    <Text style={{ color: text, fontWeight: "600", fontSize: 16 }}>
                      {user.email}
                    </Text>
                  )}
                </View>
              </View>
              {/* Logout and Edit Profile */}
              <TouchableOpacity
                style={[styles.row, { borderBottomColor: border }]}
                activeOpacity={0.7}
                onPress={() => setModalEditProfile(true)}
              >
                <MaterialIcons name="edit" size={22} color={text} />
                <Text style={[styles.rowText, { color: text }]}>{t("profile.edit_profile") || "Edit Profile"}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.row, { borderBottomColor: "transparent" }]}
                activeOpacity={0.7}
                onPress={logout}
              >
                <MaterialIcons name="logout" size={22} color={text} />
                <Text style={[styles.rowText, { color: text }]}>{t("profile.logout")}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
        {/* Edit Profile Modal */}
        <Modal
          visible={modalEditProfile}
          animationType="slide"
          transparent
          onRequestClose={() => setModalEditProfile(false)}
        >
          <Pressable
            style={styles.modalOverlay}
            onPress={() => setModalEditProfile(false)}
          >
            <KeyboardAvoidingView
              style={{ flex: 1, justifyContent: "flex-end" }}
              behavior="padding"
              keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 40}
              enabled
            >
              <View
                style={[
                  styles.modalContent,
                  {
                    backgroundColor: card,
                    maxHeight: "85%",
                  },
                ]}
                onStartShouldSetResponder={() => true}
              >
                <ScrollView
                  ref={scrollRef}
                  keyboardShouldPersistTaps="always"
                  automaticallyAdjustKeyboardInsets
                  contentContainerStyle={{ paddingBottom: 24 }}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={[styles.sectionTitle, { color: sectionTitleColor, marginBottom: 12 }]}>
                      {t("profile.edit_profile") || "Edit Profile"}
                    </Text>
                    <Pressable
                      style={{ marginLeft: 10, marginTop: -6 }}
                      onPress={() => setModalEditProfile(false)}
                      hitSlop={12}
                    >
                      <MaterialIcons name="close" size={26} color={subText} />
                    </Pressable>
                  </View>
                  {editError ? (
                    <Text style={{ color: "#C00", marginBottom: 10 }}>{editError}</Text>
                  ) : null}
                  <View style={{ marginBottom: 18 }}>
                    <Text style={{ color: text, fontWeight: "bold", fontSize: 13, marginBottom: 4 }}>
                      {t("profile.display_name") || "Display Name"}
                    </Text>
                    <Pressable
                      onPressIn={() => displayNameRef.current?.focus()}
                      android_ripple={{ color: "#00000010" }}
                      style={{ borderRadius: 8 }}
                    >
                      <TextInput
                        ref={displayNameRef}
                        style={{
                          color: text,
                          fontSize: 16,
                          borderWidth: 1,
                          borderColor: border,
                          borderRadius: 8,
                          backgroundColor: bg,
                          paddingHorizontal: 10,
                          paddingVertical: 7,
                        }}
                        placeholder={t("profile.display_name_placeholder") || "Your name"}
                        value={editDisplayName}
                        onChangeText={setEditDisplayName}
                        placeholderTextColor="#888"
                        returnKeyType="next"
                        editable
                        focusable
                        showSoftInputOnFocus={true}
                        selectTextOnFocus={true}
                      />
                    </Pressable>
                  </View>
                  <View style={{ marginBottom: 18 }}>
                    <Text style={{ color: text, fontWeight: "bold", fontSize: 13, marginBottom: 4 }}>
                      {t("profile.profile_photo") || "Profile Photo"}
                    </Text>
                    <Pressable
                      style={{
                        width: 60,
                        height: 60,
                        borderRadius: 30,
                        backgroundColor: "#eee",
                        justifyContent: "center",
                        alignItems: "center",
                        borderWidth: 1,
                        borderColor: border,
                      }}
                      onPress={pickImage}
                    >
                      {editPhotoURL ? (
                        <Image
                          source={{ uri: editPhotoURL }}
                          style={{ width: 60, height: 60, borderRadius: 30 }}
                        />
                      ) : (
                        <MaterialIcons name="account-circle" size={40} color="#888" />
                      )}
                    </Pressable>
                    {editPhotoURL ? (
                      <TouchableOpacity
                        onPress={removeImage}
                        style={{ marginTop: 8 }}
                      >
                        <Text style={{ color: "#E27D60", fontWeight: "500" }}>
                          {t("profile.remove_photo") || "Remove Photo"}
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity
                        onPress={pickImage}
                        style={{ marginTop: 8 }}
                      >
                        <Text style={{ color: "#E27D60", fontWeight: "500" }}>
                          {t("profile.change_photo") || "Change Photo"}
                        </Text>
                      </TouchableOpacity>
                    )}
                    {uploadProgress !== null && (
                      <Text style={{ marginTop: 6, color: subText, fontSize: 12 }}>
                        {Math.round(uploadProgress * 100)}%
                      </Text>
                    )}
                  </View>
                  <View style={{ marginBottom: 18 }}>
                    <Text style={{ color: text, fontWeight: "bold", fontSize: 13, marginBottom: 4 }}>
                      {t("profile.change_password") || "Change Password"}
                    </Text>
                    <TextInput
                      style={{
                        color: text,
                        fontSize: 16,
                        borderWidth: 1,
                        borderColor: border,
                        borderRadius: 8,
                        backgroundColor: bg,
                        paddingHorizontal: 10,
                        paddingVertical: 7,
                      }}
                      placeholder={t("profile.new_password_placeholder") || "New password"}
                      value={editPassword}
                      onChangeText={setEditPassword}
                      placeholderTextColor="#888"
                      secureTextEntry
                      returnKeyType="done"
                      onSubmitEditing={handleSaveProfile}
                      onFocus={() => {
                        setTimeout(() => {
                          scrollRef.current?.scrollToEnd({ animated: true });
                        }, 50);
                      }}
                    />
                  </View>
                </ScrollView>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "flex-end",
                    marginTop: 6,
                    paddingTop: 10,
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: border,
                  }}
                >
                  <Pressable
                    style={[
                      styles.modalCloseBtn,
                      { borderColor: border, marginRight: 10, backgroundColor: "#eee" },
                    ]}
                    onPress={() => setModalEditProfile(false)}
                    disabled={editLoading}
                  >
                    <Text
                      style={{
                        color: theme === "dark" ? "#111" : text,
                        fontWeight: "600",
                      }}
                    >
                      {t("common.cancel") || "Cancel"}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.modalCloseBtn,
                      { borderColor: border, backgroundColor: "#E27D60" },
                    ]}
                    onPress={() => {
                      Keyboard.dismiss();
                      if (!editLoading) {
                        handleSaveProfile();
                      }
                    }}
                    disabled={editLoading}
                  >
                    <Text style={{ color: "#fff", fontWeight: "600" }}>
                      {editLoading
                        ? (t("common.saving") && !t("common.saving").includes("common.saving")
                          ? t("common.saving")
                          : "Saving...")
                        : (t("common.save") && !t("common.save").includes("common.save")
                          ? t("common.save")
                          : "Save")}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </KeyboardAvoidingView>
          </Pressable>
        </Modal>

        {/* Cookies / Economy */}
        <View style={[styles.sectionCard, { backgroundColor: card }]}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={[styles.sectionTitle, { color: sectionTitleColor, marginBottom: 0 }]}>
                {t("economy.cookies_title", { defaultValue: "Cookies" })}
              </Text>
              <Text style={{ fontSize: 13, color: subText, marginTop: 2, flexShrink: 1, flexWrap: "wrap" }}>
                {t("economy.economy_explainer", {
                  defaultValue: "Used for AI features and adding extra cookbooks.",
                })}
              </Text>
              {/* Bonus line moved below balance row */}
            </View>
            <TouchableOpacity
              onPress={() => setCookieInfoVisible(true)}
              style={{ padding: 6 }}
              activeOpacity={0.7}
            >
              <MaterialIcons name="info-outline" size={20} color={subText} />
            </TouchableOpacity>
          </View>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 12,
              paddingTop: 10,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: border,
            }}
          >
            <Text style={{ fontSize: 13, color: subText }}>
              {t("economy.cookies_balance", { defaultValue: "Balance" })}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={{ color: text, fontSize: 18, fontWeight: "800" }}>
                {cookieLoading ? "…" : cookieBalance === null ? "—" : cookieBalance}
              </Text>
              <MaterialCommunityIcons
                name="cookie"
                size={18}
                color={subText}
                style={{ marginLeft: 6, marginTop: 1 }}
              />

              <Pressable
                style={({ pressed }) => [
                  styles.cookieActionButton,
                  { borderColor: "#E27D60", opacity: pressed ? 0.85 : 1 },
                ]}
                onPress={() => {
                  router.push("/economy/store");
                }}
                hitSlop={8}
              >
                <Text style={styles.cookieActionButtonText}>
                  {t("economy.get_more_cookies", { defaultValue: "Add more" })}
                </Text>
              </Pressable>
            </View>
          </View>

          {(!user || isAnon) ? (
            <Pressable
              onPress={() => router.push("/auth/signup")}
              style={({ pressed }) => ({
                marginTop: 8,
                opacity: pressed ? 0.85 : 1,
              })}
              hitSlop={8}
            >
              <Text
                style={{
                  fontSize: 13,
                  color: "#E27D60",
                  fontWeight: "600",
                }}
              >
                {t("economy.bonus_create_account_line", {
                  defaultValue: "🎁 Create an account and log in once to get +10 free cookies.",
                })}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {/* Cookies info modal */}
        <Modal
          visible={cookieInfoVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setCookieInfoVisible(false)}
        >
          <Pressable
            style={styles.modalOverlay}
            onPress={() => setCookieInfoVisible(false)}
          >
            <View
              style={[
                styles.modalContent,
                { backgroundColor: card, maxHeight: "70%" },
              ]}
              onStartShouldSetResponder={() => true}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={[styles.sectionTitle, { color: sectionTitleColor, marginBottom: 12 }]}>
                  {t("economy.cookies_what", { defaultValue: "What are cookies?" })}
                </Text>
                <Pressable
                  style={{ marginLeft: 10, marginTop: -6 }}
                  onPress={() => setCookieInfoVisible(false)}
                  hitSlop={12}
                >
                  <MaterialIcons name="close" size={26} color={subText} />
                </Pressable>
              </View>

              <Text style={{ color: subText, fontSize: 14, lineHeight: 20 }}>
                {(() => {
                  const isLoggedIn = !!user && !isAnon;
                  const key = isLoggedIn
                    ? "economy.cookies_what_body_logged_in"
                    : "economy.cookies_what_body_logged_out";

                  const defaultLoggedIn =
                    "Cookies are credits used for AI-powered features and for creating additional cookbooks beyond the free limit. You can earn some for free (we run promotions from time to time) and top up at any time.";

                  const defaultLoggedOut =
                    "Cookies are credits used for AI-powered features and for creating additional cookbooks beyond the free limit. Create an account and sign in to earn extra cookies for free — and you can also top up at any time.";

                  return t(key, {
                    defaultValue: isLoggedIn ? defaultLoggedIn : defaultLoggedOut,
                  });
                })()}
              </Text>
            </View>
          </Pressable>
        </Modal>

        <View style={[styles.sectionCard, { backgroundColor: card }]}>
          <Text style={[styles.sectionTitle, { color: sectionTitleColor }]}>{t("profile.food_preferences")}</Text>
          <Text style={{ fontSize: 13, color: subText, marginBottom: 8 }}>
            {t("profile.food_preferences_explainer")}
          </Text>
          {/* Dietary Restrictions */}
          <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: border }}>
            <Pressable
              style={{ width: "100%" }}
              android_ripple={{ color: "#00000010" }}
              onPress={() => setModalDietary(true)}
            >
              <View style={[styles.row, { borderBottomColor: "transparent", alignItems: "center" }]}>
                <MaterialIcons name="restaurant-menu" size={22} color={text} style={{ marginTop: 2 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowText, { color: text }]}>{t("profile.dietary_restrictions")}</Text>
                </View>
              </View>
              <View style={[
                styles.selectedOptionsContainer,
                { paddingBottom: 7 }
              ]}>
                <Text style={[styles.selectedLabel, { color: selectedLabelColor }]}>
                  {t("common.selected")}
                </Text>
                <Text style={[styles.selectedOptionsText, { color: selectedTextColor }]}>
                  {getDietarySelectedText()}
                </Text>
              </View>
            </Pressable>
          </View>

          {/* Ingredients to Avoid */}
          <Pressable
            style={{ width: "100%" }}
            android_ripple={{ color: "#00000010" }}
            onPress={() => setModalAvoid(true)}
          >
            <View style={[styles.row, { borderBottomColor: "transparent", alignItems: "center" }]}>
              <MaterialIcons name="no-food" size={22} color={text} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowText, { color: text }]}>{t("profile.ingredients_to_avoid")}</Text>
              </View>
            </View>
            <View style={[
              styles.selectedOptionsContainer,
              { paddingBottom: 7 }
            ]}>
              <Text style={[styles.selectedLabel, { color: selectedLabelColor }]}>
                {t("common.selected")}
              </Text>
              <Text style={[styles.selectedOptionsText, { color: selectedTextColor }]}>
                {getAvoidSelectedText()}
              </Text>
            </View>
          </Pressable>
        </View>
        <Modal
          visible={modalDietary}
          animationType="slide"
          transparent
          onRequestClose={() => setModalDietary(false)}
        >
          <Pressable
            style={styles.modalOverlay}
            onPress={() => setModalDietary(false)}
          >
            <View
              style={[styles.modalContent, { backgroundColor: card }]}
              onStartShouldSetResponder={() => true}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={[styles.sectionTitle, { color: sectionTitleColor, marginBottom: 12 }]}>
                  {t("profile.select_dietary")}
                </Text>
                <Pressable
                  style={{ marginLeft: 10, marginTop: -6 }}
                  onPress={() => setModalDietary(false)}
                  hitSlop={12}
                >
                  <MaterialIcons name="close" size={26} color={subText} />
                </Pressable>
              </View>
              <View style={styles.chipGroup}>
                {Object.entries(dietaryOptions)
                  .filter(([key]) => key !== "dietary.none")
                  .map(([key, option]) => {
                    const isSelected = dietary.includes(key);
                    return (
                      <Pressable
                        key={key}
                        style={[
                          styles.chip,
                          {
                            backgroundColor: isSelected ? "#E27D60" : bg,
                            borderColor: border,
                          },
                        ]}
                        onPress={() => toggleDietary(key)}
                      >
                        <View style={{ flexDirection: "row", alignItems: "center" }}>
                          <Text style={{ fontSize: 16, marginRight: 6 }}>{option.icon}</Text>
                          <Text style={{ color: isSelected ? "#fff" : text }}>
                            {option.label}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
              </View>
            </View>
          </Pressable>
        </Modal>
        <Modal
          visible={modalAvoid}
          animationType="slide"
          transparent
          onRequestClose={() => setModalAvoid(false)}
        >
          <Pressable
            style={styles.modalOverlay}
            onPress={() => setModalAvoid(false)}
          >
            <View
              style={[styles.modalContent, { backgroundColor: card }]}
              onStartShouldSetResponder={() => true}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={[styles.sectionTitle, { color: sectionTitleColor, marginBottom: 12 }]}>
                  {t("profile.select_avoid")}
                </Text>
                <Pressable
                  style={{ marginLeft: 10, marginTop: -6 }}
                  onPress={() => setModalAvoid(false)}
                  hitSlop={12}
                >
                  <MaterialIcons name="close" size={26} color={subText} />
                </Pressable>
              </View>

              {/* Chips */}
              <View style={styles.chipGroup}>
                {Object.entries(avoidOptions)
                  .filter(([key]) => key !== "avoid.none")
                  .map(([key, option]) => {
                    const isSelected = avoid.includes(key);
                    return (
                      <Pressable
                        key={key}
                        style={[
                          styles.chip,
                          {
                            backgroundColor: isSelected ? "#E27D60" : bg,
                            borderColor: border,
                          },
                        ]}
                        onPress={() => toggleAvoid(key)}
                      >
                        <View style={{ flexDirection: "row", alignItems: "center" }}>
                          <Text style={{ fontSize: 16, marginRight: 6 }}>{option.icon}</Text>
                          <Text style={{ color: isSelected ? "#fff" : text }}>
                            {option.label}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
              </View>

              {/* Other input area */}
              {avoid.includes("other") && (
                <View style={{ marginBottom: 16, marginTop: 6 }}>
                  <Text style={{ color: text, fontWeight: "bold", fontSize: 13, marginBottom: 4 }}>
                    {t("profile.avoid_other_label") || "Other ingredients to avoid:"}
                  </Text>
                  <View style={{
                    borderWidth: 1,
                    borderColor: border,
                    borderRadius: 8,
                    backgroundColor: bg,
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                  }}>
                    <TextInput
                      style={{
                        color: text,
                        fontSize: 15,
                        minHeight: 32,
                      }}
                      placeholder={t("profile.avoid_other_placeholder") || "Type ingredients to avoid"}
                      value={avoidOther}
                      onChangeText={setAvoidOther}
                      placeholderTextColor="#888"
                      multiline
                      autoFocus
                      onFocus={() => setIsEditingAvoidOther(true)}
                      onBlur={() => setIsEditingAvoidOther(false)}
                    />
                  </View>
                </View>
              )}
            </View>
          </Pressable>
        </Modal>

        {/* General / Other */}
        <View style={[styles.sectionCard, { backgroundColor: card }]}>
          <Text style={[styles.sectionTitle, { color: sectionTitleColor }]}>{t("profile.general")}</Text>
          <TouchableOpacity
            style={[styles.row, { borderBottomColor: border }]}
            activeOpacity={1}
          >
            <MaterialIcons name="dark-mode" size={22} color={text} />
            <Text style={[styles.rowText, { color: text }]}>{t("profile.dark_mode")}</Text>
            <View style={{ marginLeft: "auto", marginBottom: -6 }}>
              <Switch
                value={darkMode}
                onValueChange={(next) => {
                  // Keep local UI state in sync
                  setDarkMode(next);

                  // Keep ThemeContext in sync without relying on effects (avoids loops)
                  const wantTheme = next ? "dark" : "light";
                  if (theme !== wantTheme) {
                    toggleTheme();
                  }
                }}
              />
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, { borderBottomColor: border }]}
            activeOpacity={1}
          >
            <MaterialIcons name="straighten" size={22} color={text} />
            <Text style={[styles.rowText, { color: text }]}>
              {t("profile.measurement_system")}
            </Text>
            <View style={[styles.measurementToggleGroup, { marginLeft: "auto" }]}>
              <Pressable
                style={[
                  styles.toggleBtn,
                  {
                    backgroundColor: measurement === "US" ? "#E27D60" : card,
                    borderColor: border,
                  },
                ]}
                onPress={() => setMeasurement("US")}
              >
                <Text style={{ color: measurement === "US" ? "#fff" : text, fontWeight: "600" }}>US</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.toggleBtn,
                  {
                    backgroundColor: measurement === "Metric" ? "#E27D60" : card,
                    borderColor: border,
                  },
                ]}
                onPress={() => setMeasurement("Metric")}
              >
                <Text style={{ color: measurement === "Metric" ? "#fff" : text, fontWeight: "600" }}>Metric</Text>
              </Pressable>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, { borderBottomColor: "transparent" }]}
            activeOpacity={0.7}
            onPress={() => setModalLanguage(true)}
          >
            <MaterialIcons name="language" size={22} color={text} />
            <Text style={[styles.rowText, { color: text }]}>{t("profile.language")}</Text>
            <Text style={{ fontSize: 15, marginLeft: "auto", color: text }}>
              {currentLanguageObj.flag} {currentLanguageObj.label}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={[styles.sectionCard, { backgroundColor: card }]}>
          <Text style={[styles.sectionTitle, { color: sectionTitleColor }]}>
            {t("profile.help_support") || "Help & Support"}
          </Text>

          <TouchableOpacity
            style={[styles.row, { borderBottomColor: border }]}
            activeOpacity={0.7}
            onPress={() => setFaqModalVisible(true)}
          >
            <MaterialIcons name="help-outline" size={22} color={text} />
            <Text style={[styles.rowText, { color: text }]}>
              {t("profile.faq") || "FAQ"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.row, { borderBottomColor: border }]}
            activeOpacity={0.7}
            onPress={handleContactSupport}
          >
            <MaterialIcons name="mail-outline" size={22} color={text} />
            <Text style={[styles.rowText, { color: text }]}>
              {t("profile.contact_support") || "Contact Support"}
            </Text>
          </TouchableOpacity>
          {SHOW_RESET && (
            <TouchableOpacity
              style={[styles.row, { borderBottomColor: border }]}
              activeOpacity={0.7}
              onPress={resetOnboardingNow}
            >
              <MaterialIcons name="restart-alt" size={22} color={text} />
              <Text style={[styles.rowText, { color: text }]}>
                {t("profile.reset_onboarding") || "Reset onboarding"}
              </Text>
            </TouchableOpacity>
          )}
          {__DEV__ && (
            <TouchableOpacity
              style={[styles.row, { borderBottomColor: border }]}
              activeOpacity={0.7}
              onPress={handleTestBackendEvent}
            >
              <MaterialIcons name="bug-report" size={22} color={text} />
              <Text style={[styles.rowText, { color: text }]}>
                Test Backend Event (dev)
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.row, { borderBottomColor: "transparent" }]}
            activeOpacity={0.7}
            onPress={() => setModalAppInfo(true)}
          >
            <MaterialIcons name="info-outline" size={22} color={text} />
            <Text style={[styles.rowText, { color: text }]}>
              {t("profile.app_info")}
            </Text>
          </TouchableOpacity>
        </View>

        <Modal
          visible={modalLanguage}
          animationType="slide"
          transparent
          onRequestClose={() => setModalLanguage(false)}
        >
          <Pressable
            style={styles.modalOverlay}
            onPress={() => setModalLanguage(false)}
          >
            <View
              style={[styles.modalContent, { backgroundColor: card }]}
              onStartShouldSetResponder={() => true}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={[styles.sectionTitle, { color: sectionTitleColor, marginBottom: 12 }]}>
                  {t("profile.select_language")}
                </Text>
                <Pressable
                  style={{ marginLeft: 10, marginTop: -6 }}
                  onPress={() => setModalLanguage(false)}
                  hitSlop={12}
                >
                  <MaterialIcons name="close" size={26} color={subText} />
                </Pressable>
              </View>
              {languageOptions.map((option) => (
                <TouchableOpacity
                  key={option.code}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingVertical: 13,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: border,
                  }}
                  onPress={() => {
                    const lng = option.code as SupportedLanguage;
                    setLanguage(lng);
                    i18n.changeLanguage(lng);
                    saveUserPrefs({ userLanguage: lng });
                    setModalLanguage(false);
                  }}
                >
                  <Text style={{ fontSize: 20, marginRight: 10 }}>{option.flag}</Text>
                  <Text style={{
                    color: text,
                    fontWeight: language === option.code ? "bold" : "normal",
                    fontSize: 16,
                  }}>
                    {option.label}
                  </Text>
                  {language === option.code && (
                    <MaterialIcons name="check" size={20} color="#E27D60" style={{ marginLeft: "auto" }} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Modal>

        <Modal
          visible={faqModalVisible}
          animationType="slide"
          transparent
          onRequestClose={() => setFaqModalVisible(false)}
        >
          <Pressable
            style={styles.modalOverlay}
            onPress={() => setFaqModalVisible(false)}
          >
            <View
              style={[styles.modalContent, { backgroundColor: card }]}
              onStartShouldSetResponder={() => true}
            >
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <Text
                  style={[
                    styles.sectionTitle,
                    { color: sectionTitleColor, marginBottom: 4 },
                  ]}
                >
                  {t("profile.faq") || "Frequently Asked Questions"}
                </Text>
                <Pressable
                  style={{ marginLeft: 10, marginTop: -6 }}
                  onPress={() => setFaqModalVisible(false)}
                  hitSlop={12}
                >
                  <MaterialIcons name="close" size={26} color={subText} />
                </Pressable>
              </View>

              {/* FAQ Search Bar */}
              <View
                style={{
                  marginBottom: 10,
                  borderRadius: 8,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: border,
                  backgroundColor: bg,
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                }}
              >
                <MaterialIcons
                  name="search"
                  size={20}
                  color={subText}
                  style={{ marginRight: 6 }}
                />
                <TextInput
                  style={{
                    flex: 1,
                    color: text,
                    fontSize: 14,
                    paddingVertical: 4,
                  }}
                  placeholder={t("faq.search_placeholder") || "Search questions"}
                  placeholderTextColor={subText}
                  value={faqSearchQuery}
                  onChangeText={setFaqSearchQuery}
                  returnKeyType="search"
                />
                {faqSearchQuery.length > 0 && (
                  <Pressable
                    onPress={() => setFaqSearchQuery("")}
                    hitSlop={8}
                  >
                    <MaterialIcons name="close" size={18} color={subText} />
                  </Pressable>
                )}
              </View>

              <ScrollView
                style={{ maxHeight: "80%" }}
                contentContainerStyle={{ paddingBottom: 10 }}
                keyboardShouldPersistTaps="handled"
              >
                {visibleFaqItems.length === 0 ? (
                  <Text
                    style={{
                      color: subText,
                      fontSize: 14,
                      fontStyle: "italic",
                      paddingVertical: 8,
                    }}
                  >
                    {t("faq.no_results") || "No questions found for your search."}
                  </Text>
                ) : (
                  visibleFaqItems.map((item) => {
                    const isExpanded = expandedFaqId === item.id;
                    return (
                      <View
                        key={item.id}
                        style={{
                          marginBottom: 10,
                          borderRadius: 10,
                          borderWidth: StyleSheet.hairlineWidth,
                          borderColor: border,
                          backgroundColor: theme === "dark" ? "#111827" : "#f9fafb",
                          overflow: "hidden",
                        }}
                      >
                        <Pressable
                          onPress={() => handleToggleFaq(item.id)}
                          android_ripple={{ color: "#00000010" }}
                          style={{
                            paddingHorizontal: 10,
                            paddingVertical: 10,
                            flexDirection: "row",
                            alignItems: "center",
                          }}
                        >
                          <Text
                            style={{
                              flex: 1,
                              color: text,
                              fontWeight: "600",
                              fontSize: 15,
                            }}
                          >
                            {item.question}
                          </Text>
                          <MaterialIcons
                            name={isExpanded ? "expand-less" : "expand-more"}
                            size={22}
                            color={subText}
                          />
                        </Pressable>
                        {isExpanded && (
                          <View
                            style={{
                              paddingHorizontal: 12,
                              paddingBottom: 10,
                            }}
                          >
                            <Text
                              style={{
                                color: subText,
                                fontSize: 14,
                                lineHeight: 20,
                              }}
                            >
                              {item.answer}
                            </Text>
                          </View>
                        )}
                      </View>
                    );
                  })
                )}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>

        {/* App Info Modal */}
        <Modal
          visible={modalAppInfo}
          animationType="fade"
          transparent
          onRequestClose={() => setModalAppInfo(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { backgroundColor: card, minHeight: 180 }]}>
              <Text style={[styles.sectionTitle, { color: sectionTitleColor, marginBottom: 12 }]}>
                {t("profile.app_info")}
              </Text>
              <Pressable
                onLongPress={async () => {
                  if (!SHOW_RESET) return;
                  await resetOnboardingNow();
                }}
                delayLongPress={600}
              >
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
                  <Text style={{ color: text, fontSize: 16 }}>{t("profile.version")} </Text>
                  <Text style={{ fontWeight: "bold", color: text, fontSize: 16 }}>{appVersion}</Text>
                </View>
              </Pressable>
              <Pressable
                style={[styles.modalCloseBtn, { borderColor: border }]}
                onPress={() => setModalAppInfo(false)}
              >
                <Text style={{ color: text, fontWeight: "600" }}>{t("common.close")}</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        {/* Contact Support Modal */}
        <Modal
          visible={contactModalVisible}
          animationType="slide"
          transparent
          onRequestClose={() => {
            if (!contactSending) {
              setContactModalVisible(false);
            }
          }}
        >
          <Pressable
            style={styles.modalOverlay}
            onPress={() => {
              if (!contactSending) {
                setContactModalVisible(false);
              }
            }}
          >
            <KeyboardAvoidingView
              style={{ flex: 1, justifyContent: "flex-end" }}
              behavior={Platform.OS === "ios" ? "padding" : "height"}
              keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 20}
            >
              <KeyboardAvoidingView
                behavior={Platform.OS === "ios" ? "padding" : "height"}
                style={[
                  styles.modalContent,
                  { backgroundColor: card, maxHeight: "80%" },
                ]}
                onStartShouldSetResponder={() => true}
              >
                <Text style={[styles.sectionTitle, { color: sectionTitleColor, marginBottom: 8 }]}>
                  {t("profile.contact_support") || "Contact Support"}
                </Text>

                {contactError ? (
                  <Text style={{ color: "#C00", marginBottom: 10, fontSize: 13 }}>
                    {contactError}
                  </Text>
                ) : null}

                <View style={{ marginBottom: 14 }}>
                  <Text style={{ color: text, fontWeight: "bold", fontSize: 13, marginBottom: 4 }}>
                    {t("profile.contact_subject") || "Subject"}
                  </Text>
                  <TextInput
                    style={{
                      color: text,
                      fontSize: 15,
                      borderWidth: 1,
                      borderColor: border,
                      borderRadius: 8,
                      backgroundColor: bg,
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                    }}
                    placeholder={
                      t("profile.contact_subject_placeholder") ||
                      "How can we help?"
                    }
                    placeholderTextColor="#888"
                    value={contactSubject}
                    onChangeText={setContactSubject}
                    autoCapitalize="sentences"
                    returnKeyType="next"
                  />
                </View>

                <View style={{ marginBottom: 14 }}>
                  <Text style={{ color: text, fontWeight: "bold", fontSize: 13, marginBottom: 4 }}>
                    {t("profile.contact_email") || "Your email"}
                  </Text>
                  <TextInput
                    style={{
                      color: user?.email ? subText : text,
                      fontSize: 15,
                      borderWidth: 1,
                      borderColor: border,
                      borderRadius: 8,
                      backgroundColor: user?.email ? "#f0f0f0" : bg,
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                    }}
                    placeholder={
                      t("profile.contact_email_placeholder") ||
                      "you@example.com"
                    }
                    placeholderTextColor="#888"
                    value={user?.email || contactEmail}
                    onChangeText={(txt) => {
                      if (!user?.email) setContactEmail(txt);
                    }}
                    editable={!user?.email}
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                </View>

                <View style={{ marginBottom: 16 }}>
                  <Text style={{ color: text, fontWeight: "bold", fontSize: 13, marginBottom: 4 }}>
                    {t("profile.contact_message") || "Message"}
                  </Text>
                  <TextInput
                    style={{
                      color: text,
                      fontSize: 15,
                      borderWidth: 1,
                      borderColor: border,
                      borderRadius: 8,
                      backgroundColor: bg,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      minHeight: 100,
                      textAlignVertical: "top",
                    }}
                    placeholder={
                      t("profile.contact_message_placeholder") ||
                      "Describe your question or issue with as much detail as you can."
                    }
                    placeholderTextColor="#888"
                    value={contactMessage}
                    onChangeText={setContactMessage}
                    multiline
                  />
                </View>

                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "flex-end",
                    paddingTop: 10,
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: border,
                  }}
                >
                  <Pressable
                    style={[
                      styles.modalCloseBtn,
                      { borderColor: border, marginRight: 10, backgroundColor: "#eee" },
                    ]}
                    onPress={() => {
                      if (!contactSending) {
                        setContactModalVisible(false);
                      }
                    }}
                    disabled={contactSending}
                  >
                    <Text
                      style={{
                        color: theme === "dark" ? "#111" : text,
                        fontWeight: "600",
                      }}
                    >
                      {t("common.cancel") || "Cancel"}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.modalCloseBtn,
                      { borderColor: border, backgroundColor: "#E27D60", opacity: contactSending ? 0.7 : 1 },
                    ]}
                    onPress={handleSendContact}
                    disabled={contactSending}
                  >
                    <Text style={{ color: "#fff", fontWeight: "600" }}>
                      {contactSending
                        ? (t("common.sending") && !t("common.sending").includes("common.sending")
                          ? t("common.sending")
                          : "Sending...")
                        : (t("common.send") && !t("common.send").includes("common.send")
                          ? t("common.send")
                          : "Send")}
                    </Text>
                  </Pressable>
                </View>
              </KeyboardAvoidingView>
            </KeyboardAvoidingView>
          </Pressable>
        </Modal>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16 },
  sectionCard: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginBottom: 22,
    // backgroundColor set inline
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "bold",
    marginTop: 8,
    marginBottom: 8,
    // color set inline
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 48,
    // borderBottomColor set inline
  },
  rowText: {
    fontSize: 15,
    marginLeft: 12,
    flex: 1,
  },
  // Modal and chip styles
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.25)",
    justifyContent: "flex-end",
  },
  modalContent: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    minHeight: 320,
  },
  chipGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 20,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 7,
    marginRight: 8,
    marginBottom: 8,
  },
  modalCloseBtn: {
    alignSelf: "flex-end",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  measurementToggleGroup: {
    flexDirection: "row",
    gap: 8,
  },
  toggleBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 2,
    marginLeft: 2,
  },
  selectedOptionsContainer: {
    width: "100%",
    marginTop: 0,
    marginBottom: 4,
    marginLeft: 34,
    flexDirection: "column",
    alignItems: "flex-start",
    paddingRight: 12,
    maxWidth: "95%",
    // border styles removed
  },
  selectedLabel: {
    color: "#888",
    fontSize: 13,
    fontWeight: "bold",
  },
  selectedOptionsText: {
    color: "#888",
    fontSize: 13,
    marginLeft: 0,
    marginTop: 2,
    flexShrink: 1,
    width: "100%",
    lineHeight: 18,
  },
  cookieActionButton: {
    marginLeft: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: "transparent",
  },
  cookieActionButtonText: {
    color: "#E27D60",
    fontWeight: "800",
    fontSize: 13,
  }
});