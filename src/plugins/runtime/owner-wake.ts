// Contract-gated plugin wake for a live subagent owner session.
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  grantLiveSubagentOwnerWake,
  isLiveSubagentSession,
  OWNER_WAKE_REASON_PREFIX,
  revokeLiveSubagentOwnerWake,
} from "../../infra/heartbeat-owner-wake-grants.js";
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import type {
  RequestLiveSubagentOwnerWakeOptions,
  RequestLiveSubagentOwnerWakeResult,
} from "./types-core.js";

export const LIVE_SUBAGENT_OWNER_WAKE_CONTRACT = "live-subagent-session";

/** Wakes an existing, non-ended subagent session; never creates or revives one. */
export function requestLiveSubagentOwnerWakeForPlugin(
  pluginId: string,
  opts: RequestLiveSubagentOwnerWakeOptions,
): RequestLiveSubagentOwnerWakeResult {
  const sessionKey = typeof opts?.sessionKey === "string" ? opts.sessionKey.trim() : "";
  if (!sessionKey || !isSubagentSessionKey(sessionKey)) {
    return { ok: false, reason: "not-a-subagent-session-key" };
  }
  const agentId = normalizeAgentId(resolveAgentIdFromSessionKey(sessionKey));
  const cfg = getRuntimeConfig();
  const entry = loadSessionEntry({
    agentId,
    storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    sessionKey,
  });
  if (!entry) {
    return { ok: false, reason: "session-not-found" };
  }
  if (!isLiveSubagentSession(sessionKey, entry)) {
    return { ok: false, reason: "session-ended" };
  }
  grantLiveSubagentOwnerWake({ pluginId, sessionKey });
  try {
    requestHeartbeat({
      source: "hook",
      intent: "immediate",
      // Plugin-supplied text never reaches the policy reason; the producer id does.
      reason: `${OWNER_WAKE_REASON_PREFIX}${pluginId}`,
      agentId,
      sessionKey,
      heartbeat: { target: "none" },
    });
  } catch (error) {
    revokeLiveSubagentOwnerWake(sessionKey);
    throw error;
  }
  return { ok: true };
}
