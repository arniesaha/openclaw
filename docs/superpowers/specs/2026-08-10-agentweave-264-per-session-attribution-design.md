# agentweave#264: per-session attribution for OpenClaw's proxied model calls

Drafted 2026-08-10. Issue: <https://github.com/arniesaha/agentweave/issues/264>.

## Summary

Issue #264 reports that every OpenClaw model call traversing the AgentWeave proxy is
attributed to one session, `nix-main`, and proposes making OpenClaw's provider headers
dynamic per session as the clean fix.

That fix already exists. This fork stamps a per-run `x-agentweave-session-key` header on
outbound LLM calls, the proxy prefers it over the static header, and the bridge registers
the matching key. The actual defect is one line in the bridge: main-agent turns ask the
proxy *not* to force their context, so the proxy falls through to the static header.

This design closes the fallback at its source, then removes the static header.

## Current state (verified 2026-08-10)

The header chain is implemented and live:

1. `src/agents/embedded-agent-runner/stream-resolution.ts:25-36` — `withAgentweaveSessionKeyHeader()`
   adds `x-agentweave-session-key: <run sessionKey>` to `StreamOptions.headers`, gated on
   `OPENCLAW_AGENTWEAVE_SESSION_KEY_HEADER=1`. Applied at `:285` in `wrapEmbeddedAgentStreamFn`.
   Fork carry `3a1e2c8bb05`, rebased forward as `70f1af8f99c` and `d5ec8b84066`.
2. The header reaches the wire on both proxied providers. Anthropic: `options.headers`
   preserved at `src/agents/anthropic-transport-stream.ts:1156`, merged last into
   `defaultHeaders` at `:910`/`:935`/`:962`/`:984`, into the fetch init at `:822-830`.
   Codex responses: `src/agents/openai-transport-stream.ts:2036-2043` →
   `buildOpenAIClientHeaders` with `precedence: "caller-wins"`. The only caller-header
   filter (`src/agents/provider-request-config.ts:731-746`) is a denylist derived from
   attribution keys; for a custom proxy baseUrl `attributionHeaders` is `undefined`, so
   nothing is filtered.
3. `OPENCLAW_AGENTWEAVE_SESSION_KEY_HEADER=1` is set in the running gateway process, via
   `~/.openclaw/gateway.systemd.env`.
4. The proxy prefers the keyed context: `proxy.py:1101-1111` resolves
   `_forced_session_contexts[x-agentweave-session-key]`, and `session_id` at `:1132-1137`
   reads `_active_ctx["prov.session.id"]` first, falling through to `x-agentweave-session-id`
   only on no match.
5. The bridge registers the key: `service.ts` POSTs `/session` with `session_key` +
   `force: true` on subagent turns.

Acceptance criteria 1 and 3 are therefore already met for any turn that registers a context.

## Root cause

`plugins/openclaw-agentweave-bridge/src/service.ts:673` (agentweave repo):

```js
force: Boolean(upstream) || effectiveAgentType === "subagent",
```

A plain main-agent turn — Telegram, cron — has no `agentweave.context.v1` upstream bag and
type `main`, so `force` is `false`. Per `proxy.py:530-534`, `force:false` with a
`session_key` **pops** the entry. The main turn deletes its own forced context, the proxy
falls through to `x-agentweave-session-id`, and that header is hardcoded `nix-main`.

Live corroboration: over a 7-day window the only turns that got `force:true` were
`agent:main:main` runs that the concurrent-turn heuristic (`service.ts:68-72`) reclassified
as *subagent* because a Telegram key was already active — logged as
`concurrent-turn: agent:main:main while agent:main:telegram:default:dir... → subagent`.
Genuine solo main turns register nothing.

Secondary contributors to the same fallback:

- The bridge clears the forced context on subagent idle (`service.ts:~810-832`, `force:false`),
  a vestige of the pre-#149 global-flag era. Under per-key contexts the subagent key is
  distinct from main's, so the clear protects nothing and opens a window where late
  subagent calls fall back.
- `src/agents/embedded-agent-runner/stream-resolution.ts:233-241` wraps for `promptCacheKey`
  but passes no `sessionKey`, and `:236` returns the stream fn raw when there is no prompt
  cache key. Reachable when `resolvedApiKey` is empty and the model is not the
  proxied-non-`anthropic` case at `:207`, so provider `anthropic` can lose the stamp.

## Design

Four changes across three repos, in dependency order. The config change lands last because
it removes the safety net.

### 1. Bridge — force main turns (agentweave repo)

`plugins/openclaw-agentweave-bridge/src/service.ts:673` becomes unconditional `force: true`.
This is the load-bearing fix; alone it satisfies criteria 1 and 3 for main sessions. The
per-key map from #149 already isolates concurrent keys, so forcing main is not the
global-flag hazard the original condition guarded against.

### 2. Bridge — delete the subagent idle-clear (agentweave repo)

Remove the `force:false` POST at `service.ts:~810-832`, keeping the span bookkeeping
(`span.end()`, `activeTurns.delete`). Entry growth is bounded by the proxy's LRU
(`proxy.py:462`, 256 entries), whose comment already covers orphaned entries.

### 3. OpenClaw fork — close the sessionKey drop

`src/agents/embedded-agent-runner/stream-resolution.ts:233-241`: pass `sessionKey` through
the prompt-cache tail wrap, and wrap rather than return raw at `:236` when a `sessionKey`
is present, so the stamp cannot be silently lost.

### 4. Config — remove the static attribution headers

In `~/.openclaw/openclaw.json`, drop `X-AgentWeave-Session-Id`, `X-AgentWeave-Agent-Id`,
and `X-AgentWeave-Agent-Type` from `models.providers.anthropic.headers` and
`models.providers.openai.headers`. Keep `X-AgentWeave-Project` — the proxy uses it for the
self-identifying `unattributed:{project}` bucket at `proxy.py:1149-1151`.

### Out of scope

- `models.providers.minimax` carries the same static block but routes through Mux
  (`localhost:8787`), not the AgentWeave proxy. Repointing is coordinated in mux#67.
- No `proxy.py` change is needed; `force:true` from the bridge is sufficient.
- The concurrent-turn heuristic at `service.ts:68-72` is untouched. It will keep making
  overlapping main turns appear as subagents in traces; that is not a failure of this change.

## Build and deploy

Bridge source of truth is `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/`
(git-tracked, clean). Build with `npm run build:bundle` and `npm run verify:bundle`, then
copy `bundle/index.js` over `~/.openclaw/user-plugins/agentweave-bridge/index.js`, which is
what `openclaw.plugin.json` loads.

The `src/` directory inside the deploy dir is stale vestigial (Jun 8) and is not built from.
The project `.claude/CLAUDE.md` is wrong on this point — it says `npm run build` and checks
`dist/src/service.js`; that guidance is corrected as part of this work.

OpenClaw change 3 lands on `upgrade/v2026.7.1`, then `pnpm run build` and a gateway restart.

## Testing

- Bridge (`vitest`, `src/service.test.ts`): a main turn with no upstream bag POSTs
  `force: true`; subagent idle no longer POSTs to `/session`.
- OpenClaw (`stream-resolution.test.ts`): tail-branch `sessionKey` passthrough, plus the
  currently missing end-to-end assertion that `x-agentweave-session-key` lands on the actual
  fetch init — following the pattern at `src/agents/anthropic-transport-stream.test.ts:579-618`.
  Per root `AGENTS.md`, OpenClaw tests run on the remote box.

## Live verification

Against the issue's acceptance criteria: run two turns in genuinely different sessions —
one Telegram, one cron/direct, deliberately **not** concurrent so the concurrent-turn
heuristic cannot mask the result — then confirm in Tempo that the two `llm_call` spans carry
distinct `prov.session.id`, that neither is `nix-main`, and that a subagent turn still
resolves to its own id with `prov.agent.type=subagent`.

`GET /session` plus proxy-side inspection of `_forced_session_contexts` gives a faster
intermediate check immediately after change 1.

## Rollout gate

Changes 1-3 ship and are verified **with the static header still in place**. At that stage a
regression is invisible in span data, but forced-context registration is directly observable.
Only once main turns are confirmed registering does change 4 remove the header.

If change 1 silently failed and the header were already gone, every main-turn span would
collapse into `unattributed:nix` — trading one wrong label for another.

## Rollback

- Config: back up `~/.openclaw/openclaw.json` to `~/.openclaw/openclaw.json.pre-264-<date>`.
- Bridge: add an `index.js.bak-<date>` alongside the existing backups in the deploy dir.
- OpenClaw: a few lines on `upgrade/v2026.7.1`.

## Risks

- Two gateway restarts are required (bridge bundle, fork build). Per the fork's
  `.claude/CLAUDE.md` this interrupts any active Nix session and the Telegram loop, so each
  restart is confirmed with the user rather than assumed.
- Low live traffic (2 turns in 7 days) means the live verification sample is small;
  the deliberate two-session test above compensates.
