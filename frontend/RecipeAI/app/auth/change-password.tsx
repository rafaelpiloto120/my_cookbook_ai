import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  updatePassword,
} from "firebase/auth";

import { auth } from "../../firebaseConfig";
import { useThemeColors } from "../../context/ThemeContext";
import { trackActivityEventBestEffort } from "../../lib/activity/client";

const INVISIBLE_REGEX = /[\u200B-\u200D\uFEFF\u202E\u202D\u202A\u202B\u202C]/g;
const CONTROL_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const PASSWORD_MIN_LENGTH = 6;

const normalizeNFKC = (value: string) => {
  try {
    return value.normalize("NFKC");
  } catch {
    return value;
  }
};

const sanitizePasswordInput = (value: string) =>
  normalizeNFKC(value).replace(INVISIBLE_REGEX, "").replace(CONTROL_REGEX, "").slice(0, 256);

function PasswordInput({
  value,
  onChangeText,
  placeholder,
  show,
  onToggleShow,
  editable,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  show: boolean;
  onToggleShow: () => void;
  editable: boolean;
}) {
  const { text, subText, card, border } = useThemeColors();

  return (
    <View style={[styles.passwordContainer, { borderColor: border, backgroundColor: card }]}>
      <TextInput
        style={[styles.passwordInput, { color: text }]}
        placeholder={placeholder}
        placeholderTextColor={subText}
        secureTextEntry={!show}
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="password"
        autoComplete="password"
        maxLength={256}
        value={value}
        onChangeText={(next) => onChangeText(sanitizePasswordInput(next))}
        editable={editable}
      />
      <TouchableOpacity
        onPress={onToggleShow}
        style={styles.passwordToggle}
        disabled={!editable}
        hitSlop={8}
        accessibilityRole="button"
      >
        <MaterialIcons name={show ? "visibility-off" : "visibility"} size={22} color={subText} />
      </TouchableOpacity>
    </View>
  );
}

export default function ChangePasswordScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { bg, text, subText, card, border, headerBg, headerText } = useThemeColors();
  const user = auth.currentUser;
  const email = user?.email || "";
  const hasPasswordProvider = useMemo(
    () => !!user?.providerData?.some((provider) => provider.providerId === "password"),
    [user]
  );

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  const disabled = loading || !user;

  const showError = (message: string) => {
    Alert.alert(t("auth.error_title", { defaultValue: "Error" }), message);
  };

  const handleSendSetupEmail = async () => {
    if (!email) {
      showError(
        t("auth.change_password_no_email", {
          defaultValue: "This account does not have an email address available.",
        })
      );
      return;
    }

    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email);
      Alert.alert(
        t("auth.reset_email_sent_title", { defaultValue: "Reset email sent" }),
        t("auth.change_password_setup_sent", {
          defaultValue: "Check your inbox to set a password for this account.",
        }),
        [{ text: t("common.ok", { defaultValue: "OK" }), onPress: () => router.back() }]
      );
    } catch (err: any) {
      showError(err?.message || t("common.error_generic", { defaultValue: "Something went wrong" }));
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async () => {
    if (!user || !email) {
      showError(
        t("auth.change_password_no_email", {
          defaultValue: "This account does not have an email address available.",
        })
      );
      return;
    }
    if (!currentPassword || !newPassword || !confirmPassword) {
      showError(
        t("auth.change_password_missing_fields", {
          defaultValue: "Please fill in all password fields.",
        })
      );
      return;
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      showError(
        t("auth.change_password_min_length", {
          count: PASSWORD_MIN_LENGTH,
          defaultValue: "Your new password must have at least {{count}} characters.",
        })
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      showError(
        t("auth.change_password_mismatch", {
          defaultValue: "The new passwords do not match.",
        })
      );
      return;
    }
    if (currentPassword === newPassword) {
      showError(
        t("auth.change_password_same", {
          defaultValue: "Choose a new password that is different from your current password.",
        })
      );
      return;
    }

    setLoading(true);
    try {
      const credential = EmailAuthProvider.credential(email, currentPassword);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPassword);
      trackActivityEventBestEffort({
        auth,
        type: "auth",
        action: "password_changed",
        source: "change_password",
        objectId: user.uid,
      });
      Alert.alert(
        t("auth.change_password_success_title", { defaultValue: "Password updated" }),
        t("auth.change_password_success_body", {
          defaultValue: "Your password has been changed successfully.",
        }),
        [{ text: t("common.ok", { defaultValue: "OK" }), onPress: () => router.back() }]
      );
    } catch (err: any) {
      const code = err?.code || "";
      const message =
        code === "auth/wrong-password" || code === "auth/invalid-credential"
          ? t("auth.error_wrong_password", { defaultValue: "Incorrect password. Please try again." })
          : code === "auth/weak-password"
            ? t("auth.error_weak_password", {
                defaultValue: "Your password is too weak. Please use a stronger one.",
              })
            : code === "auth/requires-recent-login"
              ? t("auth.requires_recent_login", {
                  defaultValue: "For security, please sign in again before changing your password.",
                })
              : err?.message || t("common.error_generic", { defaultValue: "Something went wrong" });
      showError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: t("profile.change_password", { defaultValue: "Change Password" }),
          headerStyle: { backgroundColor: headerBg },
          headerTintColor: headerText,
          headerTitleAlign: "center",
        }}
      />
      <KeyboardAwareScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        enableOnAndroid
        keyboardShouldPersistTaps="handled"
      >
        <SafeAreaView style={[styles.container, { backgroundColor: bg }]} edges={["left", "right", "bottom"]}>
          <Text style={[styles.title, { color: text }]}>
            {t("auth.change_password_title", { defaultValue: "Change your password" })}
          </Text>
          <Text style={[styles.subtitle, { color: subText }]}>
            {hasPasswordProvider
              ? t("auth.change_password_subtitle", {
                  defaultValue: "Confirm your current password before setting a new one.",
                })
              : t("auth.change_password_google_subtitle", {
                  defaultValue:
                    "This account uses Google sign-in. You can set a password through a secure email link.",
                })}
          </Text>

          <View style={[styles.panel, { backgroundColor: card, borderColor: border }]}>
            <View style={styles.emailRow}>
              <MaterialIcons name="mail-outline" size={20} color={subText} />
              <Text style={[styles.emailText, { color: text }]} numberOfLines={1}>
                {email || t("auth.email_placeholder", { defaultValue: "Email" })}
              </Text>
            </View>
          </View>

          {hasPasswordProvider ? (
            <>
              <PasswordInput
                value={currentPassword}
                onChangeText={setCurrentPassword}
                placeholder={t("auth.current_password_placeholder", {
                  defaultValue: "Current password",
                })}
                show={showCurrent}
                onToggleShow={() => setShowCurrent((current) => !current)}
                editable={!disabled}
              />
              <PasswordInput
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder={t("profile.new_password_placeholder", {
                  defaultValue: "Enter a new password",
                })}
                show={showNew}
                onToggleShow={() => setShowNew((current) => !current)}
                editable={!disabled}
              />
              <PasswordInput
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder={t("auth.confirm_new_password_placeholder", {
                  defaultValue: "Confirm new password",
                })}
                show={showConfirm}
                onToggleShow={() => setShowConfirm((current) => !current)}
                editable={!disabled}
              />
              <Text style={[styles.helpText, { color: subText }]}>
                {t("auth.change_password_requirement", {
                  count: PASSWORD_MIN_LENGTH,
                  defaultValue: "Use at least {{count}} characters.",
                })}
              </Text>
              <TouchableOpacity
                style={[styles.button, disabled && { opacity: 0.6 }]}
                onPress={handleChangePassword}
                disabled={disabled}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>
                    {t("auth.change_password_button", { defaultValue: "Update password" })}
                  </Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              style={[styles.button, disabled && { opacity: 0.6 }]}
              onPress={handleSendSetupEmail}
              disabled={disabled}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>
                  {t("auth.change_password_send_setup", { defaultValue: "Send setup email" })}
                </Text>
              )}
            </TouchableOpacity>
          )}
        </SafeAreaView>
      </KeyboardAwareScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: "800",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 22,
  },
  panel: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  emailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  emailText: {
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
  },
  passwordContainer: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 8,
    fontSize: 15,
  },
  passwordToggle: {
    width: 46,
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  helpText: {
    fontSize: 13,
    marginTop: -2,
    marginBottom: 14,
  },
  button: {
    width: "100%",
    backgroundColor: "#8A4B16",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 4,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 16,
  },
});
