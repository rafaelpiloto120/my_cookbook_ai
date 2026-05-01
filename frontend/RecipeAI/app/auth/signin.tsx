type AuthMode = "signin" | "signup";

import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import React, { useState, useEffect } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Modal, StatusBar } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../context/AuthContext";
import { useThemeColors } from "../../context/ThemeContext";
import { useTranslation } from "react-i18next";
import { sendPasswordResetEmail } from "firebase/auth";
import { auth } from "../../firebaseConfig";
import {
  GoogleSignin,
  isCancelledResponse,
  isSuccessResponse,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import Svg, { Path } from "react-native-svg";

// ---- Input hardening helpers ----
const INVISIBLE_REGEX = /[\u200B-\u200D\uFEFF\u202E\u202D\u202A\u202B\u202C]/g; // zero-width & bidi controls
const CONTROL_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g; // other C0 controls (exclude \t, \n intentionally for inputs)

const normalizeNFKC = (s: string) => {
  try { return s.normalize('NFKC'); } catch { return s; }
};
const stripDangerous = (s: string) => normalizeNFKC(s).replace(INVISIBLE_REGEX, '').replace(CONTROL_REGEX, '');

// Sanitize progressively while typing (email)
const sanitizeEmailInput = (s: string) => stripDangerous(s).replace(/\s+/g, '').slice(0, 254);
// Sanitize progressively while typing (password) – do NOT trim; just strip invisibles/controls and cap length
const sanitizePasswordInput = (s: string) => stripDangerous(s).slice(0, 256);

// Final email clean on submit
const sanitizeOnSubmitEmail = (s: string) => sanitizeEmailInput(s);
const isValidEmail = (v: string) => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(v);

const GOOGLE_EMAIL_EXISTS_CODES = new Set([
  "auth/email-already-in-use",
  "auth/account-exists-with-different-credential",
]);

function getEmailFromGoogleIdToken(idToken: string) {
  try {
    const [, payload] = idToken.split(".");
    if (!payload) return "";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const decoded = JSON.parse(atob(padded));
    return typeof decoded?.email === "string" ? sanitizeEmailInput(decoded.email) : "";
  } catch {
    return "";
  }
}

// --- Map Firebase Auth error codes to user-friendly messages ---
const getFriendlyAuthError = (code: string, t: any) => {
  const map: Record<string, string> = {
    "auth/invalid-email": t("auth.error_invalid_email"),
    "auth/user-disabled": t("auth.error_user_disabled"),
    "auth/user-not-found": t("auth.error_user_not_found"),
    "auth/wrong-password": t("auth.error_wrong_password"),
    "auth/invalid-credential": t("auth.error_invalid_credential"),
    "auth/email-already-in-use": t("auth.error_email_in_use"),
    "auth/weak-password": t("auth.error_weak_password"),
    "auth/missing-password": t("auth.error_missing_password"),
  };
  return map[code] || t("common.error_generic", { defaultValue: "Something went wrong" });
};
// --------------------------------

function GoogleLogo({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill="#4285F4"
        d="M23.64 12.2c0-.82-.07-1.43-.23-2.06H12v3.75h6.69c-.13.93-.86 2.34-2.47 3.29l-.02.13 3.59 2.78.25.02c2.28-2.1 3.6-5.2 3.6-7.91z"
      />
      <Path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.78-2.93c-1.01.7-2.37 1.2-4.17 1.2-3.18 0-5.88-2.1-6.84-5l-.13.01-3.73 2.89-.05.13C3.22 21.3 7.27 24 12 24z"
      />
      <Path
        fill="#FBBC05"
        d="M5.16 14.37A7.39 7.39 0 0 1 4.76 12c0-.82.15-1.62.39-2.37l-.01-.16-3.78-2.93-.12.06A11.94 11.94 0 0 0 0 12c0 1.94.47 3.77 1.25 5.4l3.91-3.03z"
      />
      <Path
        fill="#EA4335"
        d="M12 4.63c2.25 0 3.77.97 4.64 1.79l3.39-3.31C17.95 1.17 15.24 0 12 0 7.27 0 3.22 2.7 1.25 6.6l3.9 3.03C6.12 6.73 8.82 4.63 12 4.63z"
      />
    </Svg>
  );
}

export default function SignInScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const initialMode: AuthMode = params?.mode === "signup" ? "signup" : "signin";
  const { login, signup, loginWithGoogle } = useAuth();
  const { bg, text, subText, card, border } = useThemeColors();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSignup, setIsSignup] = useState(initialMode === "signup");
  useEffect(() => {
    setIsSignup(initialMode === "signup");
  }, [initialMode]);

  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [pendingGoogleIdToken, setPendingGoogleIdToken] = useState<string | null>(null);
  const { t } = useTranslation();

  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

  useEffect(() => {
    if (!webClientId) return;
    GoogleSignin.configure({
      webClientId,
      scopes: ["openid", "email", "profile"],
    });
  }, [webClientId]);

  const handleForgotPassword = async () => {
    if (!email || !email.trim()) {
      setResetEmail("");
      setShowResetModal(true);
      return;
    }
    try {
      const emailClean = sanitizeOnSubmitEmail(email);
      if (!isValidEmail(emailClean)) {
        Alert.alert(t("auth.reset_enter_email_title"), t("auth.reset_enter_email_body"));
        return;
      }
      await sendPasswordResetEmail(auth, emailClean);
      Alert.alert(t("auth.reset_email_sent_title"), t("auth.reset_email_sent_body"));
    } catch (err: any) {
      Alert.alert(t("auth.reset_error_title"), err?.message || t("common.error_generic", { defaultValue: "Something went wrong" }));
    }
  };

  const handleAuth = async () => {
    if (!email || !password) {
      Alert.alert(t("auth.missing_fields_title"), t("auth.missing_fields_body"));
      return;
    }
    setLoading(true);
    try {
      const emailClean = sanitizeOnSubmitEmail(email);
      if (!isValidEmail(emailClean)) {
        Alert.alert(t("auth.reset_enter_email_title"), t("auth.reset_enter_email_body"));
        setLoading(false);
        return;
      }
      if (isSignup) {
        await signup(emailClean, password);
        Alert.alert(t("auth.account_created_title"), t("auth.account_created_body"));
      } else {
        await login(emailClean, password);
        if (pendingGoogleIdToken) {
          await loginWithGoogle(pendingGoogleIdToken);
          setPendingGoogleIdToken(null);
          Alert.alert(
            t("auth.google_linked_title", { defaultValue: "Google linked" }),
            t("auth.google_linked_body", {
              defaultValue: "You can now sign in with Google or with your password.",
            })
          );
        } else {
          Alert.alert(t("auth.login_success_title"), t("auth.login_success_body"));
        }
      }
      router.replace("/(tabs)/profile");
    } catch (err: any) {
      console.log("🔥 Auth error", err?.code, err?.message);
      const code = err?.code || "";
      const message = getFriendlyAuthError(code, t);
      Alert.alert(t("auth.error_title"), message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (!webClientId) {
      Alert.alert(t("auth.error_title"), t("auth.google_not_configured"));
      return;
    }

    let selectedGoogleIdToken: string | null = null;
    try {
      setGoogleLoading(true);
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const response = await GoogleSignin.signIn();
      if (isCancelledResponse(response)) return;
      if (!isSuccessResponse(response) || !response.data.idToken) {
        Alert.alert(t("auth.error_title"), t("auth.google_not_configured"));
        return;
      }

      const idToken = response.data.idToken;
      selectedGoogleIdToken = idToken;
      await loginWithGoogle(idToken);
      setPendingGoogleIdToken(null);
      Alert.alert(t("auth.login_success_title"), t("auth.login_success_body"));
      router.replace("/(tabs)/profile");
    } catch (err: any) {
      console.error("Google sign in error:", err?.code, err?.message || err);
      if (err?.code === statusCodes.SIGN_IN_CANCELLED || err?.code === statusCodes.IN_PROGRESS) return;
      if (GOOGLE_EMAIL_EXISTS_CODES.has(err?.code || "")) {
        const fallbackEmail = getEmailFromGoogleIdToken(selectedGoogleIdToken || "");
        if (fallbackEmail) setEmail(fallbackEmail);
        setPassword("");
        setIsSignup(false);
        setPendingGoogleIdToken(selectedGoogleIdToken);
        Alert.alert(
          t("auth.google_link_password_title", { defaultValue: "Confirm your password" }),
          t("auth.google_link_password_body", {
            defaultValue:
              "This email already has a password account. Sign in with your password once and we’ll link Google to it.",
          })
        );
        return;
      }
      const message =
        err?.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE
          ? t("auth.google_play_services_unavailable", {
              defaultValue: "Google Play Services is not available or needs to be updated.",
            })
          : getFriendlyAuthError(err?.code || "", t);
      Alert.alert(t("auth.error_title"), message);
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <>
      <StatusBar translucent={false} backgroundColor="#293a53" barStyle="light-content" />
      <Stack.Screen
        options={{
          headerShown: true,
          title: isSignup ? t("auth.signup_title") : t("auth.signin_title"),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
          headerBackVisible: true,
          headerRight: () => null,
        }}
      />
      <KeyboardAwareScrollView contentContainerStyle={{ flexGrow: 1 }} enableOnAndroid keyboardShouldPersistTaps="handled">
        <SafeAreaView style={[styles.container, { backgroundColor: bg }]} edges={["top","left","right","bottom"]}>
          <Text style={[styles.title, { color: text }]}>
            {isSignup ? t("auth.create_account_title") : t("auth.welcome_back")}
          </Text>

          <TextInput
            style={[styles.input, { borderColor: border, color: text, backgroundColor: card }]}
            placeholder={t("auth.email_placeholder")}
            placeholderTextColor={subText}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="emailAddress"
            autoComplete="email"
            keyboardType="email-address"
            maxLength={254}
            value={email}
            onChangeText={(v) => setEmail(sanitizeEmailInput(v))}
            editable={!loading && !googleLoading}
          />
          <View style={styles.passwordContainer}>
            <TextInput
              style={[styles.input, styles.passwordInput, { borderColor: border, color: text, backgroundColor: card }]}
              placeholder={t("auth.password_placeholder")}
              placeholderTextColor={subText}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              autoComplete="password"
              maxLength={256}
              value={password}
              onChangeText={(v) => setPassword(sanitizePasswordInput(v))}
              editable={!loading && !googleLoading}
            />
            <TouchableOpacity
              onPress={() => setShowPassword((prev) => !prev)}
              style={styles.passwordToggle}
              disabled={loading || googleLoading}
            >
              <Text style={{ color: subText, fontWeight: "600" }}>
                {showPassword ? t("auth.hide_password") : t("auth.show_password")}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={{ width: "100%", alignItems: "flex-end", marginBottom: 8 }}>
            <TouchableOpacity onPress={handleForgotPassword} disabled={loading || googleLoading}>
              <Text style={{ color: "#E27D60", fontWeight: "600" }}>{t("auth.forgot_password_link")}</Text>
            </TouchableOpacity>
          </View>
          <Modal visible={showResetModal} transparent animationType="fade" onRequestClose={() => setShowResetModal(false)}>
            <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center", padding: 20 }}>
              <View style={{ width: 320, backgroundColor: card, borderRadius: 12, padding: 16 }}>
                <Text style={{ color: text, fontSize: 18, fontWeight: "700", marginBottom: 8 }}>
                  {t("auth.reset_enter_email_title")}
                </Text>
                <Text style={{ color: subText, marginBottom: 12 }}>{t("auth.reset_enter_email_body")}</Text>
                <TextInput
                  style={[styles.input, { borderColor: border, color: text, backgroundColor: card, marginBottom: 12 }]}
                  placeholder={t("auth.email_placeholder")}
                  placeholderTextColor={subText}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="emailAddress"
                  autoComplete="email"
                  keyboardType="email-address"
                  maxLength={254}
                  value={resetEmail}
                  onChangeText={(v) => setResetEmail(sanitizeEmailInput(v))}
                  editable={!loading && !googleLoading}
                />
                <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                  <TouchableOpacity
                    onPress={() => setShowResetModal(false)}
                    style={{ paddingVertical: 10, paddingHorizontal: 12, marginRight: 8 }}
                    disabled={loading || googleLoading}
                  >
                    <Text style={{ color: text, fontWeight: "600" }}>{t("common.cancel")}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={async () => {
                      const v = sanitizeOnSubmitEmail(resetEmail || "");
                      if (!isValidEmail(v)) {
                        Alert.alert(t("auth.reset_enter_email_title"), t("auth.reset_enter_email_body"));
                        return;
                      }
                      try {
                        await sendPasswordResetEmail(auth, v);
                        setShowResetModal(false);
                        Alert.alert(t("auth.reset_email_sent_title"), t("auth.reset_email_sent_body"));
                      } catch (err: any) {
                        Alert.alert(
                          t("auth.reset_error_title"),
                          err?.message || t("common.error_generic", { defaultValue: "Something went wrong" })
                        );
                      }
                    }}
                    style={{ paddingVertical: 10, paddingHorizontal: 12 }}
                    disabled={loading || googleLoading}
                  >
                    <Text style={{ color: "#E27D60", fontWeight: "700" }}>{t("common.confirm")}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>

          <TouchableOpacity
            style={[styles.button, (loading || googleLoading) && { opacity: 0.6 }]}
            onPress={handleAuth}
            disabled={loading || googleLoading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>
                {isSignup ? t("auth.signup_button") : t("auth.signin_button")}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.googleButton, (loading || googleLoading) && { opacity: 0.6 }]}
            onPress={handleGoogleSignIn}
            disabled={loading || googleLoading}
          >
            {googleLoading ? (
              <ActivityIndicator color="#1f2933" />
            ) : (
              <View style={styles.googleButtonContent}>
                <View style={styles.googleLogoMark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <GoogleLogo size={18} />
                </View>
                <Text style={styles.googleButtonText}>{t("auth.google_button")}</Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setIsSignup(!isSignup)} disabled={loading || googleLoading}>
            <Text style={[styles.switchText, { color: text }]}>
              {isSignup ? (
                <>
                  {t("auth.switch_have_account")} <Text style={styles.linkText}>{t("auth.link_signin")}</Text>
                </>
              ) : (
                <>
                  {t("auth.switch_no_account")} <Text style={styles.linkText}>{t("auth.link_signup")}</Text>
                </>
              )}
            </Text>
          </TouchableOpacity>
        </SafeAreaView>
      </KeyboardAwareScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20 },
  title: { fontSize: 24, fontWeight: "bold", marginBottom: 24, color: "#293a53" },
  input: { width: "100%", borderWidth: 1, borderColor: "#ccc", borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 16 },
  passwordContainer: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  passwordInput: {
    flex: 1,
    marginBottom: 0,
  },
  passwordToggle: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  fallbackClose: {
    position: "absolute",
    top: 10,
    right: 10,
    zIndex: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  fallbackCloseText: {
    fontSize: 18,
    fontWeight: "700",
  },
  button: {
    width: "100%",
    backgroundColor: "#E27D60",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 6,
    marginBottom: 12,
  },
  googleButton: {
    width: "100%",
    backgroundColor: "#fff",
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#d6dce5",
    marginBottom: 20,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  buttonText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
  googleButtonContent: {
    width: "100%",
    minHeight: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  googleLogoMark: {
    width: 24,
    height: 24,
    borderRadius: 999,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#edf0f4",
  },
  googleButtonText: { color: "#1f2933", fontWeight: "700", fontSize: 16 },
  switchText: { color: "#293a53", marginTop: 10, fontSize: 15, textAlign: "center" },
  linkText: { color: "#E27D60", fontWeight: "600" },
});
