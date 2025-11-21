type AuthMode = "signin" | "signup";

import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import React, { useState, useEffect } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Modal } from "react-native";
import { useAuth } from "../../context/AuthContext";
import { useThemeColors } from "../../context/ThemeContext";
import { useTranslation } from "react-i18next";
import { sendPasswordResetEmail, GoogleAuthProvider, signInWithCredential } from "firebase/auth";
import * as WebBrowser from "expo-web-browser";
import * as Google from "expo-auth-session/providers/google";
import { auth } from "../../firebaseConfig";

WebBrowser.maybeCompleteAuthSession();

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

export default function SignInScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const initialMode: AuthMode = params?.mode === "signup" ? "signup" : "signin";
  const { login, signup } = useAuth();
  const { bg, text, subText, card, border } = useThemeColors();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignup, setIsSignup] = useState(initialMode === "signup");
  useEffect(() => {
    setIsSignup(initialMode === "signup");
  }, [initialMode]);

  const [googleLoading, setGoogleLoading] = useState(false);

  // Google Auth: configure ID token flow for Android
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
  });

  useEffect(() => {
    const handleGoogleResponse = async () => {
      if (!response || response.type !== "success") return;

      const idToken = (response.params as any)?.id_token;
      if (!idToken) {
        Alert.alert(t("auth.error_title"), t("auth.google_not_configured"));
        return;
      }

      try {
        setGoogleLoading(true);
        const credential = GoogleAuthProvider.credential(idToken);
        await signInWithCredential(auth, credential);
        Alert.alert(t("auth.login_success_title"), t("auth.login_success_body"));
        router.replace("/(tabs)/profile");
      } catch (err: any) {
        console.error("Google sign in error:", err);
        const code = err?.code || "";
        const message = getFriendlyAuthError(code, t);
        Alert.alert(t("auth.error_title"), message);
      } finally {
        setGoogleLoading(false);
      }
    };

    handleGoogleResponse();
  }, [response]);

  const [loading, setLoading] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const { t } = useTranslation();

  // Google Sign-In not configured yet

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
        Alert.alert(t("auth.login_success_title"), t("auth.login_success_body"));
      }
      router.replace("/(tabs)/profile");
    } catch (err: any) {
      const code = err?.code || "";
      const message = getFriendlyAuthError(code, t);
      Alert.alert(t("auth.error_title"), message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (!request) {
      Alert.alert(
        t("auth.error_title"),
        t("auth.google_not_configured"),
      );
      return;
    }
    try {
      setGoogleLoading(true);
      await promptAsync();
    } catch (err) {
      console.error("Google prompt error:", err);
      setGoogleLoading(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: isSignup ? t("auth.signup_title") : t("auth.signin_title"),
          headerStyle: { backgroundColor: "#293a53" },
          headerTintColor: "#fff",
          headerTitleAlign: "center",
        }}
      />
      <KeyboardAwareScrollView contentContainerStyle={{ flexGrow: 1 }} enableOnAndroid keyboardShouldPersistTaps="handled">
        <View style={[styles.container, { backgroundColor: bg }]}>
          <Text style={[styles.title, { color: text }]}>{isSignup ? t("auth.create_account_title") : t("auth.welcome_back")}</Text>

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
            editable={!loading}
          />
          <TextInput
            style={[styles.input, { borderColor: border, color: text, backgroundColor: card }]}
            placeholder={t("auth.password_placeholder")}
            placeholderTextColor={subText}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            autoComplete="password"
            maxLength={256}
            value={password}
            onChangeText={(v) => setPassword(sanitizePasswordInput(v))}
            editable={!loading}
          />
          <View style={{ width: "100%", alignItems: "flex-end", marginBottom: 8 }}>
            <TouchableOpacity onPress={handleForgotPassword} disabled={loading}>
              <Text style={{ color: "#E27D60", fontWeight: "600" }}>{t("auth.forgot_password_link")}</Text>
            </TouchableOpacity>
          </View>
          <Modal visible={showResetModal} transparent animationType="fade" onRequestClose={() => setShowResetModal(false)}>
            <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center", padding: 20 }}>
              <View style={{ width: 320, backgroundColor: card, borderRadius: 12, padding: 16 }}>
                <Text style={{ color: text, fontSize: 18, fontWeight: "700", marginBottom: 8 }}>{t("auth.reset_enter_email_title")}</Text>
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
                  editable={!loading}
                />
                <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                  <TouchableOpacity
                    onPress={() => setShowResetModal(false)}
                    style={{ paddingVertical: 10, paddingHorizontal: 12, marginRight: 8 }}
                    disabled={loading}
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
                        Alert.alert(t("auth.reset_error_title"), err?.message || t("common.error_generic", { defaultValue: "Something went wrong" }));
                      }
                    }}
                    style={{ paddingVertical: 10, paddingHorizontal: 12 }}
                    disabled={loading}
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
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{isSignup ? t("auth.signup_button") : t("auth.signin_button")}</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.googleButton, (loading || googleLoading) && { opacity: 0.6 }]}
            onPress={handleGoogleSignIn}
            disabled={loading || googleLoading}
          >
            {googleLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.googleButtonText}>{t("auth.google_button")}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setIsSignup(!isSignup)} disabled={loading}>
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
        </View>
      </KeyboardAwareScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20 },
  title: { fontSize: 24, fontWeight: "bold", marginBottom: 24, color: "#293a53" },
  input: { width: "100%", borderWidth: 1, borderColor: "#ccc", borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 16 },
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
    backgroundColor: "#4285F4",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
    marginBottom: 20,
  },
  buttonText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
  googleButtonText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  switchText: { color: "#293a53", marginTop: 10, fontSize: 15, textAlign: "center" },
  linkText: { color: "#E27D60", fontWeight: "600" },
});
