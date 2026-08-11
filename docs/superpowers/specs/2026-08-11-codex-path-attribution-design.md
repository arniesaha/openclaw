# Codex-path attribution and LLM call detail

Date: 2026-08-11
Status: design approved, not implemented
Follows: `2026-08-10-agentweave-264-per-session-attribution-design.md`

## Problem

agentweave#264 gave proxied model calls per-session attribution by stamping
`x-agentweave-session-key` on outbound requests and forcing the proxy's session
context per turn. That fix landed and is deployed, but it only reaches traffic
that goes through OpenClaw's own HTTP transports.

Nix's models do not. `~/.openclaw/openclaw.json` marks `openai/gpt-5.5`,
`openai/gpt-5.5-pro`, and `openai/gpt-5.6-sol` with `agentRuntime: { id: "codex" }`,
so those turns run inside the codex harness — a separate spawned binary that
talks to the OpenAI backend directly. `models.providers.openai.baseUrl`, its
static headers, and the session-key stamp are all bypassed as a class. The proxy
sees zero `/responses` requests from these turns.

Measured baseline (Tempo, 2026-08-11):

- 202 `llm.*` spans in 7 days, all `project=claude-code`. Zero from OpenClaw.
- `prov.session.id="nix-main"` appears once in 14 days: one `llm.claude-opus-5`
  span at 2026-08-08 17:34:31.

A corollary worth recording: removing the static `X-AgentWeave-*` headers from
the `openai` provider block is a no-op, because nothing reads that block on the
codex path.

## Goal

Codex turns become attributable per session, and carry per-call LLM detail —
token counts, cache split, reasoning tokens, time-to-first-token, model — at
least matching what the proxy gives us for anthropic today.

## Non-goal

Routing codex traffic through the AgentWeave proxy. Codex authenticates with
ChatGPT OAuth, and `agent-identity/src/lib.rs` enforces a host allowlist whose
own test rejects `http://localhost:8080`. That allowlist exists specifically to
stop OAuth tokens reaching a self-hosted intermediary. Working around it means
switching to API-key auth and giving up subscription billing. Rejected.

## Design

Three pieces. A supplies depth, C supplies the flat queryable key, and they are
joined by a shared trace id.

### A1. Codex OTLP export (configuration, no code)

Inject an `[otel]` block into the codex `config.toml` that OpenClaw already
manages (`extensions/codex/src/app-server/config.ts:143-144`, `configPatch` /
`configFingerprint`):

- `trace_exporter` = OTLP-HTTP to Tempo (NodePort 30418)
- `span_attributes` = stable facts only: `prov.project`, `prov.agent.id`

`validate_span_attributes` (`codex-rs/otel/src/config.rs:39-48`) rejects only
empty keys, so `prov.*` names are accepted.

This turns on codex's existing span tree: `run_turn` → `stream_request` →
`receiving_stream` → `handle_responses`, declared at
`codex-rs/core/src/session/turn.rs:2208-2223`.

### A2. Per-turn trace propagation (OpenClaw code, small)

Codex's app-server is a shared, leased, long-lived process in OpenClaw
(`shared-client.ts:32`, leases at `:117-136`), so spawn-time `TRACEPARENT` is
the wrong hook — it would nest every turn under whichever turn started the
process.

The correct hook is per-request. `JSONRPCRequest.trace`
(`codex-rs/app-server-protocol/src/rpc.rs:49-55`) carries
`W3cTraceContext { traceparent, tracestate }`
(`codex-rs/protocol/src/protocol.rs:190-197`). `message_processor.rs:546` lifts
it into the request context and `attach_parent_context`
(`app_server_tracing.rs:125-141`) makes it the request span's parent, falling
back to the env var only when absent.

OpenClaw does not set this field today — no `trace:` sibling anywhere in
`extensions/codex/src/app-server/`; `request.ts:81` calls
`client.request(method, requestParams, { timeoutMs })` with no trace slot.

The change: thread an optional trace through `request.ts` → `client.request` →
the stdio transport, and populate it at the turn-initiating call from the
existing per-attempt context.

### C. Bridge-side call spans

The bridge keeps emitting a span per `model.call.completed` carrying the flat
`prov.session.id`. This is what makes session id directly queryable, which the
codex side cannot provide (see "Rejected alternatives").

C also owns the bridge trace-id adoption and the concurrency fix described
under Data flow. Both are bridge-side changes and ship together with the span
work; neither is optional, because without adoption A and C land in separate
traces.

## Data flow

1. The gateway seeds a trace scope:
   `runWithDiagnosticTraceContext(createDiagnosticTraceContext(), …)` at
   `src/gateway/server-http.ts:488,811` and
   `src/gateway/server/ws-connection/message-handler.ts:2440`, propagated by
   `AsyncLocalStorage`.
2. The codex attempt snapshots a child of it, once per attempt:
   `freezeDiagnosticTraceContext(createDiagnosticTraceContextFromActiveScope())`
   at `run-attempt.ts:456`.
3. **New (A2):** the turn-initiating JSON-RPC request sets
   `trace: { traceparent: formatDiagnosticTraceparent(codexModelCallTrace) }`.
   `formatDiagnosticTraceparent` already exists at
   `src/infra/diagnostic-trace-context.ts:161-175`. Codex parents its request
   span on that span id and exports its whole tree into the same trace.
4. **C** rides the same identity. `run-attempt.ts:2699-2710` already puts
   `trace: codexModelCallTrace` on the model-call diagnostic base fields,
   alongside `sessionKey`, `sessionId`, `provider`, `model`, `api`, `transport`,
   and context-window fields. The bridge emits its span into that trace id and
   stamps `prov.session.id`.

Result: codex's spans and the bridge's span share a trace id by construction.
No timestamp joins, no correlation heuristics. A `prov.session.id` filter finds
the bridge span; the codex subtree hangs off the same trace.

### Bridge trace-id adoption (required, and not currently true)

The bridge mints its own OpenTelemetry ids today — `service.ts:437-438` reads
`span.spanContext()` from a span it created as a root, and injects a carrier
into `process.env.AGENTWEAVE_TRACEPARENT` (`:431`, `:623`). Nothing reads
OpenClaw's `DiagnosticTraceContext`. Left alone, A and C would land in
**separate traces** and the layering would silently fail.

OpenClaw already supplies what's needed: `enrichDiagnosticEvent`
(`src/infra/diagnostic-events.ts:1215`) does
`enriched.trace ??= getActiveDiagnosticTraceContext()` for *every* dispatched
diagnostic event, so `message.queued` — the event the bridge builds its turn
span from (`service.test.ts:137`) — already carries the gateway trace id.

Change: on `message.queued`, start the span as a child of `event.trace` via
`trace.setSpanContext(ctx, { traceId, spanId, traceFlags, isRemote: true })`
instead of as a root.

The bridge span and the codex subtree end up **siblings under the gateway
scope**, not codex nested inside the bridge span. True nesting would require
OpenClaw to know the bridge's span id — plugin identity leaking into core,
against the architecture rules — and buys nothing, since the trace id is the
join key either way.

### Concurrency defect to fix while here

`process.env.AGENTWEAVE_TRACEPARENT` (`service.ts:431`, `:623`) is
process-global, while `agents.defaults.maxConcurrent` is 4. Concurrent turns
race to overwrite it. This is pre-existing and not introduced by this design,
but this work touches the same code and should fix it rather than build on it.

## What the detail actually contains

Verified in codex source, and present in the shipped binary.

On `handle_responses` (`codex-rs/otel/src/events/session_telemetry.rs:449-467`):
`gen_ai.usage.input_tokens`, `gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.cache_write.input_tokens`, `gen_ai.usage.output_tokens`,
`codex.usage.reasoning_output_tokens`, `codex.usage.total_tokens`. Plus
time-to-first-token (`:249`, `:926`), reasoning effort, and tool names.

On every trace event (`codex-rs/otel/src/events/shared.rs:24-40`): `model`,
`slug`, `conversation.id`, `auth_mode`, `originator`, `app.version`,
`terminal.type`.

Level filtering is not a concern: `OtelProvider::trace_export_filter`
(`codex-rs/otel/src/provider.rs:196`) returns `meta.is_span() || is_trace_safe_target(...)`,
and `is_span()` is unconditionally true for spans, so all `trace_span!` spans
export regardless of level.

### Prompt and response payloads are a separate, opt-in signal

`user_prompt` (`session_telemetry.rs:968-987`) forks deliberately. `log_event!`
carries the full prompt string — redacted to `[REDACTED]` unless
`log_user_prompt = true` — and targets `codex_otel.log_only`, the OTLP **logs**
signal. The `trace_event!` twin carries only `prompt_length` and input counts,
and drops `user.account_id` / `user.email` which the log variant keeps.

Traces are scrubbed by design; logs are the sensitive channel. Payload capture
therefore requires enabling the logs exporter *and* flipping `log_user_prompt`.

Requested for inclusion on 2026-08-11. Scoped as a gated Phase 2 below rather
than a rung on the proof ladder, because it cannot ship on current
infrastructure and it contradicts an existing deliberate decision in this
deployment.

### Phase 2 (gated): prompt and response payload capture

**Blocked on infrastructure that does not exist.** The OTel collector at
`10.43.221.47:4318` (`monitoring/agentweave-otel-collector`, the endpoint the
bridge already uses) declares `service.pipelines` with `traces` only —
receivers `[otlp]`, exporters `[otlphttp/tempo, debug]`. There is no logs
pipeline, and no logs backend in the cluster (no Loki). Tempo itself is
traces-only. Codex would emit payload logs to an endpoint that discards them.

**Conflicts with an existing decision in this deployment.** The same collector
runs an `attributes/strip_pii` processor, commented *"before anything reaches
Tempo"*, deleting `user.email`, `user.id`, `user.account_uuid`,
`user.account_id`, and `organization.id`. Codex's `log_event!`
(`codex-rs/otel/src/events/shared.rs:4-22`) attaches `user.account_id` and
`user.email` to every log event, and `log_user_prompt = true` adds the full
verbatim prompt text. Enabling this ships precisely the categories that
processor was built to remove, through a pipeline that currently has no
equivalent scrubbing.

Prerequisites, all required before any of this is switched on:

1. A logs backend (Loki or equivalent) and a `logs` pipeline on the collector.
2. A PII posture decision for that pipeline. Either extend `attributes/strip_pii`
   to the logs pipeline — which keeps `user.*` out but still stores full prompt
   text — or accept identified prompt storage deliberately.
3. Retention and access policy for stored prompts. Prompt text is the most
   sensitive artifact this system handles; trace retention defaults are unlikely
   to be the right answer for it.
4. A separate `exporter` endpoint in the codex `[otel]` block. `exporter` (logs)
   and `trace_exporter` are independent, so logs can be routed away from Tempo
   without disturbing Phase 1.

Recommendation: land Phase 1 first and evaluate whether it is already
sufficient. Phase 1 yields per-call token counts, cache split, reasoning tokens,
TTFT, model, and tool names. Payload capture adds verbatim content and a
materially larger privacy surface. If the goal is cost and performance
attribution, Phase 1 meets it without storing prompts at all.

## Failure modes

- **Export is opt-in and fail-soft.** Default `trace_exporter` is `None`. If
  Tempo is unreachable the OTLP exporter drops spans in the background; turns
  are never blocked.
- **Invalid trace carrier degrades.** `attach_parent_context` warns
  ("ignoring invalid inbound request trace carrier") and falls back to env, then
  to a fresh root. A malformed traceparent costs correlation on one turn.
- **Absence is the natural encoding.** `formatDiagnosticTraceparent` returns
  `undefined` when `spanId` is missing (`:165`), and the protocol field is
  `skip_serializing_if = "Option::is_none"`. Omitting it reproduces today's
  behavior exactly.
- **Rollback is clean.** Stop setting `trace`, stop writing `[otel]`. Both
  systems return to current behavior with no migration.
- **Config fingerprint churn is the sharp edge.** The `[otel]` block is written
  per-agent, so it invalidates `configFingerprint` once, not per turn.

## Rejected alternatives

- **Reroute codex through the proxy.** Blocked by the OAuth host allowlist; see
  Non-goal.
- **Per-session `span_attributes`.** Would put `prov.session.id` directly on
  codex spans, but `span_attributes` is per-config-file and OpenClaw scopes
  `CODEX_HOME` per *agent*. Session id would require rewriting `config.toml`
  every turn, churning the fingerprint and likely forcing app-server restarts —
  trading away the shared-process model for a query convenience C already
  provides.
- **Spawn-time `TRACEPARENT` only.** Wrong granularity for a shared long-lived
  process; see A2.
- **C alone (bridge synthesis, no codex export).** Per-session attribution would
  be correct, but limited to what OpenClaw's codex event projection carries —
  no per-request token split, no TTFT, no tool spans.

## Version compatibility

`extensions/codex/package.json` pins `@openai/codex` 0.144.3. The shipped
binary at
`node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`
contains all six required markers: `ignoring invalid inbound request trace
carrier`, `TRACEPARENT detected`, `trace_exporter`, `span_attributes`,
`gen_ai.usage.input_tokens`, `handle_responses`.

Source citations above are from the checkout at
`/home/Arnab/clawd/projects/codex` @ `30d9923` (2026-08-05), which is a superset
read; the binary probe is what establishes deployed support.

**Open item for implementation:** `managed-binary.ts` means OpenClaw may resolve
a different codex than the `node_modules` copy. Confirm which binary the live
gateway spawns before writing the config block — the `[otel]` block must land in
that binary's `CODEX_HOME`.

## Open items for implementation

Deliberately unresolved at design time; each is a lookup, not a decision.

1. **Which JSON-RPC method is the turn-initiating call.** A2 says "the
   turn-initiating call" because the exact method on the codex app-server
   protocol has not been pinned down yet. Identify it in `turn-router.ts` /
   `run-attempt.ts` before writing the plan; the trace field goes on that
   request and no other.
2. **Which codex binary the live gateway spawns** (see Version compatibility).
3. **Where the Tempo endpoint is configured.** It belongs on the codex plugin's
   existing config surface, not a new top-level key — the root guide sets a high
   bar for new config/env surfaces.

## Testing

Unit tests are Vitest, colocated, run on Blacksmith Testbox (trusted maintainer
code) per the root guide. No codex-side tests; no codex code changes.

- OpenClaw: the turn-initiating JSON-RPC request carries `trace.traceparent`
  derived from `codexModelCallTrace`, and omits the field when
  `formatDiagnosticTraceparent` returns `undefined`. Homes: `request.test.ts`,
  `client.test.ts`.
- Config: the `[otel]` block appears in the generated `config.toml`, and the
  fingerprint changes exactly once across repeated turns. This is the assertion
  that guards the shared-process model.
- Bridge: `message.queued` starts its span as a child of `event.trace`; two
  concurrent turns produce distinct traceparents (regression test for the
  `process.env` race).

### Live proof ladder

Three rungs, so a failure localises instead of presenting as "no spans":

1. **Codex export alone**, no traceparent. Codex spans appear in Tempo as their
   own roots. Proves OTLP reachability and config injection independently of
   correlation.
2. **Add the traceparent.** Codex spans move into OpenClaw's trace id. Proves
   propagation.
3. **Bridge trace-id adoption.** Bridge span and codex subtree resolve under one
   trace, with `prov.session.id` on the bridge span.

Success criterion: a Nix turn on `openai/gpt-5.6-sol` produces a trace
containing `handle_responses` with `gen_ai.usage.*` populated, reachable from a
`prov.session.id` filter. Compare against the baseline in Problem.

### Rollout friction

Rungs 2 and 3 each need `pnpm run build` and a gateway restart, which interrupts
any live Nix session and the Telegram loop. Batch them; ask before each restart.
Pre-land, the root guide requires a fresh `$autoreview` with no actionable
findings.

## Follow-ups deferred from #264

- `proxy.py:1103` read path lacks `move_to_end`, so the forced-context LRU does
  not refresh on read.
- `service.ts:689` `/session` POST is fire-and-forget, and becomes the sole
  attribution mechanism once static headers are removed.
- Task 5 (remove static `X-AgentWeave-Session-Id` / `Agent-Id` / `Agent-Type`
  from the `anthropic` and `openai` provider blocks; keep `X-AgentWeave-Project`;
  leave `minimax` untouched). Now known to be a no-op for `openai`.
- `.claude/CLAUDE.md` records the wrong bridge build path.
