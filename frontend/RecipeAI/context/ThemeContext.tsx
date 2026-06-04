import React, { createContext, useState, useContext, useEffect, useCallback, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { PREFS_UPDATED, prefsEvents } from "../lib/prefs";

type Theme = "light" | "dark";

const ThemeContext = createContext<{
  theme: Theme;
  setThemeMode: (next: Theme) => Promise<void>;
  toggleTheme: () => void;
}>({
  theme: "light",
  setThemeMode: async () => {},
  toggleTheme: () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    (async () => {
      try {
        const saved = (await AsyncStorage.getItem("@theme")) || (await AsyncStorage.getItem("theme"));
        if (saved === "light" || saved === "dark") setTheme(saved);
      } catch {}
    })();

    const onPrefsUpdated = (changed: any) => {
      const next =
        changed?.themeMode === "dark"
          ? "dark"
          : changed?.themeMode === "light" || changed?.themeMode === "system"
            ? "light"
            : null;
      if (next) {
        setTheme(next);
      }
    };

    prefsEvents.on(PREFS_UPDATED, onPrefsUpdated);
    return () => {
      prefsEvents.off(PREFS_UPDATED, onPrefsUpdated);
    };
  }, []);

  const setThemeMode = useCallback(async (next: Theme) => {
    setTheme(next);
    try {
      await AsyncStorage.setItem("@theme", next);
      await AsyncStorage.setItem("theme", next);
    } catch {}
  }, []);

  const toggleTheme = useCallback(async () => {
    const next = theme === "light" ? "dark" : "light";
    await setThemeMode(next);
  }, [setThemeMode, theme]);

  const value = useMemo(
    () => ({ theme, setThemeMode, toggleTheme }),
    [theme, setThemeMode, toggleTheme]
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);

// 🎨 Paleta de branding
// Light mode: fundo claro (#FFFDF7), textos escuros
// Dark mode: fundo escuro (#16120E), textos claros
export const useThemeColors = () => {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const bg = isDark ? "#16120E" : "#FFFDF7";
  const card = isDark ? "#241B13" : "#FFFFFF";
  const text = isDark ? "#FFF8EA" : "#2B2118";
  const subText = isDark ? "#C9B99E" : "#7B6A57";
  const border = isDark ? "#4A3827" : "#EADDC2";
  const primary = "#8F5E43";
  const secondary = "#F2D6A3";
  const cta = "#8A4B16";

  return {
    isDark,

    // Backgrounds
    bg,
    card,
    surface: card,
    surfaceAlt: isDark ? "#1E1711" : "#FFF8EA",
    inputBg: isDark ? bg : "#FFFFFF",
    disabledBg: isDark ? "rgba(255, 255, 255, 0.04)" : "#F0F0F0",
    subtleSurface: isDark ? bg : "#EEEEEE",
    overlaySurface: isDark ? "#1F1710" : "#FFFFFF",

    // Textos
    text,
    subText,
    mutedText: isDark ? "#C8CED8" : "#666666",
    softText: isDark ? "#AEB6C2" : "#7A7A7A",
    sectionTitle: isDark ? "#FFF8EA" : primary,
    placeholder: isDark ? "#8E98A6" : "#888888",

    // Bordas
    border,
    subtleBorder: isDark ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.07)",

    // Headers
    headerBg: primary,
    headerText: "#FFFFFF",
    tabBarBg: primary,
    tabBarActive: secondary,
    tabBarInactive: "#FFFFFF",

    // Botões
    primary, // headers / botões primários
    secondary, // botões secundários / tags suaves
    cta, // botões de ação (CTA: gerar receita, salvar, etc.)
    onPrimary: "#FFFFFF",
    onCta: "#FFFFFF",
    onSecondary: "#2B2118",

    // Icons / accents
    icon: isDark ? text : cta,
    iconMuted: subText,
    accentText: isDark ? secondary : cta,
    softAccentBg: isDark ? "rgba(242, 214, 163, 0.14)" : "#F6EBD3",
    softAccentBorder: isDark ? "rgba(242, 214, 163, 0.38)" : "#EADDC2",
    chipBg: isDark ? card : "#F6EBD3",
    selectedBg: cta,
    selectedText: "#FFFFFF",

    // Feedback
    danger: isDark ? "#FFB4A8" : "#C94B3D",
    dangerStrong: "#E53935",
    success: isDark ? "#8FD6A3" : "#3F8F5B",
    warning: isDark ? "#F2D6A3" : "#B7791F",

    // Modal layers
    modalBackdrop: isDark ? "rgba(0,0,0,0.56)" : "rgba(0,0,0,0.28)",
  };
};
