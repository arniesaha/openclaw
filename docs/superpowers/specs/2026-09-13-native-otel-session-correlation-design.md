# Native OTel session correlation

Date: 2026-09-13
Status: design approved, not implemented
Tracks: [agentweave#294](https://github.com/arniesaha/agentweave/issues/294)

## Problem

OpenClaw's native `diagnostics-otel` plugin now exports useful model-call
spans, and AgentWeave's Collector maps their provider, model, and token fields.
It deliberately does **not** export `sessionKey`, `sessionId`, `runId`, or
`callId`: `DROPPED_OTEL_ATTRIBUTE_KEYS` excludes each raw identifier.

That protects operator and conversation identity, but native model-call spans
cannot be grouped into a stable OpenClaw session. Static resource attributes
such as `prov.agent.id` and `prov.project` are deployment metadata, not a
substitute for per-session attribution. The current `clientContext` carry is
also insufficient: it is supplied only by callers that seed it, and ordinary
local, cron, compaction, and subagent runs need not have one.

The result is that the native path can coexist with proxy telemetry but cannot
yet be the canonical source for session-level queries or a safe proxy cutover.

## Goal

When the existing execution-identity audit feature is enabled, native
`openclaw.model.call` spans carry a stable, opaque session correlation value.
The same value is available to trusted plugins so the AgentWeave bridge can
join its turn span without receiving a raw session identifier.

The value is installation-local, stable across normal Gateway restarts, and
not reversible without OpenClaw's persisted audit key.

## Non-goals

- Exporting raw session, run, call, message, trace, or user identifiers.
- Adding an AgentWeave-specific configuration key, environment variable, or
  core dependency.
- Making a metric or log label from the correlation value.
- Computing native cost, removing proxy spans, or changing provider routing.
- Retrofitting historical Tempo traces.

## Existing primitive and decision

OpenClaw already owns a suitable pseudonym facility in
`src/audit/audit-identity.ts`. Its persisted key is redacted, installation
local, and produces versioned `hmac-sha256:v1:<key-id>:<digest>` values.
Execution identity is already an explicit opt-in through
`logging.audit.executionIdentity`, subject to the audit ledger being enabled.

**Decision:** reuse this facility and its existing opt-in. Do not introduce a
second secret or an OTel-only environment variable. Add a `"session"` kind to
`pseudonymizeExecutionIdentityRef`, with the fixed scope
`"openclaw.diagnostics.session.v1"`.

The input is the canonical `sessionId` when present; otherwise it is the
qualified `sessionKey`. The canonical value is never placed in an event,
attribute, log record, metric, error, or persisted correlation record.

## Contract

### Trusted diagnostic data

Add this optional field to `DiagnosticEventPrivateData`:

```ts
sessionCorrelationId?: string;
```

It is populated only on the existing trusted lifecycle carriers
`message.queued` and `session.state`. Public diagnostic listeners must never
receive it. The current `onTrustedDiagnosticEvent` lifecycle allowlist already
provides that boundary.

When execution-identity collection is disabled, a session is missing, the
identity key cannot be read, or the audit database cannot be opened, the field
is absent. The diagnostic event and model request still proceed; observability
must remain fail-open.

### Native OTel attribute

The diagnostics exporter caches the opaque value under every present
`sessionId` and `sessionKey` alias, just as it currently caches
`clientContext`. It clears those aliases when an unseeded lifecycle event
arrives, preventing a reused session key from inheriting an old value.

For `model.call.started`, `model.call.completed`, and `model.call.error`, the
exporter resolves that cache and, when present, adds exactly:

```text
openclaw.session.correlation_id = hmac-sha256:v1:<key-id>:<digest>
```

It is a span attribute only. `model.usage`, metrics, logs, resource attributes,
and non-model spans do not receive it. The attribute is intentionally separate
from the raw-identifier denylist; the denylist continues to block every raw
form.

### AgentWeave consumption

The AgentWeave bridge reads `sessionCorrelationId` only from its existing
trusted lifecycle subscription. For an active turn with a correlation value,
it records that value as its session attribution instead of the raw OpenClaw
session key. The Collector maps the native span's
`openclaw.session.correlation_id` to `prov.session.id` only for
`service.name=openclaw` / `span.name=openclaw.model.call`, preserving an
already-set target.

No component treats static `prov.agent.id` or `prov.project` as a session.
No Collector transform derives a token from raw attributes.

## Data flow

```text
Gateway lifecycle event
  -> core audit identity pseudonym (privateData only)
  -> trusted lifecycle subscribers
       -> diagnostics-otel alias cache -> native model-call span
       -> AgentWeave bridge active turn
  -> Collector native adapter -> prov.session.id
```

The core owns key storage and pseudonym construction. The bundled exporter and
the external bridge consume only the opaque private-data field; neither imports
`src/audit/**`, reads the audit database, or learns the HMAC key. This preserves
the plugin/core ownership boundary.

## Implementation surfaces

| Surface                                                                            | Change                                                                                                                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/audit/audit-identity.ts`                                                      | Add the `session` execution-identity kind and its fixed diagnostics scope.                                                    |
| Lifecycle diagnostic producer and `src/infra/diagnostic-events.ts`                 | Compute and attach `sessionCorrelationId` under the existing audit opt-in; expose the type only through trusted private data. |
| `src/plugin-sdk/diagnostic-runtime.ts`                                             | Continue exporting the shared private-data type; no AgentWeave name enters the SDK.                                           |
| `extensions/diagnostics-otel/src/client-context-attributes.ts` and model recorders | Generalize the bounded alias cache to retain the opaque correlation token and stamp it on model-call spans.                   |
| `plugins/openclaw-agentweave-bridge` (AgentWeave repo)                             | Extend trusted private-data typing and use the opaque token for bridge turn-session attribution.                              |
| `deploy/k8s/monitoring/otel-collector.yaml` (AgentWeave repo)                      | Add a selected, non-overwriting native correlation mapping after content stripping.                                           |

The execution-identity audit feature remains startup-scoped. Enabling it is an
operator decision and requires the normal Gateway restart; changing OTel
exporter settings must not silently enable identity collection.

## Failure and rotation behavior

- Missing correlation is represented by absence, never `"unknown"`, an empty
  string, or a zero value.
- A corrupt or missing persisted audit key with retained audit identity data
  follows the audit subsystem's existing fail-closed key behavior. The
  telemetry projection then omits correlation rather than minting a new token.
- A fresh state database creates a new key id. Queries must regard the key-id
  prefix as an intentional correlation epoch; joining across epochs is not
  supported.
- Cache eviction or a model event that precedes its lifecycle seed yields an
  unattributed native span, not a guessed association with another session.
- Collector or bridge unavailability never blocks model execution.

## Privacy and operational constraints

- Keep `diagnostics.otel.captureContent=false`.
- Do not add the token to metrics, logs, stdout JSONL, resource attributes, or
  error messages; those surfaces have broader retention and cardinality costs.
- Preserve the Collector's existing OpenClaw content stripping before the new
  mapping.
- The token is scoped to one installation and cannot correlate the same user or
  session across installations.
- Existing raw-ID deletion tests remain required. The new opaque attribute is
  the only allowed session-derived OTel field.

## Verification

### Automated

1. Core tests prove disabled audit identity emits no private correlation field,
   enabled identity emits a stable versioned HMAC, public listeners never see
   it, and session-key reuse clears the alias.
2. Exporter tests cover `started`, `completed`, and `error` model-call spans;
   verify the field is absent from metrics, logs, `model.usage`, and all raw-ID
   attribute outputs.
3. Bridge tests prove a trusted lifecycle token is used for the turn span and
   that an absent token preserves the current unattributed/fallback behavior
   without synthesizing one.
4. Collector fixture tests prove selected native spans map the opaque value to
   `prov.session.id`, retain no raw session attributes, and do not overwrite a
   pre-existing target.
5. Run the focused Vitest suites on a supported Node/pnpm toolchain, then the
   affected exporter and AgentWeave Collector suites.

### Live gate

After an operator-approved Gateway restart with
`logging.audit.executionIdentity=true` and content capture still disabled,
exercise two safe, distinct sessions plus a resumed session. Query Tempo by
the synthetic trace IDs and confirm:

- model-call spans have distinct opaque `prov.session.id` values;
- resumed calls retain the first session's opaque value;
- no `openclaw.sessionKey`, `openclaw.sessionId`, run, call, content, or cost
  fields appear; and
- model execution succeeds when the Collector is unreachable or correlation is
  absent.

Repeat the evidence matrix before any proxy-default change for direct
Anthropic, direct OpenAI, Gemini, Codex OAuth, cron/isolated, compaction, and
native subagent paths. Current evidence does not establish all of those paths.

## Rollout and rollback

1. Land core/exporter contract tests and the bridge/Collector consumers behind
   the existing audit opt-in.
2. Deploy the Collector with the new non-overwriting transform and run the
   synthetic Tempo probe.
3. Enable execution identity in one operator-controlled canary Gateway and
   complete the live gate.
4. Roll out only after the canary evidence is recorded.

Rollback is the existing `logging.audit.executionIdentity=false` setting plus
a Gateway restart. It stops emitting new correlation values; no model request
or provider configuration changes are required. The proxy, session-key header,
and Codex traceparent carry remain in place until the separate cost,
deduplication, and direct-provider parity gates are complete.
