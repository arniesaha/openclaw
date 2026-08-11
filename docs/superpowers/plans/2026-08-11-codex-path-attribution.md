# Codex-path attribution and LLM call detail — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make codex-harness turns attributable per session in Tempo, carrying per-call token, cache, reasoning and TTFT detail, by turning on codex's own OTLP export and joining it to the bridge's session-keyed span through a shared trace id.

**Architecture:** Three moving parts. (A1) Operator-level `[otel]` config in each codex-runtime agent's `CODEX_HOME/config.toml` turns on codex's existing span tree and exports it to the OTel collector. (A2) OpenClaw stamps a W3C `traceparent` on the `turn/start` JSON-RPC envelope, so codex parents its span tree on OpenClaw's trace id instead of minting its own root. (C) The agentweave bridge adopts that same trace id instead of minting its own, and emits a per-model-call span carrying the flat `prov.session.id` that codex cannot provide.

**Tech Stack:** TypeScript ESM (OpenClaw fork + agentweave bridge plugin), Vitest, codex 0.144.3 Rust binary (no codex code changes), OpenTelemetry JS (bridge only), TOML (codex config), Tempo + OTel Collector.

**Spec:** `docs/superpowers/specs/2026-08-11-codex-path-attribution-design.md`

## Global Constraints

- **Phase 2 payload capture is out of scope.** Do not set `log_user_prompt`, do not configure `otel.exporter` (the logs exporter). Only `otel.trace_exporter` and `otel.span_attributes`.
- **No codex source changes.** Codex is a pinned dependency (`@openai/codex` 0.144.3). All codex-side behavior used here is already shipped.
- **OpenClaw tests run remote.** Per root `AGENTS.md`, agent test execution defaults to Blacksmith Testbox (this is trusted maintainer code). Never run raw `vitest`. Bridge tests live in a different repo (`/home/Arnab/dev/agentweave`) and are a small local Vitest suite — run them locally with `npm test`.
- **Gateway restarts interrupt live sessions.** `systemctl --user restart openclaw-gateway.service` kills any active Nix session and the Telegram loop. Ask before every restart. Batch Tasks 2–4 into one restart where possible.
- **Node path.** `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH` before any `pnpm` in the OpenClaw checkout.
- **Bridge deploy artifact is the esbuild bundle**, not `dist/`. Source of truth: `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/`. Deployed as a single `index.js` at `~/.openclaw/user-plugins/agentweave-bridge/index.js`.
- **In the agentweave repo, never `git add -A`** — the repo root carries unrelated untracked files (`.openclaw/`, `HEARTBEAT.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `USER.md`).
- **OpenClaw commits go through `scripts/committer "<msg>" <file...>`** with intended files staged only.
- **Pre-land:** a fresh `$autoreview` with no actionable findings is mandatory before landing the OpenClaw change.
- Never print or commit secrets, live config, or real credentials.

## Deviations from the spec (resolved open items)

The spec left three open items as deliberate lookups. All three are now resolved, and two of them changed the shape of the work. Implementers should follow this plan, not the spec, where they differ.

1. **Turn-initiating method is `turn/start`**, issued via `client.request("turn/start", …)` at `extensions/codex/src/app-server/run-attempt.ts:2780` — *not* through `requestCodexAppServerJson`. The trace field goes on `CodexAppServerClient.request` and its `RpcRequest` envelope. `thread/start` (`thread-lifecycle.ts:944`) is deliberately left alone: it is thread setup, not a model turn.

2. **The `[otel]` block is operator config, not OpenClaw config.** The spec assumed OpenClaw would write it into the managed `config.toml`. It cannot, and should not:
   - OpenClaw never writes `config.toml`. It only *reads* it (`config.ts:1630,1636`, `plugin-activation.ts:208`). There is no TOML writer in the plugin.
   - `codex app-server` has no `-c` / `--config` override flag (`codex-rs/cli/src/main.rs:519-568`).
   - `configPatch` is **not** a file write — it is a per-`thread/start` config override (`thread-lifecycle.ts:743,911`), and it is too late regardless: `build_provider` runs once at app-server process startup (`codex-rs/app-server/src/lib.rs:576`), before any thread exists.

   So A1 is a hand-edited block in each codex-runtime agent's `CODEX_HOME/config.toml`. This also resolves open item 3 (no new OpenClaw config surface — which the root guide's high config bar wanted anyway) and **deletes the spec's "config fingerprint churn" failure mode entirely**, since no fingerprint is involved.

3. **Live codex binary confirmed single.** `node_modules/.bin/codex` → `@openai/codex/bin/codex.js` → `@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`. That is the same binary the spec probed for the six trace/otel markers. There is no second candidate in the checkout.

4. **The concurrency fix is a deletion, not a synchronization.** The spec framed `process.env.AGENTWEAVE_TRACEPARENT` as a race to fix. All three env writes get deleted, but the justification differs per variable — an earlier revision of this plan claimed "nothing reads it", which is **false** for `AGENTWEAVE_TRACEPARENT` and is corrected here:

   - `AGENTWEAVE_PARENT_TRACE_ID` / `AGENTWEAVE_PARENT_SPAN_ID` are genuinely dead. `sdk/python/tests/test_proxy.py::test_no_env_fallback_in_resolution_block` (issue #178) asserts the proxy must **not** honor them; the `links[]` resolution path is deliberately env-free. The proxy takes parent ids through the `/session` POST body.
   - `AGENTWEAVE_TRACEPARENT` **is** read, at `sdk/python/agentweave/proxy.py:1180-1184`, guarded by `test_env_var_fallback_used_when_no_header` (issue #133). It is deleted anyway because **the bridge's write can never reach that reader**, for two independent reasons. (a) Process boundary: the reader runs in the `agentweave-proxy` Kubernetes pod (NodePort 30400, another host); the write mutates the OpenClaw gateway's Node `process.env` on the NAS. (b) Timing: the write happens *per turn*, and a child process's environment is a copy taken at spawn time — so even a same-host spawn topology could not observe it. Issue #133's mechanism remains live and untouched for whoever sets that variable *in the proxy's own environment*; this change only removes a write that was always a no-op with respect to it.

   `parentTraceIdHex` / `parentSpanIdHex` are still computed — the `/session` payload uses them.

   **Follow-up (out of scope here):** the race-free, cross-process way to give the proxy a parent is the `traceparent` **HTTP header** on the proxied model call, which `proxy.py:1183` already prefers over the env var. That belongs to OpenClaw's transport layer, not the bridge, and is not covered by this plan.

5. **Collector, not Tempo direct.** The spec said Tempo NodePort 30418. Use the OTel collector at `http://10.43.221.47:4318/v1/traces` instead — the same endpoint the bridge already uses. It gets codex spans the collector's `attributes/strip_pii` processor for free, and keeps one export path to reason about.

## File Structure

**OpenClaw fork** (`/home/Arnab/clawd/projects/openclaw`, branch `upgrade/v2026.7.1`):

| File | Responsibility | Change |
|---|---|---|
| `extensions/codex/src/app-server/protocol.ts` | JSON-RPC envelope types | Add optional `trace` to `RpcRequest` |
| `extensions/codex/src/app-server/client.ts` | Transport client | Accept `traceparent` request option, copy onto envelope |
| `extensions/codex/src/app-server/run-attempt.ts` | Codex turn execution | Pass the per-attempt traceparent on `turn/start` |
| `extensions/codex/src/app-server/client.test.ts` | Client tests | Cover present/absent traceparent |

**Bridge** (`/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge`):

| File | Responsibility | Change |
|---|---|---|
| `src/service.ts` | Span lifecycle, proxy session push | Adopt `event.trace` as remote parent; delete dead env writes; emit per-call span |
| `src/service.test.ts` | Bridge tests | Trace adoption, env deletion, call span |

**Operator config** (not in any repo):

- `~/.openclaw/agents/{main,coder,writer,deployer}/agent/codex-home/config.toml`

Those four agents are the codex-runtime ones: `main` runs `openai/gpt-5.6-sol`, and `coder` / `writer` / `deployer` run `openai/gpt-5.5`; all three `openai/*` models carry `agentRuntime: { id: "codex" }` in `agents.defaults.models`.

---

### Task 1: Turn on codex OTLP export (A1) — proof rung 1

No code. This rung proves OTLP reachability and config validity *before* any correlation work, so a later failure localises instead of presenting as "no spans".

**Files:**
- Modify: `~/.openclaw/agents/main/agent/codex-home/config.toml`
- Modify: `~/.openclaw/agents/coder/agent/codex-home/config.toml`
- Modify: `~/.openclaw/agents/deployer/agent/codex-home/config.toml`
- Create if missing: `~/.openclaw/agents/writer/agent/codex-home/config.toml`

**Interfaces:**
- Consumes: nothing.
- Produces: codex spans in Tempo under service name `codex_app_server`, each carrying `prov.project` and `prov.agent.id` span attributes. Later tasks assume this export is live.

- [ ] **Step 1: Back up every config.toml you are about to touch**

```bash
for a in main coder writer deployer; do
  f=~/.openclaw/agents/$a/agent/codex-home/config.toml
  [ -f "$f" ] && cp -v "$f" "$f.pre-otel-$(date +%Y%m%d-%H%M%S)"
done
```

- [ ] **Step 2: Append the `[otel]` block to each agent's config.toml**

The `agent.id` value differs per agent — do not paste the same block four times without editing it. For `main`:

```toml

[otel]
environment = "prod"

[otel.trace_exporter.otlp-http]
endpoint = "http://10.43.221.47:4318/v1/traces"
protocol = "binary"

[otel.span_attributes]
"prov.project" = "nix"
"prov.agent.id" = "main"
```

Repeat for `coder`, `writer`, `deployer`, changing only `"prov.agent.id"`. Create `~/.openclaw/agents/writer/agent/codex-home/` first if it does not exist (`mkdir -p`).

Shape notes, verified against codex source: `OtelExporterKind` is an externally-tagged serde enum with `rename_all = "kebab-case"` (`codex-rs/config/src/types.rs:522-536`), which is why the table is `[otel.trace_exporter.otlp-http]`. `protocol` has no serde default and is required; `headers` and `tls` do default. `endpoint` is passed verbatim to `SpanExporter::with_endpoint` (`codex-rs/otel/src/provider.rs:409-412`) with no signal path appended, so the `/v1/traces` suffix must be written out. `validate_span_attributes` (`codex-rs/config/src/otel.rs:50`, `codex-rs/otel/src/config.rs:39-48`) rejects only empty keys, so `prov.*` names are accepted.

- [ ] **Step 3: Verify the TOML parses before restarting anything**

```bash
python3 -c "import tomllib,sys; [print(a, tomllib.load(open(f'/home/Arnab/.openclaw/agents/{a}/agent/codex-home/config.toml','rb'))['otel']['trace_exporter']) for a in ['main','coder','writer','deployer']]"
```

Expected: four lines, each printing `{'otlp-http': {'endpoint': 'http://10.43.221.47:4318/v1/traces', 'protocol': 'binary'}}`.

A malformed `[otel]` block is not silently ignored — `build_provider` failure is mapped to `ErrorKind::InvalidData` and aborts app-server startup (`codex-rs/app-server/src/lib.rs:580-586`). Getting this wrong breaks every codex turn, which is exactly why it is checked here.

- [ ] **Step 4: Restart the gateway (ASK THE USER FIRST) and run one codex turn**

Codex config is read at app-server process start, and the app-server is a long-lived shared process. An already-running app-server will not pick this up.

```bash
systemctl --user restart openclaw-gateway.service
```

Then send one message to the `main` agent so a codex turn actually runs.

- [ ] **Step 5: Confirm rung 1 in Tempo**

Query Tempo (NodePort 31989) for the last 15 minutes:

```
{ resource.service.name = "codex_app_server" }
```

Expected: spans present, including `run_turn` and `handle_responses`, each carrying `prov.project="nix"` and `prov.agent.id`. Each trace is its own root — **that is correct at this rung**; correlation arrives in Task 2.

If nothing appears, the fault is export reachability or config, not correlation. Check `journalctl --user -u openclaw-gateway.service --since "5 minutes ago" | grep -i otel` for a codex startup warning.

- [ ] **Step 6: Record the config in the fork notes**

Add a short subsection to `.claude/CLAUDE.md` under the fork-specific notes recording that codex OTLP export is configured per-agent in `CODEX_HOME/config.toml`, that OpenClaw does not manage it, and that the four agents are `main`/`coder`/`writer`/`deployer`. Commit:

```bash
scripts/committer "docs(fork): record per-agent codex OTLP export config" .claude/CLAUDE.md
```

---

### Task 2: Stamp the turn traceparent on `turn/start` (A2) — proof rung 2

**Files:**
- Modify: `extensions/codex/src/app-server/protocol.ts:33-37`
- Modify: `extensions/codex/src/app-server/client.ts:231-255`
- Modify: `extensions/codex/src/app-server/run-attempt.ts:2780`
- Test: `extensions/codex/src/app-server/client.test.ts`

**Interfaces:**
- Consumes: `formatDiagnosticTraceparent(context: DiagnosticTraceContext | undefined): string | undefined` from `openclaw/plugin-sdk/diagnostic-runtime`; the per-attempt `codexModelCallTrace` already built at `run-attempt.ts:455-457`.
- Produces: `CodexAppServerClient.request(method, params, options)` where `options` gains `traceparent?: string`. When set and non-empty, the outgoing JSON-RPC envelope carries `trace: { traceparent }`. When absent, the envelope is byte-identical to today's.

Why a pre-formatted string rather than a `DiagnosticTraceContext`: it keeps the transport client free of any diagnostic import and makes omission a plain `undefined` check. The codex side treats the field as optional (`skip_serializing_if = "Option::is_none"` on `JSONRPCRequest.trace`, `codex-rs/app-server-protocol/src/rpc.rs:49-55`), and `attach_parent_context` (`codex-rs/app-server/src/app_server_tracing.rs:125-141`) prefers the per-request carrier, falling back to the `TRACEPARENT` env var only when it is absent — which is exactly the precedence a shared long-lived app-server process needs.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("CodexAppServerClient", …)` block in `extensions/codex/src/app-server/client.test.ts`:

```ts
  it("stamps the W3C trace carrier on the request envelope when a traceparent is given", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    const request = harness.client.request(
      "turn/start",
      { prompt: "hi" },
      { traceparent },
    );
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as {
      id?: number;
      trace?: { traceparent?: string };
    };
    harness.send({ id: outbound.id, result: {} });
    await request;

    expect(outbound.trace).toEqual({ traceparent });
  });

  it("omits the trace carrier entirely when no traceparent is given", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const request = harness.client.request("turn/start", { prompt: "hi" });
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({ id: outbound.id, result: {} });
    await request;

    expect(Object.hasOwn(outbound, "trace")).toBe(false);
  });
```

`Object.hasOwn` rather than `toBeUndefined()` on purpose: the point of the second test is that the key is *not serialized*, not merely that it reads as undefined.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test extensions/codex/src/app-server/client.test.ts
```

Expected: the first test FAILS with `expected undefined to deeply equal { traceparent: '00-0af7…-01' }`. The second test PASSES already (nothing writes a `trace` key yet) — that is fine; it is a regression guard for the change you are about to make, not a red test.

- [ ] **Step 3: Add the optional trace field to the envelope type**

In `extensions/codex/src/app-server/protocol.ts`, replace the `RpcRequest` type at line 33:

```ts
/** W3C trace carrier on an outbound request; codex parents its span tree on it. */
export type RpcTraceCarrier = {
  traceparent: string;
  tracestate?: string;
};

export type RpcRequest = {
  id?: number | string;
  method: string;
  params?: JsonValue;
  trace?: RpcTraceCarrier;
};
```

- [ ] **Step 4: Thread the option through the client**

In `extensions/codex/src/app-server/client.ts`, add `traceparent?: string` to the options bag on all three `request` overload signatures (lines 234, 239, 244), so each reads:

```ts
    options?: { timeoutMs?: number; signal?: AbortSignal; traceparent?: string },
```

(the implementation signature at line 244 uses `optionsInput?:` — keep that name, just extend the type).

Then replace line 255:

```ts
    // Codex parents the request span on this carrier and exports its whole span
    // tree into our trace id; omitting the key reproduces pre-tracing behavior
    // exactly, since the field is optional on the codex side.
    const message: RpcRequest = {
      id,
      method,
      params: params as JsonValue | undefined,
      ...(options.traceparent ? { trace: { traceparent: options.traceparent } } : {}),
    };
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test extensions/codex/src/app-server/client.test.ts
```

Expected: PASS, both tests.

- [ ] **Step 6: Populate the traceparent at the turn-initiating call**

In `extensions/codex/src/app-server/run-attempt.ts`, add `formatDiagnosticTraceparent` to the existing import from `openclaw/plugin-sdk/diagnostic-runtime` (the import block at lines 44-50 — keep the list alphabetical, so it goes between `emitTrustedDiagnosticEvent` and `freezeDiagnosticTraceContext`).

Immediately after the existing `codexModelCallTrace` assignment at lines 455-457, add:

```ts
  // Formatted once per attempt: turn/start carries it so codex's span tree lands
  // in this turn's trace instead of rooting itself. Undefined when the scope has
  // no span id, which omits the carrier and keeps prior behavior.
  const codexModelCallTraceparent = formatDiagnosticTraceparent(codexModelCallTrace);
```

Then at line 2780, add the option to the `turn/start` call:

```ts
        await client.request("turn/start", turnStartParams, {
          traceparent: codexModelCallTraceparent,
```

keeping the existing options in that object unchanged.

Do **not** add it to `thread/start` (`thread-lifecycle.ts:944`). Thread setup is not a model turn, and parenting it under a turn scope would misattribute setup work.

- [ ] **Step 7: Run the broader codex app-server suite**

```bash
pnpm test extensions/codex/src/app-server
```

Expected: PASS. Watch specifically for `run-attempt.test.ts` and `request.test.ts` — if either asserts on the exact outbound envelope shape, the added key will surface there.

- [ ] **Step 8: Commit**

```bash
scripts/committer "feat(codex): stamp W3C traceparent on turn/start app-server requests" \
  extensions/codex/src/app-server/protocol.ts \
  extensions/codex/src/app-server/client.ts \
  extensions/codex/src/app-server/run-attempt.ts \
  extensions/codex/src/app-server/client.test.ts
```

- [ ] **Step 9: Build, deploy, and confirm rung 2 (ASK BEFORE RESTART)**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
pnpm run build
systemctl --user restart openclaw-gateway.service
```

After restart, confirm the bridge subscription lines are still present (the fork's standing sanity check):

```bash
journalctl --user -u openclaw-gateway.service --since "1 minute ago" --no-pager | grep agentweave-bridge
```

Run one codex turn, then query Tempo:

```
{ resource.service.name = "codex_app_server" }
```

Expected at rung 2: codex spans are no longer their own roots — each trace id now also contains the gateway's spans. Codex logging `ignoring invalid inbound request trace carrier` means the traceparent string is malformed; check `formatDiagnosticTraceparent` output.

---

### Task 3: Bridge adopts the gateway trace id and drops the dead env writes (C, part 1) — proof rung 3

**Files:**
- Modify: `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/src/service.ts` (`message.queued` handler at 547-651; `startUpstreamRootSpanFromSessionState` at 373-452; `stop()` at 938-950)
- Test: `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/src/service.test.ts`

**Interfaces:**
- Consumes: `event.trace?: DiagnosticTraceContext` on trusted diagnostic events — `{ traceId, spanId?, parentSpanId?, traceFlags? }`, all lowercase hex. Guaranteed present by `enrichDiagnosticEvent` (`src/infra/diagnostic-events.ts:1215`: `enriched.trace ??= getActiveDiagnosticTraceContext()`), which runs for *every* dispatched event, and `onTrustedDiagnosticEvent` passes the full payload through unmodified (`diagnostic-events.ts:1554-1563`).
- Produces: bridge turn spans that live in the gateway's trace id rather than a bridge-minted one. Task 4's per-call spans inherit this.

The bridge span and the codex subtree end up **siblings under the gateway scope**, not codex nested inside the bridge span. True nesting would require OpenClaw to know the bridge's span id — plugin identity leaking into core — and buys nothing, since the trace id is the join key either way.

- [ ] **Step 1a: Extend the OTel mock so span starts are observable**

The suite mocks `@opentelemetry/api` wholesale (`src/service.test.ts:13-25`). Two problems for this task: `getTracer` returns a *fresh* object with a *fresh* `startSpan` on every call, so no assertion can see the start arguments; and `trace.setSpanContext` is not mocked at all, so the new code path would throw.

Hoist a shared `startSpan` and add `setSpanContext`. Replace lines 13-25:

```ts
const mockStartSpan = vi.fn(() => mockSpan)

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: vi.fn(() => ({ startSpan: mockStartSpan })),
    setSpan: vi.fn((_ctx: unknown, _span: unknown) => ({})),
    // Returns an identifiable marker so tests can assert which parent context a
    // span was started under without a real SDK.
    setSpanContext: vi.fn((_ctx: unknown, sc: { traceId: string }) => ({
      __parentTraceId: sc.traceId,
    })),
  },
  context: { active: vi.fn(() => ({})) },
  propagation: {
    inject: vi.fn((_ctx: unknown, carrier: Record<string, string>) => {
      carrier["traceparent"] = "00-abc123def456abc123def456abc12345-def456abc12345de-01"
    }),
  },
  SpanStatusCode: { ERROR: 2, OK: 1 },
}))
```

`mockStartSpan` must be declared with `const` *above* the `vi.mock` call but is referenced inside the factory — that is fine here because Vitest hoists `vi.mock` but the factory body only runs on first import, after module init. The existing `mockSpan` const (line 5) already relies on the same ordering.

`vi.clearAllMocks()` in `beforeEach` (line 112) resets `mockStartSpan` between tests, so no extra teardown is needed.

- [ ] **Step 1b: Write the failing tests**

Add to the main `describe("createAgentWeaveBridgeService", …)` block in `src/service.test.ts`:

```ts
  it("starts the turn span inside the gateway trace id from event.trace", () => {
    const gatewayTraceId = "0af7651916cd43dd8448eb211c80319c"

    fire({
      type: "message.queued",
      sessionKey: "agent:main:trace-adopt",
      sessionId: "018f-openclaw-main-trace",
      channel: "cli",
      source: "user",
      ts: Date.now(),
      seq: 1,
      trace: { traceId: gatewayTraceId, spanId: "b7ad6b7169203331", traceFlags: "01" },
    })

    expect(mockStartSpan).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      { __parentTraceId: gatewayTraceId },
    )
  })

  it("falls back to the active context when the event carries no usable trace", () => {
    fire({
      type: "message.queued",
      sessionKey: "agent:main:trace-missing",
      sessionId: "018f-openclaw-main-notrace",
      channel: "cli",
      source: "user",
      ts: Date.now(),
      seq: 1,
    })

    expect(mockStartSpan).toHaveBeenCalledWith(expect.any(String), undefined, {})
  })

  it("does not write traceparent env vars", () => {
    fire({
      type: "message.queued",
      sessionKey: "agent:main:no-env",
      sessionId: "018f-openclaw-main-noenv",
      channel: "cli",
      source: "user",
      ts: Date.now(),
      seq: 1,
      trace: { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" },
    })

    expect(process.env.AGENTWEAVE_TRACEPARENT).toBeUndefined()
    expect(process.env.AGENTWEAVE_PARENT_TRACE_ID).toBeUndefined()
    expect(process.env.AGENTWEAVE_PARENT_SPAN_ID).toBeUndefined()
  })
```

The second test is the guard that a missing or malformed `trace` degrades to today's behavior rather than throwing — `{}` is what the mocked `context.active()` returns.

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge && npm test
```

Expected:
- Test 1 FAILS — `mockStartSpan` was called with `{}` (the active context), not `{ __parentTraceId: '0af7…' }`.
- Test 2 PASSES already. It is a regression guard for the fallback branch you are about to add, not a red test.
- Test 3 FAILS — `expected '00-abc123…-01' to be undefined`.
- The pre-existing test at line 137 (`"creates root span on message.queued and injects traceparent"`) still passes at this point; Step 6 removes its env assertion.

- [ ] **Step 3: Add a trace-adoption helper**

Near the top of `src/service.ts`, after the `ActiveTurn` interface:

```ts
/**
 * Builds a parent Context from OpenClaw's DiagnosticTraceContext so bridge spans
 * join the gateway trace instead of rooting their own. Without this the bridge
 * and codex export into two unrelated traces and the join silently fails at
 * query time — it looks like it works until you try to correlate.
 */
function contextFromOpenClawTrace(rawTrace: unknown): Context {
  const t = rawTrace as { traceId?: string; spanId?: string; traceFlags?: string } | undefined
  if (!t?.traceId || !t.spanId) return context.active()
  if (!/^[0-9a-f]{32}$/.test(t.traceId) || !/^[0-9a-f]{16}$/.test(t.spanId)) return context.active()
  return trace.setSpanContext(context.active(), {
    traceId: t.traceId,
    spanId: t.spanId,
    traceFlags: t.traceFlags === "00" ? 0 : 1,
    isRemote: true,
  })
}
```

- [ ] **Step 4: Use it at both span-start sites**

In the `message.queued` handler, replace line 563:

```ts
              const span = tracer.startSpan("openclaw.turn", undefined, contextFromOpenClawTrace(e.trace))
```

In `startUpstreamRootSpanFromSessionState`, replace line 383 the same way. That function receives the event as its `e` parameter, so `contextFromOpenClawTrace(e.trace)` works unchanged.

Leave the subagent span at line 739 alone — it is started from a session.state transition whose trace scope belongs to the parent turn, and changing it is a separate behavior question.

- [ ] **Step 5: Delete the dead env writes**

Nothing reads these. The bridge is their only writer, and `sdk/python/tests/test_proxy.py:2652` asserts the proxy must not honor the parent-id pair; the proxy takes those ids from the `/session` POST body instead.

Delete, in `src/service.ts`:
- lines 427-431 (`const carrier` / `propagation.inject` / the `AGENTWEAVE_TRACEPARENT` write) and lines 439-440 (the two `AGENTWEAVE_PARENT_*` writes)
- lines 619-623 and 638-639 (the same two blocks in the `message.queued` handler)
- lines 492-493, 713-714, and 946 (the matching `delete process.env.…` cleanups)

**Keep** `parentTraceIdHex` / `parentSpanIdHex` and their `span.spanContext()` derivation — the `/session` payload still uses them (lines 471-472, 684-685). Only the `process.env` assignments go.

If `propagation` is now unused, drop it from the import at line 1. Let the compiler tell you: `npx tsc --noEmit`.

- [ ] **Step 6: Delete the tests that asserted the removed env writes**

`src/service.test.ts:159` asserts `expect(process.env.AGENTWEAVE_TRACEPARENT).toBeTruthy()`. Delete that single line, and retitle the enclosing test at line 137 from `"creates root span on message.queued and injects traceparent"` to `"creates root span on message.queued"` — it no longer injects anything.

Keep line 160 (`AGENTWEAVE_SESSION_ID`) — that env var is a different mechanism and is not being removed. Keep the `beforeEach` cleanup at line 114 so the Step 1b assertion stays hermetic against a polluted ambient environment.

Then grep for stragglers and remove any that assert the three removed vars:

```bash
/usr/bin/grep -rn "AGENTWEAVE_TRACEPARENT\|AGENTWEAVE_PARENT_TRACE_ID\|AGENTWEAVE_PARENT_SPAN_ID" src/
```

Expected after this step: only the three `toBeUndefined()` assertions from Step 1b and the `beforeEach` cleanup remain.

- [ ] **Step 7: Run to verify pass**

```bash
cd /home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge && npm test
```

Expected: PASS, full suite.

- [ ] **Step 8: Commit**

```bash
cd /home/Arnab/dev/agentweave
git add plugins/openclaw-agentweave-bridge/src/service.ts plugins/openclaw-agentweave-bridge/src/service.test.ts
git commit -m "fix(openclaw-bridge): adopt gateway trace id and drop unread traceparent env writes"
```

(Never `git add -A` in this repo.)

- [ ] **Step 9: Build the bundle, deploy, and confirm rung 3 (ASK BEFORE RESTART)**

```bash
cd /home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge
npm run build:bundle && npm run verify:bundle
cp -v ~/.openclaw/user-plugins/agentweave-bridge/index.js \
      ~/.openclaw/user-plugins/agentweave-bridge/index.js.bak-$(date +%Y%m%d-%H%M%S)
cp -v bundle/index.js ~/.openclaw/user-plugins/agentweave-bridge/index.js
systemctl --user restart openclaw-gateway.service
```

Confirm the bridge loaded:

```bash
journalctl --user -u openclaw-gateway.service --since "1 minute ago" --no-pager | grep agentweave-bridge
```

Run one codex turn, then query Tempo for the joined trace:

```
{ span.prov.session.id != "" && resource.service.name = "openclaw-agentweave-bridge" }
```

Take the trace id off the resulting bridge span and open that trace. Expected: the bridge's `openclaw.turn` span and codex's `run_turn` → `stream_request` → `handle_responses` subtree in the same trace, as siblings.

---

### Task 4: Bridge emits a per-model-call span

**Files:**
- Modify: `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/src/service.ts:896-917` (the `model.call.completed` case)
- Test: `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/src/service.test.ts`

**Interfaces:**
- Consumes: `contextFromOpenClawTrace` from Task 3; the `findTurnForModelUsage(sessionKey, sessionId)` helper already in the file, which returns `{ key, turn, reason } | null`.
- Produces: one `llm.call` span per `model.call.completed`, child of the turn span, carrying `prov.session.id`, `prov.llm.provider`, `prov.llm.model`.

Why this span exists when codex already emits `handle_responses` with richer token data: codex's spans cannot carry `prov.session.id`. Putting session id on them would need per-session `span_attributes`, which is per-config-file, and OpenClaw scopes `CODEX_HOME` per *agent* — so it would mean rewriting `config.toml` every turn and restarting the shared app-server. This span is the flat, queryable session key; codex's subtree is the depth. They are joined by trace id.

- [ ] **Step 1: Write the failing test**

```ts
  it("emits a child llm.call span carrying the session id on model.call.completed", () => {
    fire({
      type: "message.queued",
      sessionKey: "agent:main:call-span",
      sessionId: "018f-openclaw-main-call",
      channel: "cli",
      source: "user",
      ts: Date.now(),
      seq: 1,
    })
    mockStartSpan.mockClear()

    fire({
      type: "model.call.completed",
      sessionKey: "agent:main:call-span",
      sessionId: "018f-openclaw-main-call",
      provider: "openai",
      model: "gpt-5.6-sol",
      ts: Date.now(),
      seq: 2,
    })

    expect(mockStartSpan).toHaveBeenCalledWith("llm.call", undefined, expect.anything())
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("prov.llm.model", "gpt-5.6-sol")
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("prov.session.id", "018f-openclaw-main-call")
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("prov.llm.provider", "openai")
  })
```

The `mockStartSpan.mockClear()` between the two events matters: `message.queued` starts the turn span, so without it the `"llm.call"` assertion could pass against the wrong call. `model.call.completed` is *not* in `TRUSTED_LIFECYCLE_TYPES`, so `fire` routes it through the public listener only — which is correct, it is a public diagnostic event.

Note that `mockSpan` is a shared singleton in this suite, so `setAttribute` assertions cannot distinguish the turn span from the call span. The `prov.session.id` assertion is therefore weak on its own — it is the `mockStartSpan` name assertion that proves the new span exists. Tempo verification in Step 6 is what confirms the attributes actually land on the call span.

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge && npm test
```

Expected: FAIL — `expected undefined not to be undefined` on `callSpan`.

- [ ] **Step 3: Emit the span**

`tracer` is declared per-case in this file (lines 562, 738) and is **not** in scope in the `model.call.completed` case. `config` is in closure scope and needs no declaration.

In the `model.call.completed` case, after the existing `provider` / `model` guards and the two `setAttribute` calls on the turn span (line 916), add:

```ts
              const tracer = trace.getTracer("openclaw-agentweave-bridge")
              // Flat, queryable per-call span. Codex's own handle_responses span
              // has the token detail but cannot carry prov.session.id (its
              // span_attributes are per-config-file, and CODEX_HOME is per-agent),
              // so this is what a session-id filter actually finds.
              const callSpan = tracer.startSpan("llm.call", undefined, match.turn.ctx)
              callSpan.setAttribute("prov.session.id", e.sessionId ?? "")
              callSpan.setAttribute("prov.session.key", match.key)
              if (provider) callSpan.setAttribute("prov.llm.provider", provider)
              if (model) callSpan.setAttribute("prov.llm.model", model)
              if (config.project) callSpan.setAttribute("prov.project", config.project)
              callSpan.end()
```

Also update the case's leading comment: it currently says the event's identity attributes are all this handler can stamp. That is still true of the *turn* span, but the handler now also emits a call span — the comment should say so.

The span opens and closes immediately: `model.call.completed` is a completion event, so there is no live interval to represent. Duration is not the signal here; attribution is.

- [ ] **Step 4: Run to verify pass**

```bash
cd /home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge && npm test
```

Expected: PASS, full suite.

- [ ] **Step 5: Commit**

```bash
cd /home/Arnab/dev/agentweave
git add plugins/openclaw-agentweave-bridge/src/service.ts plugins/openclaw-agentweave-bridge/src/service.test.ts
git commit -m "feat(openclaw-bridge): emit per-call llm.call span with session attribution"
```

- [ ] **Step 6: Deploy and verify the success criterion (ASK BEFORE RESTART)**

Same bundle/copy/restart sequence as Task 3 Step 9. Then run one Nix turn on `openai/gpt-5.6-sol` and query Tempo:

```
{ span.prov.session.id != "" }
```

Success criterion, from the spec: a trace containing `handle_responses` with `gen_ai.usage.*` populated, reachable from a `prov.session.id` filter. Compare against the measured baseline — 202 `llm.*` spans in 7 days, all `project=claude-code`, zero from OpenClaw; `prov.session.id="nix-main"` appearing once in 14 days.

---

### Task 5: Pre-land gate and close-out

**Files:**
- Modify: `.claude/CLAUDE.md` (fork notes)

- [ ] **Step 1: Check the diff size**

```bash
cd /home/Arnab/clawd/projects/openclaw && git diff --numstat origin/main...HEAD -- extensions/
```

Task 2 should be net-small. If non-test prod LOC grew meaningfully, trim before landing — the root guide treats positive prod LOC as a smell. Task 3 is net-negative by construction (the env writes and their tests are deleted).

- [ ] **Step 2: Run a fresh `$autoreview` on the OpenClaw change**

Mandatory pre-land. Resolve every accepted finding; if a finding wants a refactor, refactor rather than patching around it.

- [ ] **Step 3: Correct the bridge build path in the fork notes**

`.claude/CLAUDE.md` currently documents the bridge as building with `npm run build` into `dist/src/service.js`. The deployed artifact is the esbuild bundle copied to `~/.openclaw/user-plugins/agentweave-bridge/index.js`. Fix that section, and note that `grep 'case "model.call.completed"' …/dist/src/service.js` is checking the wrong file.

- [ ] **Step 4: Run the changed-file gate and commit**

```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
pnpm check:changed
scripts/committer "docs(fork): correct agentweave-bridge build and deploy path" .claude/CLAUDE.md
```

- [ ] **Step 5: Report against #264**

Post the outcome on agentweave#264: what the codex path now emits, the trace-id join, the Tempo query that demonstrates it, and the before/after against the measured baseline. Draft in chat for review before posting — no surprise public writes.

---

## Deferred (not in this plan)

- **Phase 2 payload capture.** Blocked on four named prerequisites in the spec: a logs backend and pipeline, a PII posture decision, a retention/access policy, and a separate `otel.exporter` endpoint. Do not enable `log_user_prompt` here.
- `proxy.py:1103` read path lacks `move_to_end`, so the forced-context LRU does not refresh on read.
- `service.ts:689` `/session` POST is fire-and-forget, and becomes the sole attribution mechanism once static headers are removed.
- Removing static `X-AgentWeave-Session-Id` / `Agent-Id` / `Agent-Type` from the `anthropic` and `openai` provider blocks. Now known to be a no-op for `openai` — nothing reads that block on the codex path.
