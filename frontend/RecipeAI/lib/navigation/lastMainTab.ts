import AsyncStorage from "@react-native-async-storage/async-storage";

export type MainTabRoute = "history" | "index" | "my-day" | "profile";

export const LAST_MAIN_TAB_KEY = "navigation:lastMainTab";

const MAIN_TAB_ROUTES = new Set<MainTabRoute>(["history", "index", "my-day", "profile"]);

export function isMainTabRoute(value: string | null | undefined): value is MainTabRoute {
  return !!value && MAIN_TAB_ROUTES.has(value as MainTabRoute);
}

export function mainTabFromPathname(pathname: string | null | undefined): MainTabRoute | null {
  if (!pathname) return null;
  if (pathname === "/" || pathname === "/index" || pathname === "/(tabs)" || pathname === "/(tabs)/index") {
    return "index";
  }
  if (pathname === "/history" || pathname === "/(tabs)/history") return "history";
  if (pathname === "/my-day" || pathname === "/(tabs)/my-day") return "my-day";
  if (pathname === "/profile" || pathname === "/(tabs)/profile") return "profile";
  return null;
}

export async function saveLastMainTab(route: MainTabRoute) {
  await AsyncStorage.setItem(LAST_MAIN_TAB_KEY, route);
}

export async function loadLastMainTab() {
  const stored = await AsyncStorage.getItem(LAST_MAIN_TAB_KEY);
  return isMainTabRoute(stored) ? stored : null;
}
