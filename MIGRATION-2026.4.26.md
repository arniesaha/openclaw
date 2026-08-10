# OpenClaw fork migration: 2026.3.13 → 2026.4.26

Drafted 2026-04-26. Read-only prep completed 2026-04-26 ~15:40 local. Step 0 (tag) done. Cutover not yet executed.

## Prep status (2026-04-26)

- [x] Rollback tag `pre-migration/agentweave-v2026.3.13` created and pushed to `origin`.
- [x] Config snapshot at `~/.openclaw/openclaw.json.pre-2026.4.26` (10 KB).
- [x] Full state snapshot at `~/openclaw-state-pre-2026.4.26.tgz` (362 MB).
- [x] **agentweave-bridge plugin SDK audit (de-risked)**: `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/` only imports `openclaw/plugin-sdk/diagnostics-otel` (one subpath, still exported in upstream main). No `openclaw/extension-api` references. Plugin should require no porting. The single import is a `type`-only import in `index.ts`; runtime behavior comes from `@opentelemetry/*` deps, not OpenClaw runtime APIs.
- [x] **`ec42` redundancy check**: no upstream commit equivalent to "fix usage.cost consistency across configured agents". Patch is still needed; upstream has touched the file (compaction-checkpoint exclusion, tiered pricing, openrouter/auto fix) but none overlaps.
- [x] **Issues triage**: #62867, #70687, #40910, #65184 all CLOSED. Treat as regression watchpoints during post-upgrade verification, not blockers.
- [ ] Side-branch baseline build of `upstream/main` — deferred (multi-agent worktree policy).
- [ ] Codex app-server version check — only if Codex mode is in use.

## Context

- Repo: `/home/Arnab/clawd/projects/openclaw` (`origin = arniesaha/openclaw`, `upstream = openclaw/openclaw`).
- Current branch: `agentweave/v2026.3.13`, based on upstream `61d171ab0b` (2026-03-14).
- Upstream `main` head: `2026-04-26` (~6 weeks / ~17k commits ahead at audit time).
- Fork delta: **4 commits**, 8 files, +163/-38. No embedded agentweave/mux code — those are separate repos in `/home/Arnab/dev/agentweave/` and `/home/Arnab/dev/mux/` and consume OpenClaw over network boundaries.
- Working tree clean; no stashes.

## The 4 commits to migrate

| SHA          | Subject                                                             | Conflict risk                                                       | Notes                                                                                     |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `374a694c33` | fix(codex): respect custom baseUrl in normalizeOpenAICodexTransport | low (4 upstream commits on file)                                    | Supports AgentWeave proxy; cleanest pick.                                                 |
| `12ff3c0776` | models: register MiniMax M2.7 / M2.7-highspeed variants             | medium — file heavily refactored upstream                           | Likely needs manual replay onto new structure.                                            |
| `ec42d7bfb2` | fix usage.cost consistency across configured agents                 | medium                                                              | **Check first** if upstream already landed equivalent fix; if so, `--skip`.               |
| `7acf5aa99a` | diagnostics: include taskLabel in message.queued event              | high — `dispatch-from-config.ts` had 68 upstream commits since fork | Touches 4 files; expect manual conflict resolution. Required by AgentWeave bridge plugin. |

## Branches to drop (not migrate)

Per user 2026-04-26: previously upstream PRs that didn't merge; abandon.

- `feat/multi-image-batching`
- `feat/whatsapp-link-preview-policy`
- `feat/whatsapp-link-preview-policy-v2`

Cleanup (when ready):

```
git update-ref -d refs/heads/feat/multi-image-batching
git update-ref -d refs/heads/feat/whatsapp-link-preview-policy
git update-ref -d refs/heads/feat/whatsapp-link-preview-policy-v2
```

## Migration steps

### Step 0 — Anchor rollback

```
git tag pre-migration/agentweave-v2026.3.13 agentweave/v2026.3.13
git push origin pre-migration/agentweave-v2026.3.13
```

If the NAS runs a built `dist/`, also snapshot the binary state:

```
mkdir -p ~/openclaw-rollback-2026.3.13
cp -a dist package.json pnpm-lock.yaml ~/openclaw-rollback-2026.3.13/
```

Snapshot runtime data (per repo `CLAUDE.md`, sessions/credentials are at fixed paths):

```
cp -a ~/.openclaw/credentials ~/openclaw-rollback-2026.3.13/credentials
cp -a ~/.openclaw/sessions    ~/openclaw-rollback-2026.3.13/sessions
openclaw config list > ~/openclaw-rollback-2026.3.13/config.txt
```

Stop the running gateway cleanly before proceeding.

### Step 1 — Fresh branch off upstream/main

```
git fetch upstream
git checkout -b agentweave/v2026.4.26 upstream/main
```

The old branch (`agentweave/v2026.3.13`) stays untouched — that is the rollback target.

### Step 2 — Baseline smoke (no patches yet)

Confirm stock upstream is green in this env before adding fork patches:

```
pnpm install
pnpm build
pnpm tsgo
OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test
```

Boot the gateway and verify agentweave + mux from `/home/Arnab/dev/` can talk to unmodified `2026.4.26`. This isolates upstream regressions from fork-patch regressions.

### Step 3 — Cherry-pick smallest → largest conflict surface

```
git cherry-pick 374a694c33   # codex baseUrl (tiny)
git cherry-pick 12ff3c0776   # MiniMax models (replay onto refactored file)
git cherry-pick ec42d7bfb2   # usage.cost (check if upstream already has it; --skip if so)
git cherry-pick 7acf5aa99a   # taskLabel diagnostics (largest)
```

Before picking `ec42d7bfb2`, scan upstream for redundancy:

```
git log upstream/main -- src/infra/session-cost-usage.ts src/infra/session-cost-usage.test.ts
```

Before picking `7acf5aa99a`, expect manual merge in `src/auto-reply/reply/dispatch-from-config.ts`. Keep the patch minimal — only the `taskLabel` field on the queued event; let upstream's other refactors stand.

Rebuild + test after each pick (or at least at the end):

```
pnpm build && pnpm tsgo
OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test
```

### Step 4 — Integration smoke against agentweave + mux

From `/home/Arnab/dev/agentweave/` and `/home/Arnab/dev/mux/`, run their own smoke paths against the new gateway. Patches `374a694c33` (baseUrl) and `7acf5aa99a` (taskLabel) are precisely the surfaces those repos consume — these are the most likely break points.

If either external repo pins an OpenClaw version, bump it to `2026.4.26` and run their tests.

### Step 5 — Cut over

Only after step 4 passes:

```
git push origin agentweave/v2026.4.26
# update local main to match upstream
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
# rebuild/redeploy on NAS
```

Keep `pre-migration/agentweave-v2026.3.13` tag for at least a few weeks before pruning.

## Rollback

If anything regresses after cutover:

```
git checkout pre-migration/agentweave-v2026.3.13
# restore snapshotted dist/ if you swapped the binary
cp -a ~/openclaw-rollback-2026.3.13/dist .
# restart gateway
```

Original branch is untouched throughout because all work happened on a new branch.

## Open questions for next session

- Has more time passed? Re-run `git rev-list --count upstream/main..agentweave/v2026.3.13` — should still be `4`. If different, this plan is stale; redo the audit.
- Did upstream land an equivalent of `ec42d7bfb2`? Check `git log upstream/main -- src/infra/session-cost-usage.ts` before picking.

---

# Breaking-change audit (added 2026-04-26 second pass)

A pure cherry-pick is **not** sufficient. Upstream `2026.3.13 → 2026.4.26` includes several breaking changes that intersect this NAS deployment. Run `openclaw doctor --fix` after the cutover and verify each item below before declaring success.

## Snapshot of THIS NAS's at-risk config

Actually present in `~/.openclaw/openclaw.json` (10 KB) at audit time:

| Config                                                                                                                  | Value                                            | Risk                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents.defaults.model.primary`                                                                                         | `minimax/MiniMax-M2.7-highspeed`                 | **HIGH** — depends on fork commit `12ff3c0776`. If MiniMax registration replay fails, gateway won't start with this primary.                           |
| `plugins.entries.agentweave-bridge`                                                                                     | enabled, `proxyUrl=http://192.168.1.70:30400/v1` | **HIGH** — Plugin SDK overhaul (see "Plugin SDK" below). Bridge plugin must be re-verified against `openclaw/plugin-sdk/*`.                            |
| `gateway.bind: "lan"`, `gateway.auth.mode: "token"`, `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback: true` | LAN-exposed, token-auth                          | **MEDIUM** — see "Gateway auth tightening". The agentweave proxy at `192.168.1.70` must present the token; implicit same-host auth no longer suffices. |
| `channels.{whatsapp,telegram}.{dmPolicy,groupPolicy}: "allowlist"` + `allowFrom`                                        | Modern shape                                     | LOW — already on the canonical paths; doctor will validate.                                                                                            |
| `channels.telegram.groups."-5117715163".requireMention`                                                                 | Modern shape                                     | OK — legacy `groupMentionsOnly` already migrated in user config.                                                                                       |
| Legacy `~/.openclaw/clawdbot.json` (2.2 KB, plus 5 `.bak*`)                                                             | Stale state file                                 | LOW — `CLAWDBOT_*` / `.moltbot` env+state-dir compat was removed. Verify this file isn't being read on startup; if not, archive it.                    |

Not present in this config (so not at risk): `talk.voiceId`, `sandbox.perSession`, `allowPrivateNetwork`, `hooks.internal.handlers`, `tools.web.x_search`, `tools.web.fetch.firecrawl`, `qwen-portal-auth`, `secretref-env:` markers, `CLAWDBOT_*`/`MOLTBOT_*` env vars.

## Breaking changes that apply (chronological from changelog)

### From the 2026.3.24 release window

- **Plugin SDK**: `openclaw/extension-api` removed with no compat shim. Bundled and third-party plugins must use `openclaw/plugin-sdk/*` and `api.runtime.*`. **Action**: confirm `agentweave-bridge` plugin uses the new SDK before cutover. If it's a local plugin you maintain, port it on a side branch first.
- **Plugin SDK / Pi-only**: `api.registerEmbeddedExtensionFactory(...)` removed → must use `api.registerAgentToolResultMiddleware(...)` with `contracts.agentToolResultMiddleware`.
- **Browser/Chrome MCP**: legacy extension relay path removed; `driver: "extension"` and `browser.relayBindHost` gone. `openclaw doctor --fix` migrates host-local browser config.
- **Plugins/Matrix**: rewritten on `matrix-js-sdk`. Not enabled here, skip.
- **Plugins/message discovery**: `describeMessageTool(...)` is mandatory; `listActions`/`getCapabilities`/`getToolSchema` removed. Affects custom channel plugins.
- **Config/env**: `CLAWDBOT_*` and `MOLTBOT_*` env names removed. **Action**: `env | grep -E '^(CLAWDBOT|MOLTBOT)_'` returns nothing here — clear.
- **Config/state**: `.moltbot` state-dir and `moltbot.json` auto-detection removed. `~/.openclaw/clawdbot.json` is _inside_ the openclaw state dir so probably fine, but verify it isn't a load-time conflict.
- **Plugins/install**: bare `openclaw plugins install <pkg>` prefers ClawHub before npm. Affects future installs only.
- **Tools/image generation**: standardized on `image_generate`; `nano-banana-pro` skill wrapper removed.
- **Discord/commands**: switched to Carbon reconcile by default. (Discord not enabled here.)
- **Voice-call/webhooks**: tightened pre-auth body/concurrency. (Not enabled here.)
- **Exec/env sandbox**: blocks `MAVEN_OPTS`, `SBT_OPTS`, `GRADLE_OPTS`, `ANT_OPTS`, `GLIBC_TUNABLES`, `DOTNET_ADDITIONAL_DEPS`. Mostly transparent unless tools rely on those envs.

### From later 2026.4.x releases

- **Config aliases removed**: `talk.voiceId`/`talk.apiKey`, `agents.*.sandbox.perSession`, `browser.ssrfPolicy.allowPrivateNetwork`, `hooks.internal.handlers`, channel/group/room `allow` toggles → migrated by `openclaw doctor --fix`. Not present in this config.
- **Plugins/xAI**: config moved from `tools.web.x_search.*` to `plugins.entries.xai.config.xSearch.*`. Not present.
- **Plugins/web fetch (Firecrawl)**: moved from `tools.web.fetch.firecrawl.*` to `plugins.entries.firecrawl.config.webFetch.*`. Not present.
- **Providers/Qwen**: `qwen-portal-auth` OAuth removed. Not used here.
- **Config/Doctor**: drops automatic config migrations older than two months. Old legacy keys now fail validation. **Action**: after upgrade, run `openclaw doctor --fix` immediately and review the diff.
- **Skills/install + Plugins/install fail closed on `critical` dangerous-code findings.** May need `--dangerously-force-unsafe-install` to proceed for known-good plugins. **Relevant if reinstalling agentweave-bridge from scratch.**
- **Gateway/auth (security tightening)**:
  - `trusted-proxy` rejects mixed shared-token configs.
  - **Local-direct fallback now requires the configured token instead of implicitly authenticating same-host callers.** ← This is the one to verify. The agentweave proxy at `192.168.1.70:30400` calling into the gateway must include the token: confirm `agentweave-bridge` plugin config carries `gateway.auth.token` (or shared secret) explicitly.
- **Gateway/node commands**: stay disabled until node pairing approved (#57777). Device pairing alone no longer exposes node commands.
- **Gateway/node events**: reduced trusted surface. Node-triggered flows that relied on broader host/session tool access may need adjustment.
- **Gateway/Control UI**: requires authenticated read access for `/__openclaw/control-ui-config.json` when `gateway.auth` enabled (#70247). You have `gateway.auth.mode: "token"` set, so this is fine; the `dangerouslyAllowHostHeaderOriginFallback: true` flag still works but evaluate whether you still need it.
- **Gateway/Linux systemd**: there's a known fix to retry `systemctl --user enable` after a second daemon reload on migrated installs (#65184). **Action on NAS**: after upgrade, if `systemctl --user status openclaw-gateway` shows the unit missing, run `systemctl --user daemon-reload` twice, then `enable --now`.
- **TTS**: regular-mode runtime fallback removed for old bundled `tts.<provider>` API-key shapes; auto-migrated by doctor. Not used here.
- **Models/`/models add` deprecated**: chat-side `/models add` returns a deprecation message and the action is removed from `/models` provider menus. **Direct relevance to your fork commit `12ff3c0776`** — your patch registers MiniMax models statically in `models-config.providers.static.ts`, which is still the supported path; the deprecation is for the chat command, not static registration. So the patch survives, but `/models add minimax/...` no longer works as an interactive workaround if the patch fails to apply cleanly.
- **Agents/runtime**: `agentRuntime.id` is the new canonical config key; legacy runtime-policy configs migrated by `openclaw doctor --fix`. Not present in this config.
- **Codex harness**: requires Codex app-server `0.125.0+`. (Only if you use Codex mode.)
- **Subagents (multiple changes — directly relevant since you have customizations)**:
  - Parents should use `sessions_yield` while waiting for child completion to avoid GPT-5 fast runs ending silently after spawning workers.
  - Subagent tool profiles: a coding-profile agent that needs browser access should use `tools.alsoAllow: ["browser"]` rather than subagent allowlists alone.
  - `sessions_spawn(mode="session")` errors now surface usable alternatives when the channel can't bind subagent threads.
  - Subagent lifecycle/recovery hardening: stale unended runs no longer count as active forever.
  - Active Memory: silent recall sub-agent billing/auth failures are excluded from shared auth-profile cooldown state.

## Community/issue signals worth checking

- [#62867 — Upgrade to 2026.4.7 broke OpenClaw](https://github.com/openclaw/openclaw/issues/62867) — config-validation startup failure
- [#70687 — "Scope upgrade pending approval" after 2026.4.21](https://github.com/openclaw/openclaw/issues/70687) — affects `sessions_spawn` subagents + native approval
- [#40910 — missing migration for bind+tailscale validation causes crash loop](https://github.com/openclaw/openclaw/issues/40910) — relevant since `gateway.bind: "lan"` here
- [Releases page](https://github.com/openclaw/openclaw/releases) and [openclaw 2026.4.2 migration writeup](https://www.xugj520.cn/en/archives/openclaw-2026-migration-configuration-security-task-flow.html)

Before cutover, search closed/open issues for the `2026.4.26` window with terms `breaking`, `subagent`, `gateway`, `plugin SDK`, `migrate`.

## Permission audit

NAS-specific concerns to check:

1. **Service-level**:
   - If running under `systemctl --user`, after upgrade run `systemctl --user daemon-reload && systemctl --user enable --now openclaw-gateway` (the doubled reload guards the #65184 case).
   - If running under headed `nohup openclaw gateway run ...`, the existing pattern from `CLAUDE.md` still works; just `pkill -9 -f openclaw-gateway` and relaunch.
2. **Filesystem**:
   - `~/.openclaw/` is owned by your user — no perms work needed.
   - `~/.openclaw/credentials/`, `agents/`, `subagents/`, `cron/`, `delivery-queue/`, `nodes/`, `devices/` should remain `0700`/`0600`. Spot-check after upgrade: `find ~/.openclaw -maxdepth 2 -perm /o+r 2>/dev/null` should return nothing sensitive.
   - The 5 `openclaw.json.bak*` rotations and `clawdbot.json.bak*` are evidence of prior auto-migrations — good. New `doctor --fix` will create another `.bak`. Don't touch them.
3. **Network** (LAN bind):
   - `gateway.bind: "lan"` exposes `:18789` on the NAS LAN. Confirm only `192.168.1.70` (agentweave) and your mux/personal devices need access. Consider tightening to `loopback` + a reverse proxy if not.
   - `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback: true` is intentional but lives next to the tightened Control UI auth (#70247). If the original reason for that flag is gone, drop it.
4. **Tokens / secrets**:
   - `gateway.auth.token` is in plain `openclaw.json`. The `agentweave-bridge` plugin connecting from `192.168.1.70:30400` needs that token in its env/config — verify the bridge actually sends it post-upgrade.
   - `channels.telegram.botToken` in plain config. If you don't already, consider moving to a `secretref` (env or 1Password) — note: legacy `secretref-env:<ENV>` markers are now rejected; use the structured form.
5. **Permission profile / subagent allowlists**:
   - `tools.sessions.visibility = "all"` and the per-agent `agents.list` (8 entries) — review each entry's tool allowlist post-upgrade. Subagent guidance changed: `tools.alsoAllow` is preferred over allowlist-only profiles.

## Pre-upgrade checklist (added)

Before step 0 of the migration:

- [ ] Snapshot config: `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.pre-2026.4.26`
- [ ] Snapshot full state dir: `tar czf ~/openclaw-state-pre-2026.4.26.tgz -C ~ .openclaw`
- [ ] Note running version: `openclaw --version > ~/openclaw-rollback-2026.3.13/version.txt`
- [ ] Capture gateway probe: `openclaw gateway status --deep --require-rpc > ~/openclaw-rollback-2026.3.13/gateway-status.txt`
- [ ] Verify `agentweave-bridge` plugin source (`/home/Arnab/dev/agentweave/plugins/...`?) compiles against `openclaw/plugin-sdk/*` on a side checkout of `upstream/main`.
- [ ] Confirm Codex app-server version if Codex mode is in use.
- [ ] Check open issues filed in last 30 days for 2026.4.26: `gh search issues --repo openclaw/openclaw --match title,body --limit 50 -- "2026.4.26 OR 2026.4.25 breaking"`.

## Post-upgrade verification

After step 4 (integration smoke):

- [ ] `openclaw doctor --fix` (review the diff before accepting)
- [ ] `openclaw config validate` (per the community-reported #62867 pattern)
- [ ] `openclaw gateway status --deep --require-rpc`
- [ ] Spawn a subagent end-to-end (verify against #70687 "scope upgrade pending approval")
- [ ] Send a Telegram + WhatsApp message and confirm reply
- [ ] Trigger a full chain: agentweave → gateway → subagent → reply
- [ ] Tail `~/.openclaw/logs/` for `DEPRECATION` / `MIGRATION` / `ERROR` lines
- [ ] Confirm `agents.defaults.model.primary = minimax/...` resolves (this validates the MiniMax cherry-pick landed correctly)
