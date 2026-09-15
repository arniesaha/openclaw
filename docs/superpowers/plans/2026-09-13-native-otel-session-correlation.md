# Native OTel Session Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give OpenClaw native model-call spans and AgentWeave turn spans the same opaque, installation-local session identifier without exporting raw session identity.

**Architecture:** Core computes a versioned HMAC pseudonym only while the existing execution-identity audit option is enabled, then sends it in lifecycle `DiagnosticEventPrivateData`. The bundled OTel plugin and AgentWeave bridge cache that opaque value by the existing session aliases; the Collector maps it from a selected native model span to `prov.session.id`.

**Tech Stack:** TypeScript/Node `crypto`, OpenClaw diagnostic plugin SDK, Vitest, OpenTelemetry Collector Contrib 0.126.0, Python/pytest probe fixtures.

**Spec:** `docs/superpowers/specs/2026-09-13-native-otel-session-correlation-design.md`

## Global Constraints

- Work from an OpenClaw branch based on the selected upgrade target; do not fold an upstream rebase into this feature.
- Use only the existing `logging.audit.executionIdentity` opt-in. Do not add an AgentWeave setting, OTEL environment variable, or second HMAC secret.
- Core owns the HMAC key and database access. Plugins receive only an opaque `sessionCorrelationId` through trusted diagnostic private data.
- Raw `sessionKey`, `sessionId`, `runId`, and `callId` remain absent from OTel attributes. Keep `diagnostics.otel.captureContent=false`.
- The correlation value may appear only on selected model-call spans; never on metrics, logs, stdout JSONL, resources, or errors.
- Any failure to derive correlation is fail-open for the model request and represented by an absent attribute.
- Do not remove the proxy, session-key header, or Codex traceparent carry in this work.
- Use a supported Node runtime (`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`) and the repository-pinned pnpm 12.1.0. The present worktree lacks both; establish that toolchain before running the commands below.

---

## File structure

| File                                                                                      | Responsibility                                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/audit/audit-identity.ts`                                                             | Versioned, persisted-key HMAC session pseudonym.                     |
| `src/logging/diagnostic-session-state.ts`                                                 | Bounded in-process storage of the opaque per-session value.          |
| `src/logging/diagnostic.ts` and `src/logging/diagnostic-runtime.ts`                       | Lifecycle private-data projection and stale-value clearing.          |
| `src/infra/diagnostic-events.ts`                                                          | Typed trusted private-data contract.                                 |
| `src/logging/diagnostic-client-context-events.test.ts`                                    | Public/private lifecycle-boundary regression coverage.               |
| `extensions/diagnostics-otel/src/client-context-attributes.ts`                            | Alias cache extended to store the opaque token.                      |
| `extensions/diagnostics-otel/src/service-recorders-model.ts`                              | Selected model-span projection.                                      |
| `extensions/diagnostics-otel/src/service.test.ts`                                         | Exporter boundary coverage.                                          |
| `plugins/openclaw-agentweave-bridge/src/host-diagnostic-contract.ts`                      | Bridge view of the new trusted private-data field.                   |
| `plugins/openclaw-agentweave-bridge/src/service.ts`                                       | Bridge turn attribution uses the opaque token when available.        |
| `deploy/k8s/monitoring/otel-collector.yaml`                                               | Selected non-overwriting Collector transform.                        |
| `scripts/verify-native-collector-mapping.py` and `tests/test_native_collector_mapping.py` | Safe synthetic Tempo probe and pinned-Collector regression coverage. |

## Task 1: Add the core opaque session-correlation contract

**Files:**

- Modify: `src/audit/audit-identity.ts`
- Modify: `src/logging/diagnostic-session-state.ts`
- Modify: `src/logging/diagnostic.ts`
- Modify: `src/logging/diagnostic-runtime.ts`
- Modify: `src/infra/diagnostic-events.ts`
- Test: `src/logging/diagnostic-client-context-events.test.ts`

**Interfaces:**

- Consumes: `isExecutionIdentityCollectionEnabled(cfg)` and `pseudonymizeExecutionIdentityRef({ db, kind, scope, value })`.
- Produces: `DiagnosticEventPrivateData.sessionCorrelationId?: string` on trusted `session.state` and `message.queued` events.

- [ ] **Step 1: Add the failing trusted/private lifecycle test.**

  Extend the capture helper to retain `sessionCorrelationId`, then assert the token is visible only to the trusted listener:

  ```ts
  expect(trusted).toEqual([
    {
      type: "session.state",
      sessionCorrelationId: "hmac-sha256:v1:0123456789abcdef0123456789abcdef:abc",
    },
  ]);
  expect(JSON.stringify(publicEvents)).not.toContain("hmac-sha256:v1:");
  ```

  Add the paired reuse case: seed a value, clear it for the same `sessionId`/`sessionKey`, emit a lifecycle event, and require `sessionCorrelationId` to be `undefined`.

- [ ] **Step 2: Run the focused test and confirm the new expectation fails.**

  Run:

  ```bash
  pnpm test src/logging/diagnostic-client-context-events.test.ts
  ```

  Expected: FAIL because `DiagnosticEventPrivateData` and the lifecycle emitter have no `sessionCorrelationId` field.

- [ ] **Step 3: Extend the audit pseudonym type without creating a second key.**

  In `src/audit/audit-identity.ts`, add `"session"` to `ExecutionIdentityRefKind`. Derive with the existing persisted key and fixed scope:

  ```ts
  pseudonymizeExecutionIdentityRef({
    db,
    kind: "session",
    scope: "openclaw.diagnostics.session.v1",
    value: sessionId ?? sessionKey,
  });
  ```

  The caller must first require `isExecutionIdentityCollectionEnabled(cfg)`. If the canonical value, audit database, or key is unavailable, return `undefined`; do not generate a random value or hash without the persisted key.

- [ ] **Step 4: Carry only the opaque value through diagnostic session state.**

  Add `sessionCorrelationId?: string` to `SessionState` and preserve it when aliases merge. Add a narrowly named setter beside `setDiagnosticSessionClientContext` that writes the derived value for the session aliases and explicitly clears it when derivation is unavailable. Update both lifecycle emission sites to use one private-data object:

  ```ts
  const privateData = {
    ...(state.clientContext ? { clientContext: state.clientContext } : {}),
    ...(state.sessionCorrelationId ? { sessionCorrelationId: state.sessionCorrelationId } : {}),
  };
  ```

  Emit with `emitInternalDiagnosticEventWithPrivateData` only when `Object.keys(privateData).length > 0`; otherwise retain today's public-only emission.

- [ ] **Step 5: Type the trusted field and keep public listeners unchanged.**

  Add the optional field to `DiagnosticEventPrivateData` with a comment stating it is opaque, session-derived, lifecycle-only, and unavailable to public listeners. Do not add it to `DiagnosticEventPayload`, metric attributes, log attributes, or any event-name allowlist.

- [ ] **Step 6: Run the focused core tests.**

  Run:

  ```bash
  pnpm test src/logging/diagnostic-client-context-events.test.ts src/audit/audit-config.test.ts src/infra/diagnostic-events.test.ts
  ```

  Expected: PASS; public events omit the token, trusted lifecycle events preserve it, and disabled execution identity produces no field.

- [ ] **Step 7: Commit the core contract.**

  ```bash
  git add src/audit/audit-identity.ts src/logging/diagnostic-session-state.ts src/logging/diagnostic.ts src/logging/diagnostic-runtime.ts src/infra/diagnostic-events.ts src/logging/diagnostic-client-context-events.test.ts
  git commit -m "feat(diagnostics): carry opaque session correlation"
  ```

## Task 2: Project the token onto native model-call spans only

**Files:**

- Modify: `extensions/diagnostics-otel/src/client-context-attributes.ts`
- Modify: `extensions/diagnostics-otel/src/service-events.ts`
- Modify: `extensions/diagnostics-otel/src/service-recorders-model.ts`
- Modify: `extensions/diagnostics-otel/src/service.ts`
- Test: `extensions/diagnostics-otel/src/service.test.ts`

**Interfaces:**

- Consumes: lifecycle `privateData.sessionCorrelationId` from Task 1.
- Produces: `openclaw.session.correlation_id?: string` on only `openclaw.model.call` spans.

- [ ] **Step 1: Add failing exporter tests.**

  Seed a trusted `session.state` event with the opaque token, then emit matching `model.call.completed` and assert:

  ```ts
  expect(modelSpanAttrs["openclaw.session.correlation_id"]).toBe(CORRELATION_ID);
  expect(firstMetricAttributes()).not.toHaveProperty("openclaw.session.correlation_id");
  expect(firstSpanAttributes("openclaw.model.usage")).not.toHaveProperty(
    "openclaw.session.correlation_id",
  );
  ```

  Add alias coverage where the lifecycle event supplies both aliases and the model event supplies only one. Add reuse coverage where an unseeded lifecycle event clears the old token.

- [ ] **Step 2: Run the focused exporter test and confirm failure.**

  Run:

  ```bash
  pnpm test extensions/diagnostics-otel/src/service.test.ts
  ```

  Expected: FAIL because the event handler only remembers `privateData.clientContext`.

- [ ] **Step 3: Generalize the bounded alias cache.**

  Replace the cache value from a bare client-context bag with a local closed shape:

  ```ts
  type SessionDiagnosticAttribution = Readonly<{
    clientContext?: ClientContextBag;
    sessionCorrelationId?: string;
  }>;
  ```

  Keep the existing 1,024-entry cap and alias-clearing behavior. `remember()` receives the full trusted private-data projection; `resolve()` returns the shape. Do not store raw IDs as values—only as existing bounded map keys.

- [ ] **Step 4: Stamp the model-span attribute.**

  In each model-call recorder, resolve the cached attribution once and pass its client context to `assignClientContextAttributes`. Add the opaque token directly to `spanAttrs` only when present:

  ```ts
  if (attribution?.sessionCorrelationId) {
    spanAttrs["openclaw.session.correlation_id"] = attribution.sessionCorrelationId;
  }
  ```

  Do not pass it to metric recorders, log recorders, usage recorders, or resources.

- [ ] **Step 5: Wire private data through the event handler and service lifecycle.**

  On `message.queued` and `session.state`, pass both `clientContext` and `sessionCorrelationId` into the generalized cache. Keep `active.stopActiveTrustedSpans` clearing it during plugin replacement and shutdown.

- [ ] **Step 6: Run focused exporter and plugin contract tests.**

  Run:

  ```bash
  pnpm test extensions/diagnostics-otel/src/client-context-attributes.test.ts extensions/diagnostics-otel/src/service.test.ts extensions/diagnostics-otel/src/service.event-loop.test.ts
  ```

  Expected: PASS; the token lands only on lifecycle-associated model spans.

- [ ] **Step 7: Commit the exporter projection.**

  ```bash
  git add extensions/diagnostics-otel/src/client-context-attributes.ts extensions/diagnostics-otel/src/service-events.ts extensions/diagnostics-otel/src/service-recorders-model.ts extensions/diagnostics-otel/src/service.ts extensions/diagnostics-otel/src/client-context-attributes.test.ts extensions/diagnostics-otel/src/service.test.ts
  git commit -m "feat(diagnostics-otel): export opaque session correlation"
  ```

## Task 3: Consume the token in AgentWeave without a raw fallback

**Repository:** the current AgentWeave checkout (do not assume a fixed local path)

**Files:**

- Modify: `plugins/openclaw-agentweave-bridge/src/host-diagnostic-contract.ts`
- Modify: `plugins/openclaw-agentweave-bridge/src/service.ts`
- Test: `plugins/openclaw-agentweave-bridge/src/service.test.ts`

**Interfaces:**

- Consumes: `HostDiagnosticPrivateData.sessionCorrelationId?: string` from Task 1.
- Produces: bridge `openclaw.turn` session attribution equal to the opaque native value whenever it is present.

- [ ] **Step 1: Add a failing bridge test for a trusted lifecycle token.**

  Feed the service a `message.queued` or `session.state` event plus:

  ```ts
  {
    sessionCorrelationId: "hmac-sha256:v1:0123456789abcdef0123456789abcdef:abc";
  }
  ```

  Assert the created turn span has `prov.session.id` equal to that exact token and that the raw `sessionKey` is not placed in a span attribute.

- [ ] **Step 2: Run the bridge test and confirm failure.**

  Run:

  ```bash
  npm test --prefix plugins/openclaw-agentweave-bridge -- src/service.test.ts
  ```

  Expected: FAIL because `HostDiagnosticPrivateData` exposes only `clientContext` and turn creation uses the raw resolved session identity.

- [ ] **Step 3: Extend the host contract and active-turn state.**

  Add the optional opaque field to `HostDiagnosticPrivateData`. Thread it only from the existing trusted lifecycle callback into the active turn. For an active token, set `session.id` and `prov.session.id` to the token. When absent, preserve current compatibility behavior; do not derive a new value in the bridge and do not read any key or database.

- [ ] **Step 4: Run bridge regression coverage.**

  Run:

  ```bash
  npm test --prefix plugins/openclaw-agentweave-bridge -- src/service.test.ts
  npm run verify:bundle --prefix plugins/openclaw-agentweave-bridge
  ```

  Expected: PASS; the emitted bundle contains the updated contract and no raw token construction.

- [ ] **Step 5: Commit the bridge change.**

  ```bash
  git add plugins/openclaw-agentweave-bridge/src/host-diagnostic-contract.ts plugins/openclaw-agentweave-bridge/src/service.ts plugins/openclaw-agentweave-bridge/src/service.test.ts
  git commit -m "feat(bridge): use native session correlation"
  ```

## Task 4: Map and probe the native Collector attribute

**Repository:** the current AgentWeave checkout (do not assume a fixed local path)

**Files:**

- Modify: `deploy/k8s/monitoring/otel-collector.yaml`
- Modify: `scripts/verify-native-collector-mapping.py`
- Modify: `tests/test_native_collector_mapping.py`
- Modify: `tests/fixtures/openclaw-native-model-call-usage.json`

**Interfaces:**

- Consumes: `openclaw.session.correlation_id` from Task 2.
- Produces: non-overwriting `prov.session.id` on selected OpenClaw native model-call spans.

- [ ] **Step 1: Extend the fixture and probe with a harmless opaque token.**

  Add `openclaw.session.correlation_id` with a synthetic fixed HMAC-shaped value to the cached native model-call fixture. Extend probe expectations to require:

  ```py
  "openclaw.session.correlation_id": "hmac-sha256:v1:0123456789abcdef0123456789abcdef:abc",
  "prov.session.id": "hmac-sha256:v1:0123456789abcdef0123456789abcdef:abc",
  ```

  Include an `existing-target` case with a pre-set `prov.session.id` and require it to survive unchanged.

- [ ] **Step 2: Run the mapping test and confirm failure.**

  Run:

  ```bash
  python3 -m pytest tests/test_native_collector_mapping.py -q
  ```

  Expected: FAIL because the current transform does not set `prov.session.id`.

- [ ] **Step 3: Add the selected OTTL transform statement.**

  Add this statement after existing native token mappings:

  ```yaml
  - set(span.attributes["prov.session.id"], span.attributes["openclaw.session.correlation_id"]) where resource.attributes["service.name"] == "openclaw" and span.name == "openclaw.model.call" and span.attributes["openclaw.session.correlation_id"] != nil and IsString(span.attributes["openclaw.session.correlation_id"]) and span.attributes["prov.session.id"] == nil
  ```

  Do not map the field on `openclaw.model.usage`, unrelated services, resource attributes, or log/metric pipelines.

- [ ] **Step 4: Update the safe live probe.**

  Make `assert_mapped_trace()` reject raw session keys and require the synthetic opaque source and target fields. Keep the base64-or-hex Tempo trace-ID compatibility added by #298.

- [ ] **Step 5: Run the pinned Collector and probe tests.**

  Run:

  ```bash
  python3 -m pytest tests/test_native_collector_mapping.py tests/test_native_content_privacy.py -q
  ```

  Expected: PASS; content stripping, existing provider/model/token maps, and the new session map all hold together.

- [ ] **Step 6: Commit the Collector adapter.**

  ```bash
  git add deploy/k8s/monitoring/otel-collector.yaml scripts/verify-native-collector-mapping.py tests/test_native_collector_mapping.py tests/fixtures/openclaw-native-model-call-usage.json
  git commit -m "feat(collector): map native session correlation"
  ```

## Task 5: Canary and release evidence

**Files:**

- Modify: `docs/openclaw-native-otel-parity.md` in AgentWeave only after evidence exists.

**Interfaces:**

- Consumes: merged Tasks 1-4.
- Produces: operator evidence that native correlation is safe to use, not authorization to remove the proxy.

- [ ] **Step 1: Establish the operator-approved canary configuration.**

  Back up the canary Gateway configuration, set only `logging.audit.executionIdentity=true`, retain `diagnostics.otel.captureContent=false`, and obtain explicit approval before restarting the managed Gateway.

- [ ] **Step 2: Exercise three safe sessions.**

  Send two distinct synthetic turns and one resumed turn through the canary. Record only trace IDs, attribute names, and opaque values; do not record prompts, replies, configuration secrets, or raw session keys.

- [ ] **Step 3: Verify native and bridge correlation in Tempo.**

  For each trace, confirm `openclaw.model.call` has `openclaw.session.correlation_id`, Collector output has matching `prov.session.id`, and the bridge turn uses that same value when present. Confirm raw session/run/call/content fields and `cost.usd` are absent from the native span.

- [ ] **Step 4: Verify fail-open behavior.**

  In an isolated dev Gateway, make the Collector unavailable, execute one synthetic turn, and confirm the model response completes. Restore the test endpoint before ending the run; do not alter the operator's live collector or Gateway.

- [ ] **Step 5: Run release gates after authorized deployment.**

  Run:

  ```bash
  bash scripts/deploy.sh
  bash scripts/verify.sh
  python3 scripts/verify-native-content-privacy.py
  python3 scripts/verify-native-collector-mapping.py
  ```

  Expected: every command exits 0. Record the probe trace IDs and the Grafana dashboard URL in the parity report.

- [ ] **Step 6: Commit evidence and open the remaining migration gates.**

  ```bash
  git add docs/openclaw-native-otel-parity.md
  git commit -m "docs(otel): record native session correlation evidence"
  ```

  Keep #295 (native cost/deduplication) and #287 (proxy-default removal) open. Do not remove any proxy routing or carry from this task.

## Plan self-review

- Spec coverage: Tasks 1-2 implement trusted opaque production and native span projection; Tasks 3-4 cover the bridge and Collector boundary; Task 5 covers privacy, fail-open behavior, canary, and release evidence.
- Scope: the plan excludes cost, proxy cutover, raw identity export, and new configuration as required.
- Type consistency: the only cross-repository field is `sessionCorrelationId`; the only native OTel source attribute is `openclaw.session.correlation_id`; the Collector target is `prov.session.id`.
