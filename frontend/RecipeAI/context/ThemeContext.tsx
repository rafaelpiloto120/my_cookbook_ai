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
// Light mode: fundo claro (#F5F5F5), textos escuros
// Dark mode: fundo escuro (#1C1C1C), textos claros
export const useThemeColors = () => {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  return {
    isDark,

    // Backgrounds
    bg: isDark ? "#1C1C1C" : "#F5F5F5",
    card: isDark ? "#2A2A2A" : "#FFFFFF",

    // Textos
    text: isDark ? "#FFFFFF" : "#212121",
    subText: isDark ? "#AAAAAA" : "#53687E",

    // Bordas
    border: isDark ? "#555555" : "#CCCCCC",

    // Headers
    headerBg: isDark ? "#1C1C1C" : "#F5F5F5",
    headerText: isDark ? "#FFFFFF" : "#212121",

    // Botões
    primary: "#3A4454", // headers / botões primários
    secondary: "#C2B2B4", // botões secundários / tags suaves
    cta: "#E27D60", // botões de ação (CTA: gerar receita, salvar, etc.)

    // Modal layers
    modalBackdrop: isDark ? "rgba(0,0,0,0.56)" : "rgba(0,0,0,0.28)",
  };
};
