// lib/sync/conflictStrategy.ts
import type { LocalEntity } from "./types";

// `updatedAt` may be missing on legacy records – treat missing as 0.
export function resolveByUpdatedAt<
  T extends { updatedAt?: number | null }
>(
  local: LocalEntity<T> | null,
  remote: T | null
): { winner: "local" | "remote" | "none"; merged?: T } {
  if (!local && !remote) {
    return { winner: "none" };
  }
  if (!local && remote) {
    return { winner: "remote", merged: remote };
  }
  if (local && !remote) {
    return { winner: "local", merged: local.data };
  }

  const localUpdated = local!.data.updatedAt ?? 0;
  const remoteUpdated = remote!.updatedAt ?? 0;

  if (localUpdated > remoteUpdated) {
    return { winner: "local", merged: local!.data };
  }
  if (remoteUpdated > localUpdated) {
    return { winner: "remote", merged: remote! };
  }

  // Same timestamp → prefer remote to keep Firestore consistent
  return { winner: "remote", merged: remote! };
}