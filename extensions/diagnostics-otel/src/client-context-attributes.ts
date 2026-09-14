import type { DiagnosticEventPrivateData } from "../api.js";

/** The opaque, core-bounded attribution bag (depth/keys/bytes already capped upstream). */
type ClientContextBag = NonNullable<DiagnosticEventPrivateData["clientContext"]>;

/** Trusted lifecycle attribution joined onto the selected model-call trace spans. */
export type SessionDiagnosticAttribution = Readonly<{
  clientContext?: ClientContextBag;
  sessionCorrelationId?: string;
}>;

/** Defensive cap in case a value slips past the core size bounds. */
const MAX_CLIENT_CONTEXT_ATTRIBUTE_CHARS = 4096;

/**
 * Join keys shared by the lifecycle seed events (`session.state` / `message.queued`,
 * which carry clientContext) and the `model.call.*` events (which do not). Both
 * event families expose `sessionId` and/or `sessionKey`; we return every present
 * candidate so the cache can store/resolve under all of them and never miss the
 * join when the two event types populate different identity fields.
 */
export function clientContextKeys(evt: { sessionId?: string; sessionKey?: string }): string[] {
  const keys: string[] = [];
  if (evt.sessionId) {
    keys.push(evt.sessionId);
  }
  if (evt.sessionKey) {
    keys.push(evt.sessionKey);
  }
  return keys;
}

/**
 * Stamp generic `openclaw.client.<key>` attributes from the opaque bag onto a span
 * attribute object. Vendor-neutral: core never interprets these keys and neither do
 * we — a downstream OTel Collector renames e.g. `openclaw.client.agentId` ->
 * `prov.agent.id`. Scalars are set directly; nested values are JSON-encoded and
 * bounded; null/undefined are skipped.
 */
export function assignClientContextAttributes(
  attributes: Record<string, string | number | boolean>,
  clientContext: ClientContextBag | undefined,
): void {
  if (!clientContext) {
    return;
  }
  for (const key of Object.keys(clientContext)) {
    const value = clientContext[key];
    if (value === null || value === undefined) {
      continue;
    }
    const attrKey = `openclaw.client.${key}`;
    if (typeof value === "string") {
      attributes[attrKey] = value.slice(0, MAX_CLIENT_CONTEXT_ATTRIBUTE_CHARS);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      attributes[attrKey] = value;
      continue;
    }
    attributes[attrKey] = JSON.stringify(value).slice(0, MAX_CLIENT_CONTEXT_ATTRIBUTE_CHARS);
  }
}

/** Stamp the already-pseudonymized core session identity onto a model-call span. */
export function assignSessionCorrelationAttribute(
  attributes: Record<string, string | number | boolean>,
  sessionCorrelationId: string | undefined,
): void {
  if (sessionCorrelationId) {
    attributes["openclaw.session.correlation_id"] = sessionCorrelationId;
  }
}

/** Bound on remembered entries (counts each candidate key separately). */
const DEFAULT_MAX_REMEMBERED_ENTRIES = 1024;

export type SessionAttributionCache = {
  remember(keys: string[], attribution: SessionDiagnosticAttribution | undefined): void;
  resolve(keys: string[]): SessionDiagnosticAttribution | undefined;
  clear(): void;
};

/**
 * Per-run cache of trusted lifecycle attribution. Populated from `session.state`
 * and `message.queued`, then read only when building `model.call.*` trace spans.
 * Bounded by insertion order so a long-lived gateway process cannot accumulate
 * stale runs.
 */
export function createSessionAttributionCache(
  maxEntries = DEFAULT_MAX_REMEMBERED_ENTRIES,
): SessionAttributionCache {
  const byKey = new Map<string, SessionDiagnosticAttribution>();
  return {
    remember(keys, attribution) {
      if (keys.length === 0) {
        return;
      }
      if (!attribution?.clientContext && !attribution?.sessionCorrelationId) {
        // Unseeded (or reused-with-invalid) lifecycle event: drop all stale
        // attribution for these aliases so a later model.call cannot inherit a
        // previous caller's client context or session pseudonym.
        for (const key of keys) {
          byKey.delete(key);
        }
        return;
      }
      for (const key of keys) {
        // Refresh insertion order so the most-recently-seen run survives eviction.
        byKey.delete(key);
        byKey.set(key, attribution);
      }
      while (byKey.size > maxEntries) {
        const oldest = byKey.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        byKey.delete(oldest);
      }
    },
    resolve(keys) {
      for (const key of keys) {
        const hit = byKey.get(key);
        if (hit) {
          return hit;
        }
      }
      return undefined;
    },
    clear() {
      byKey.clear();
    },
  };
}
