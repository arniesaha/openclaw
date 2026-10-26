// Short-lived grants that let a contract-gated plugin wake a live subagent session.
// Only the plugin runtime facade may create grants; ordinary heartbeats never do.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isTerminalSessionStatus, type SessionEntry } from "../config/sessions/types.js";

export const LIVE_SUBAGENT_OWNER_WAKE_GRANT_TTL_MS = 2 * 60_000;

const grants = new Map<string, { pluginId: string; expiresAt: number }>();

function grantKey(sessionKey: string): string {
  return normalizeLowercaseStringOrEmpty(sessionKey);
}

/** A subagent session is live only while its row exists and no run has ended or failed. */
export function isLiveSubagentSessionEntry(
  entry: Pick<SessionEntry, "endedAt" | "status"> | undefined,
): boolean {
  return (
    entry !== undefined && entry.endedAt === undefined && !isTerminalSessionStatus(entry.status)
  );
}

export function grantLiveSubagentOwnerWake(params: {
  pluginId: string;
  sessionKey: string;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  for (const [key, grant] of grants) {
    if (grant.expiresAt <= now) {
      grants.delete(key);
    }
  }
  grants.set(grantKey(params.sessionKey), {
    pluginId: params.pluginId,
    expiresAt: now + LIVE_SUBAGENT_OWNER_WAKE_GRANT_TTL_MS,
  });
}

export function hasLiveSubagentOwnerWakeGrant(sessionKey: string, now = Date.now()): boolean {
  const grant = grants.get(grantKey(sessionKey));
  return grant !== undefined && grant.expiresAt > now;
}

export function revokeLiveSubagentOwnerWake(sessionKey: string): void {
  grants.delete(grantKey(sessionKey));
}

export function resetLiveSubagentOwnerWakeGrantsForTest(): void {
  grants.clear();
}
