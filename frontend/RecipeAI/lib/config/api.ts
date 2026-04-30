import Constants from "expo-constants";

function getConfiguredApiBaseUrl() {
  const value = process.env.EXPO_PUBLIC_API_URL;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getExpoDevHost() {
  const candidates = [
    (Constants as any)?.expoConfig?.hostUri,
    (Constants as any)?.manifest2?.extra?.expoGo?.debuggerHost,
    (Constants as any)?.manifest?.debuggerHost,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const host = candidate.trim().split(":")[0]?.trim();
    if (!host) continue;
    return host;
  }

  return null;
}

function isLocalDevHost(hostname: string) {
  return (
    hostname === "10.0.2.2" ||
    hostname === "127.0.0.1" ||
    hostname === "localhost"
  );
}

export function getApiBaseUrl() {
  const configured = getConfiguredApiBaseUrl();
  if (!configured) return null;
  if (!__DEV__) return configured;

  try {
    const url = new URL(configured);
    if (!isLocalDevHost(url.hostname)) return configured;

    const devHost = getExpoDevHost();
    if (!devHost || isLocalDevHost(devHost)) return configured;

    url.hostname = devHost;
    return url.toString().replace(/\/$/, "");
  } catch {
    return configured;
  }
}

