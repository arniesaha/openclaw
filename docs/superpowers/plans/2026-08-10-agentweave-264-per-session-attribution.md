# agentweave#264 per-session attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every OpenClaw model call that traverses the AgentWeave proxy resolve to its own session identity, then delete the static `nix-main` header that currently masks the gap.

**Architecture:** The `x-agentweave-session-key` header chain already works end to end. The defect is that the bridge tells the proxy *not* to force a context for main-agent turns, so the proxy falls through to a hardcoded header. Fix the bridge's two `force` decisions, close one path in the OpenClaw fork where the header stamp can be dropped, verify forced contexts are registering while the static header is still in place, and only then remove it.

**Tech Stack:** TypeScript (OpenClaw fork + bridge plugin), Vitest, esbuild bundle, Python FastAPI proxy (read-only — not modified), systemd user unit.

Spec: `docs/superpowers/specs/2026-08-10-agentweave-264-per-session-attribution-design.md`

## Global Constraints

- Three repos are involved. Bridge source of truth is `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/` — **not** `~/.openclaw/user-plugins/agentweave-bridge/src/`, which is stale vestigial (Jun 8) and is not built from.
- The deployed bridge artifact is `~/.openclaw/user-plugins/agentweave-bridge/index.js`, built via `npm run build:bundle` (esbuild) — not `npm run build` (tsc), and not `dist/`.
- OpenClaw fork work happens on branch `upgrade/v2026.7.1` in `/home/Arnab/clawd/projects/openclaw`.
- Node for all OpenClaw builds: `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH` before any `pnpm`.
- The OpenClaw fork carry's stated contract is that stock builds are **byte-for-byte unchanged on the wire**. Any new behavior must stay behind `OPENCLAW_AGENTWEAVE_SESSION_KEY_HEADER === "1"`.
- Task 5 (config change) must not start until Task 4's gate passes. Removing the static header before forced contexts are confirmed would replace one wrong label (`nix-main`) with another (`unattributed:nix`).
- Gateway restarts interrupt any active Nix session and the Telegram bot loop. **Ask the user before each restart** — do not restart unprompted.
- No changes to `proxy.py`. No changes to the `minimax` provider block (routes through Mux, coordinated in mux#67).
- Commit OpenClaw changes with `scripts/committer "<msg>" <file...>`. Commit bridge changes with plain `git` in the agentweave repo.

## File Structure

| File | Repo | Responsibility | Task |
|---|---|---|---|
| `src/agents/embedded-agent-runner/stream-resolution.ts` | openclaw fork | Stamp the session-key header; close the tail-branch drop | 1 |
| `src/agents/embedded-agent-runner/stream-resolution.test.ts` | openclaw fork | Prove the tail branch wraps and stamps | 1 |
| `plugins/openclaw-agentweave-bridge/src/service.ts` | agentweave | `force` decision for main turns; subagent idle handling | 2, 3 |
| `plugins/openclaw-agentweave-bridge/src/service.test.ts` | agentweave | Prove force:true on main turns; prove no clear on idle | 2, 3 |
| `~/.openclaw/openclaw.json` | live config | Remove static attribution headers | 5 |
| `.claude/CLAUDE.md` | openclaw fork | Correct the stale bridge build/deploy instructions | 6 |

---

### Task 1: Close the sessionKey drop in the OpenClaw fork

The tail of `resolveEmbeddedAgentStreamFn` returns the stream fn unwrapped when there is no prompt cache key, and wraps without `sessionKey` when there is one. Either way the header stamp is lost. This is reachable when `resolvedApiKey` is empty and the model is not the proxied-non-`anthropic` case at `:207`.

**Files:**
- Modify: `src/agents/embedded-agent-runner/stream-resolution.ts:20-36` (extract env gate), `:232-243` (tail branch)
- Test: `src/agents/embedded-agent-runner/stream-resolution.test.ts` (append to the existing `describe("withAgentweaveSessionKeyHeader")` block, or add a sibling `describe`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks depend on. `resolveEmbeddedAgentStreamFn`'s exported signature is unchanged — `sessionKey?: string` already exists on its params object.

- [ ] **Step 1: Write the failing test**

Append this sibling `describe` block to the end of `src/agents/embedded-agent-runner/stream-resolution.test.ts`. It drives the real `resolveEmbeddedAgentStreamFn` down the tail branch (no prompt cache key, no resolved API key, an api value with no boundary-aware transport) and asserts the header reaches the inner stream fn's options.

```ts
describe("resolveEmbeddedAgentStreamFn tail branch session key", () => {
  const ENV = "OPENCLAW_AGENTWEAVE_SESSION_KEY_HEADER";
  const prev = process.env[ENV];

  afterEach(() => {
    if (prev === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = prev;
    }
  });

  function captureOptions(sessionKey: string | undefined) {
    const seen: Record<string, unknown>[] = [];
    const inner: StreamFn = ((_m: never, _c: never, options: Record<string, unknown>) => {
      seen.push(options ?? {});
      return undefined as never;
    }) as never;
    const streamFn = resolveEmbeddedAgentStreamFn({
      currentStreamFn: inner,
      sessionId: "s1",
      sessionKey,
      model: { provider: "custom-proxy", api: "custom-api", id: "m1" } as never,
    });
    streamFn({ provider: "custom-proxy", id: "m1" } as never, {} as never, {});
    return seen[0] ?? {};
  }

  it("stamps the session key when there is no prompt cache key", () => {
    process.env[ENV] = "1";
    const options = captureOptions("agent:main:main");
    expect(requireRecord(options.headers, "headers")["x-agentweave-session-key"]).toBe(
      "agent:main:main",
    );
  });

  it("leaves the stream fn unwrapped when the env gate is off", () => {
    delete process.env[ENV];
    const options = captureOptions("agent:main:main");
    expect(options.headers).toBeUndefined();
  });
});
```

Add `resolveEmbeddedAgentStreamFn` and the `StreamFn` type to the file's existing imports if they are not already imported.

- [ ] **Step 2: Run the test and verify it fails**

Per root `AGENTS.md` these run on the remote box:

```bash
pnpm test src/agents/embedded-agent-runner/stream-resolution.test.ts
```

Expected: the first test FAILS — `options.headers` is `undefined`, because the tail branch at `:236` returns `currentStreamFn` raw. The second test should already pass.

If Crabbox/Testbox is unavailable, the documented local fallback is `node scripts/run-vitest.mjs src/agents/embedded-agent-runner/stream-resolution.test.ts` — and you must report that you used the fallback.

- [ ] **Step 3: Extract the env gate**

In `src/agents/embedded-agent-runner/stream-resolution.ts`, replace the inline env check inside `withAgentweaveSessionKeyHeader` with a shared helper so the tail branch can ask the same question:

```ts
// Fork carry (default off): when OPENCLAW_AGENTWEAVE_SESSION_KEY_HEADER === "1",
// stamp the run's sessionKey onto outbound LLM requests as x-agentweave-session-key.
// The agentweave proxy joins this run's child LLM spans to the forced upstream
// context keyed by that header (proxy _forced_session_contexts). Stock builds and
// any other deployment leave the wire byte-for-byte unchanged.
function agentweaveSessionKeyHeaderEnabled(): boolean {
  return process.env.OPENCLAW_AGENTWEAVE_SESSION_KEY_HEADER === "1";
}

export function withAgentweaveSessionKeyHeader(
  options: EmbeddedStreamOptions | undefined,
  sessionKey: string | undefined,
): EmbeddedStreamOptions | undefined {
  if (!sessionKey || !agentweaveSessionKeyHeaderEnabled()) {
    return options;
  }
  return {
    ...options,
    headers: { ...options?.headers, "x-agentweave-session-key": sessionKey },
  };
}
```

- [ ] **Step 4: Fix the tail branch**

Replace the tail of `resolveEmbeddedAgentStreamFn` (currently `:232-243`) with:

```ts
  const promptCacheKey = params.promptCacheKey?.trim();
  // The header stamp rides this wrapper, so a run that has a sessionKey must
  // still be wrapped even with no prompt cache key — otherwise proxied
  // attribution silently falls back to the provider's static headers. Gated on
  // the env flag so stock builds keep returning the stream fn untouched.
  const needsSessionKeyStamp = Boolean(params.sessionKey) && agentweaveSessionKeyHeaderEnabled();
  if (!promptCacheKey && !needsSessionKeyStamp) {
    return currentStreamFn;
  }
  return wrapEmbeddedAgentStreamFn(currentStreamFn, {
    runSignal: params.signal,
    resolvedApiKey: undefined,
    authProfileId: undefined,
    authStorage: undefined,
    providerId: params.model.provider,
    promptCacheKey,
    sessionKey: params.sessionKey,
  });
```

Note `promptCacheKey` is now possibly `undefined` here; `wrapEmbeddedAgentStreamFn` already declares it optional (`promptCacheKey?: string`) and re-trims it inside `mergeRunSignal`, so no signature change is needed.

- [ ] **Step 5: Run the tests and verify they pass**

```bash
pnpm test src/agents/embedded-agent-runner/stream-resolution.test.ts
```

Expected: PASS, including the four pre-existing `withAgentweaveSessionKeyHeader` tests.

- [ ] **Step 6: Run the neighbouring suites for regressions**

```bash
pnpm test src/agents/embedded-agent-runner/ src/agents/anthropic-transport-stream.test.ts src/agents/openai-transport-stream.test.ts
```

Expected: PASS. These cover the transports that consume `options.headers`.

- [ ] **Step 7: Commit**

```bash
cd /home/Arnab/clawd/projects/openclaw
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
scripts/committer "fix(agents): keep the agentweave session key stamp on the tail stream path" \
  src/agents/embedded-agent-runner/stream-resolution.ts \
  src/agents/embedded-agent-runner/stream-resolution.test.ts
git push origin upgrade/v2026.7.1
```

**Note on scope:** no separate transport-level test is added. `src/agents/anthropic-transport-stream.test.ts:579-618` already proves an arbitrary caller header from `options.headers` reaches the guarded fetch init (`X-Call`), and this task proves the stamp reaches `options.headers`. A third test asserting the same two hops with a different header name would be duplicate coverage.

---

### Task 2: Force the proxy context for main-agent turns

This is the load-bearing fix. `force: Boolean(upstream) || effectiveAgentType === "subagent"` is `false` for a plain Telegram/cron main turn, and `force:false` with a `session_key` makes the proxy **delete** the entry (`proxy.py:530-534`), guaranteeing fallthrough to the static header.

**Files:**
- Modify: `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/src/service.ts:673`
- Test: `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/src/service.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (different repo, independent).
- Produces: the test helpers `sessionPostBodies()` and the `describe("proxy /session forced context")` harness, reused by Task 3.

- [ ] **Step 1: Write the failing test**

Append this **top-level sibling** `describe` to `src/service.test.ts` (sibling, not nested — the existing outer `beforeEach` starts a service without `proxyUrl`, which would suppress the `/session` POST entirely). It reuses the module-scope `makeCtx` and `fire` helpers already in the file.

```ts
describe("proxy /session forced context", () => {
  let service: ReturnType<typeof createAgentWeaveBridgeService>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    delete (globalThis as Record<string, unknown>).__openclawDiagnosticEventsState
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    service = createAgentWeaveBridgeService()
    await service.start(makeCtx({ proxyUrl: "http://proxy.test:4000" }))
  })

  afterEach(async () => {
    await service.stop()
    vi.unstubAllGlobals()
  })

  // Every /session POST body the bridge sent, in order.
  function sessionPostBodies(): Record<string, unknown>[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/session"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
  }

  it("forces the proxy context for a plain main turn with no upstream bag", () => {
    fire({
      type: "message.queued",
      sessionKey: "agent:main:main",
      sessionId: "018f-openclaw-main-plain",
      channel: "telegram",
      source: "user",
      ts: Date.now(),
      seq: 1,
    })

    const bodies = sessionPostBodies()
    expect(bodies).toHaveLength(1)
    expect(bodies[0].session_key).toBe("agent:main:main")
    expect(bodies[0].agent_type).toBe("main")
    // force:false would make the proxy DELETE this key and fall back to the
    // static X-AgentWeave-Session-Id header (issue #264).
    expect(bodies[0].force).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd /home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge
npm test -- src/service.test.ts -t "forces the proxy context"
```

Expected: FAIL with `expected false to be true` on the `force` assertion.

If instead it fails on `expect(bodies).toHaveLength(1)` with length 0, the `message.queued` payload is missing a field the POST guard needs — add a `console.log(fetchMock.mock.calls)` to see what was sent, and compare the event shape against the existing passing test at `src/service.test.ts:480-520`. Do not proceed until the failure is the `force` assertion.

- [ ] **Step 3: Make the minimal change**

`src/service.ts:673` — replace the `force` line and its comment:

```ts
                  // Always force: the proxy's per-key map (#149) isolates
                  // concurrent keys, so main turns can claim their own context
                  // safely. force:false would instead DELETE the entry and let
                  // the static X-AgentWeave-Session-Id header win (#264).
                  force: true,
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test -- src/service.test.ts -t "forces the proxy context"
```

Expected: PASS.

- [ ] **Step 5: Run the full bridge suite**

```bash
npm test
```

Expected: PASS. If a pre-existing test asserted `force: false` for main turns, it encoded the bug — delete it rather than update it, and say so in the commit message.

- [ ] **Step 6: Commit**

```bash
cd /home/Arnab/dev/agentweave
git add plugins/openclaw-agentweave-bridge/src/service.ts plugins/openclaw-agentweave-bridge/src/service.test.ts
git commit -m "fix(openclaw-bridge): force the proxy session context on main turns (#264)"
```

---

### Task 3: Stop clearing the forced context when a subagent goes idle

The `force:false` POST on subagent idle is a vestige of the pre-#149 global-flag era — its comment says "restore proxy to main session," which only made sense when one global flag was shared. Under per-key contexts the subagent's key is distinct from main's, so the clear protects nothing and opens a window where late subagent calls fall back to the static header.

**Files:**
- Modify: `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/src/service.ts:807-835`
- Test: `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/src/service.test.ts`

**Interfaces:**
- Consumes: the `describe("proxy /session forced context")` harness and `sessionPostBodies()` from Task 2.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Add this `it` inside the `describe("proxy /session forced context")` block created in Task 2:

```ts
  it("does not clear the forced context when a subagent goes idle", () => {
    fire({
      type: "message.queued",
      sessionKey: "agent:main:subagent:worker-1",
      sessionId: "018f-openclaw-sub-1",
      channel: "cli",
      source: "user",
      ts: Date.now(),
      seq: 1,
    })
    // Ignore the turn-start POST; only the idle transition matters here.
    fetchMock.mockClear()

    fire({
      type: "session.state",
      sessionKey: "agent:main:subagent:worker-1",
      state: "idle",
      ts: Date.now(),
      seq: 2,
    })

    // A force:false POST here would delete the subagent's entry and let late
    // LLM calls fall back to the static header (#264).
    expect(sessionPostBodies()).toHaveLength(0)
  })
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd /home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge
npm test -- src/service.test.ts -t "does not clear the forced context"
```

Expected: FAIL — one POST body with `force: false`.

If it passes immediately with length 0, the idle handler did not fire because `message.queued` never registered an `activeTurns` entry for that key (the handler is guarded by `activeTurns.has(sessionKey)`). Log `sessionPostBodies()` after the first `fire` to confirm a turn-start POST happened; if it did not, adjust the `message.queued` payload until it does before continuing.

- [ ] **Step 3: Delete the clearing POST**

In `src/service.ts`, inside the `if (sessionKey.includes(":subagent:") && activeTurns.has(sessionKey))` / `if (state === "idle")` block, keep the span bookkeeping and delete the `fetch(...)` call plus its comment. The block becomes:

```ts
              // End subagent span when session goes idle. The per-key forced
              // context is intentionally left in place: under the #149 per-key
              // map it cannot misattribute another session, and clearing it
              // would let late LLM calls on this key fall back to the static
              // provider headers (#264). Orphans are bounded by the proxy's
              // _MAX_FORCED_CONTEXTS LRU.
              if (sessionKey.includes(":subagent:") && activeTurns.has(sessionKey)) {
                if (state === "idle") {
                  const turn = activeTurns.get(sessionKey)!
                  turn.span.setAttribute("outcome", "completed")
                  turn.span.end()
                  activeTurns.delete(sessionKey)

                  console.log(`[agentweave-bridge] ended subagent span: ${sessionKey}`)
                }
              }
```

`normalizeProxyBaseUrl` stays — it is still called at `service.ts:445`, `:644`, and `:658`. Re-check with `grep -n "normalizeProxyBaseUrl" src/service.ts` after the edit rather than assuming.

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test -- src/service.test.ts -t "does not clear the forced context"
```

Expected: PASS.

- [ ] **Step 5: Run the full bridge suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/Arnab/dev/agentweave
git add plugins/openclaw-agentweave-bridge/src/service.ts plugins/openclaw-agentweave-bridge/src/service.test.ts
git commit -m "fix(openclaw-bridge): keep the subagent forced context after idle (#264)"
```

---

### Task 4: Build, deploy, and pass the pre-config gate

Ship Tasks 1-3 to the live gateway **with the static header still in place**, and prove forced contexts are now being registered for main turns. A regression here is invisible in span data, so this gate is the only safe point to confirm before Task 5 removes the safety net.

**Files:**
- Modify: `~/.openclaw/user-plugins/agentweave-bridge/index.js` (deployed artifact, replaced by build output)
- Modify: `dist/**` in the openclaw fork (build output, not committed)

**Interfaces:**
- Consumes: the committed changes from Tasks 1, 2, and 3.
- Produces: a verified-live baseline that Task 5 depends on.

- [ ] **Step 1: Build and verify the bridge bundle**

```bash
cd /home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
npm run build:bundle
npm run verify:bundle
```

Expected: `bundle/index.js` written, verify passes.

- [ ] **Step 2: Back up and deploy the bundle**

```bash
cd ~/.openclaw/user-plugins/agentweave-bridge
cp index.js "index.js.bak-$(date +%Y%m%d-%H%M%S)"
cp /home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/bundle/index.js index.js
grep -c "force: true" index.js
```

Expected: the grep finds the forced flag in the bundle (a non-zero count).

- [ ] **Step 3: Build the OpenClaw fork**

```bash
cd /home/Arnab/clawd/projects/openclaw
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
pnpm run build
grep -rc "x-agentweave-session-key" dist/ | grep -v ":0" | head
```

Expected: at least one dist chunk still contains the header name.

- [ ] **Step 4: Ask the user before restarting, then restart**

Restarting interrupts any active Nix session and the Telegram loop. Ask first. On approval:

```bash
systemctl --user restart openclaw-gateway.service
sleep 5
journalctl --user -u openclaw-gateway.service --since "1 minute ago" --no-pager | grep agentweave-bridge
```

Expected three subscription lines, per the fork's `.claude/CLAUDE.md` sanity check:
- `subscribed to diagnostic events via plugin-sdk`
- `subscribed to model.* trusted events via plugin-sdk`
- `subscribed to trusted lifecycle clientContext via plugin-sdk`

If the `model.*` line is replaced by the `missing onModelDiagnosticEvent` warning, the `onModelDiagnosticEvent` fork carry was lost in the build — stop and restore it per `.claude/CLAUDE.md` before continuing.

- [ ] **Step 5: Drive one plain main turn and confirm the forced context registers**

Send a single Telegram message to the bot (a genuine solo main turn — not concurrent with another, so the concurrent-turn heuristic at `service.ts:68-72` cannot reclassify it to subagent). Then:

```bash
journalctl --user -u openclaw-gateway.service --since "2 minutes ago" --no-pager \
  | grep -E "proxy session set for|concurrent-turn"
```

Expected: a line reading `proxy session set for main: <session id>`. Before this change that line never appeared for solo main turns.

If the log shows `concurrent-turn: ... → subagent`, another turn overlapped — wait for idle and repeat, otherwise the gate proves nothing.

- [ ] **Step 6: Confirm the proxy actually stored it**

```bash
curl -s http://192.168.1.70:30400/session | head -20
```

Expected: the mirrored context reflects the turn just sent (`prov.session.id` is the OpenClaw session id, not `nix-main`).

**Gate:** do not start Task 5 until Step 5 shows `proxy session set for main` and Step 6 shows a non-`nix-main` context. If either fails, stop and diagnose — the fix is not live.

---

### Task 5: Remove the static attribution headers

With forced contexts confirmed, the static headers are now pure fallback-to-wrong-answer. Remove the three attribution headers from both proxy-routed providers, keeping `X-AgentWeave-Project` (the proxy uses it for the self-identifying `unattributed:{project}` bucket at `proxy.py:1149-1151`).

**Files:**
- Modify: `~/.openclaw/openclaw.json` — `models.providers.anthropic.headers`, `models.providers.openai.headers`

**Interfaces:**
- Consumes: Task 4's verified gate.
- Produces: the final state the issue's acceptance criteria are checked against.

- [ ] **Step 1: Back up the config**

```bash
cp ~/.openclaw/openclaw.json "$HOME/.openclaw/openclaw.json.pre-264-$(date +%Y%m%d-%H%M%S)"
ls -la ~/.openclaw/openclaw.json.pre-264-*
```

- [ ] **Step 2: Remove the three headers from both providers**

Edit `~/.openclaw/openclaw.json`. For both `models.providers.anthropic.headers` and `models.providers.openai.headers`, delete `X-AgentWeave-Session-Id`, `X-AgentWeave-Agent-Id`, and `X-AgentWeave-Agent-Type`. Each block should be left as:

```json
"headers": {
  "X-AgentWeave-Project": "nix"
}
```

Leave `models.providers.minimax.headers` untouched — it routes through Mux, not this proxy.

- [ ] **Step 3: Verify the edit and that the config still parses**

```bash
python3 -c "
import json; c=json.load(open('/home/Arnab/.openclaw/openclaw.json'))
for k in ('anthropic','openai','minimax'):
    print(k, json.dumps(c['models']['providers'][k].get('headers')))
"
grep -c "nix-main" ~/.openclaw/openclaw.json
```

Expected: `anthropic` and `openai` show only `X-AgentWeave-Project`; `minimax` is unchanged; the `nix-main` count is 0.

- [ ] **Step 4: Validate with doctor**

```bash
cd /home/Arnab/clawd/projects/openclaw
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
pnpm openclaw doctor
```

Expected: no new config errors. Do not run `--fix` unless doctor reports something specific.

- [ ] **Step 5: Ask the user, then restart and run the acceptance test**

On approval:

```bash
systemctl --user restart openclaw-gateway.service
```

Then drive **two non-concurrent turns in different sessions** — one Telegram, one cron/direct — and one subagent turn. In Tempo, confirm:
- the two main turns' `llm_call` spans carry **distinct** `prov.session.id`
- neither is `nix-main`
- neither is `unattributed:nix` (that would mean the forced context is missing, not that the header is gone)
- the subagent turn resolves to its own id with `prov.agent.type=subagent`

These are the issue's three acceptance criteria.

- [ ] **Step 6: Roll back if the acceptance test fails**

```bash
cp "$(ls -t ~/.openclaw/openclaw.json.pre-264-* | head -1)" ~/.openclaw/openclaw.json
systemctl --user restart openclaw-gateway.service
```

Then report which criterion failed and what the spans showed.

---

### Task 6: Correct the stale fork docs and close out the issue

**Files:**
- Modify: `.claude/CLAUDE.md` (openclaw fork) — the "Companion plugin: `agentweave-bridge`" section

**Interfaces:**
- Consumes: the verified outcome of Task 5.
- Produces: nothing.

- [ ] **Step 1: Fix the bridge build instructions**

In `.claude/CLAUDE.md`, the companion-plugin section currently says the plugin builds with `npm run build` and tells the reader to check `dist/src/service.js`. Both are wrong. Replace that guidance with:

- source of truth is `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/` (git-tracked)
- build with `npm run build:bundle` + `npm run verify:bundle`
- deploy by copying `bundle/index.js` to `~/.openclaw/user-plugins/agentweave-bridge/index.js`, which is what `openclaw.plugin.json` loads
- the `src/` and `dist/` directories inside the deploy dir are stale leftovers and are not built from
- the verification grep becomes `grep -c 'model.call.completed' ~/.openclaw/user-plugins/agentweave-bridge/index.js`

- [ ] **Step 2: Record the #264 outcome in the same file**

Add a short note under the fork-divergence section: the `x-agentweave-session-key` carry (`d5ec8b84066`) is load-bearing for AgentWeave attribution, the static provider headers were removed on the Task 5 date, and dropping the carry on a future rebase silently regresses every proxied span to `unattributed:nix`.

- [ ] **Step 3: Commit and push**

```bash
cd /home/Arnab/clawd/projects/openclaw
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
scripts/committer "docs(fork): correct the bridge build path and record the #264 outcome" .claude/CLAUDE.md
git push origin upgrade/v2026.7.1
```

- [ ] **Step 4: Draft the issue comment for user review**

Do **not** post without showing the user first. The comment should state: the header mechanism proposed as option 1 was already implemented in the fork (cite `stream-resolution.ts:25-36` and the proxy's `proxy.py:1132-1137` preference order); the real cause was `service.ts:673` sending `force:false` for main turns, which made the proxy delete the context; list the four changes; and give the acceptance-criteria evidence from Task 5 Step 5.

- [ ] **Step 5: Post and close after approval**

Post the approved comment with `gh issue comment` using a heredoc body file (the comment contains backticks), then close the issue. Search for related open issues (#245, #254, #255) and note in chat whether any are now resolvable — do not close those without asking.

---

## Self-Review

**Spec coverage:** all four design changes map to tasks — change 1 → Task 2, change 2 → Task 3, change 3 → Task 1, change 4 → Task 5. Spec's build/deploy correction → Task 6; testing section → Tasks 1-3; live verification and rollout gate → Tasks 4 and 5; rollback → Task 5 Step 6. Out-of-scope items (minimax, `proxy.py`, concurrent-turn heuristic) are restated in Global Constraints.

**Placeholder scan:** no TBDs; every code step carries real code; both branch-point uncertainties (Task 2 Step 2, Task 3 Step 2) give explicit diagnostic instructions rather than deferring.

**Type consistency:** `withAgentweaveSessionKeyHeader` and `agentweaveSessionKeyHeaderEnabled` are used with the same signatures in Task 1 Steps 3 and 4. `sessionPostBodies()` is defined in Task 2 Step 1 and reused in Task 3 Step 1 with the same return type. `wrapEmbeddedAgentStreamFn`'s `promptCacheKey?: string` optionality is verified against the current source.
