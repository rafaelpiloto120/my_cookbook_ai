import type { Auth } from "firebase/auth";

import { getApiBaseUrl } from "../config/api";
import { getDeviceId } from "../../utils/deviceId";

export type ActivityEventStatus = "succeeded" | "failed" | "started";

export type TrackActivityEventInput = {
  auth: Auth;
  backendUrl?: string | null;
  appEnv?: string | null;
  type: string;
  action: string;
  source?: string | null;
  status?: ActivityEventStatus | string | null;
  objectId?: string | null;
  objectPath?: string | null;
  metadata?: Record<string, unknown> | null;
};

export async function trackActivityEvent(input: TrackActivityEventInput): Promise<void> {
  try {
    const backendUrl = input.backendUrl ?? getApiBaseUrl();
    const user = input.auth.currentUser;
    if (!backendUrl || !user || !input.type || !input.action) return;

    const [idToken, deviceId] = await Promise.all([
      user.getIdToken().catch(() => null),
      getDeviceId().catch(() => null),
    ]);
    if (!idToken) return;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
      "x-app-env": input.appEnv ?? process.env.EXPO_PUBLIC_APP_ENV ?? "local",
      "x-user-id": user.uid,
    };
    if (deviceId) headers["x-device-id"] = deviceId;

    fetch(`${backendUrl}/activity-events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: input.type,
        action: input.action,
        source: input.source ?? null,
        status: input.status ?? "succeeded",
        objectId: input.objectId ?? null,
        objectPath: input.objectPath ?? null,
        metadata: input.metadata ?? {},
      }),
    }).catch(() => undefined);
  } catch {
    // Activity logging must never block the product action the user just completed.
  }
}

export function trackActivityEventBestEffort(input: TrackActivityEventInput): void {
  void trackActivityEvent(input);
}
