# OpenClaw fork migration: 2026.4.29 → 2026.5.2

Drafted 2026-05-02. Rollback tag `pre-migration/agentweave-v2026.4.29` created and pushed to `origin`. Config snapshot at `~/.openclaw/openclaw.json.pre-2026.5.2`.

## Context

- Repo: `/home/Arnab/clawd/projects/openclaw` (`origin = arniesaha/openclaw`, `upstream = openclaw/openclaw`).
- Current branch: `agentweave/v2026.4.29`, 2 commits ahead of upstream `v2026.4.29`.
- Target tag: `v2026.5.2` (1543 upstream commits since `v2026.4.29`, ~6 days).
- Running NAS install: built `dist/` from `agentweave/v2026.4.29`, served by `openclaw-gateway.service` (systemd, pid 2850 at snapshot time).
- Codex routing on this fork is currently working end-to-end via:
  - `~/.openclaw/agents/main/agent/models.json` explicit `gpt-5.4` row (`chmod 444`)
  - agentweave proxy PR https://github.com/arniesaha/agentweave/pull/183 (image `localhost:5000/agentweave-proxy:fix-codex-jwt-route`)
  - upstream PR https://github.com/openclaw/openclaw/pull/76428 (durable fix for the synthesis baseUrl bug — once landed and pulled in, the chmod 444 workaround can be removed)

## The 2 commits to migrate

| SHA          | Subject                                                | Upstream churn since fork                                                                               | Risk                                               |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `7805ed3271` | fix usage.cost consistency across configured agents    | session-cost-usage.ts: 3 commits, session-cost-usage.test.ts: 1 commit, diagnostic-events.ts: 2 commits | low–medium                                         |
| `0378046f9e` | diagnostics: include taskLabel in message.queued event | dispatch-from-config.ts: 5 commits, runs.ts: 1 commit, diagnostic.ts: 5 commits                         | medium (dispatch-from-config has the most surface) |

This is dramatically less churn than the prior 4.26→4.29 migration (68 upstream commits on dispatch-from-config alone), so a clean cherry-pick is plausible.

## Files touched by the fork

- src/agents/pi-embedded-runner/runs.ts
- src/auto-reply/reply/dispatch-from-config.ts
- src/infra/diagnostic-events.ts
- src/infra/session-cost-usage.test.ts
- src/infra/session-cost-usage.ts
- src/logging/diagnostic.ts

## Migration steps

### Step 0 — Anchor rollback (DONE)

```
git tag pre-migration/agentweave-v2026.4.29 agentweave/v2026.4.29
git push origin pre-migration/agentweave-v2026.4.29
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.pre-2026.5.2
```

### Step 1 — Create new fork branch from v2026.5.2

```
git fetch upstream --tags
git checkout -b agentweave/v2026.5.2 v2026.5.2
```

### Step 2 — Cherry-pick the 2 fork commits in order

```
git cherry-pick 7805ed3271   # usage.cost consistency
git cherry-pick 0378046f9e   # taskLabel in message.queued
```

If conflicts arise, prefer keeping the fork intent (taskLabel diagnostics, usage.cost normalization across configured agents). Resolve, `git add`, `git cherry-pick --continue`.

### Step 3 — Apply the codex synthesis baseUrl fix early

PR https://github.com/openclaw/openclaw/pull/76428 may not yet be in `v2026.5.2`. If absent, cherry-pick our local `13085b0bdf` from `fix/codex-synthesis-honor-provider-baseurl` so the NAS does not need the `chmod 444` workaround on the new branch.

```
git cherry-pick 13085b0bdf
```

### Step 4 — Gates

```
pnpm install                      # if lockfile drift
pnpm tsgo:extensions
pnpm tsgo:all                     # may run on Testbox if heavy
pnpm test extensions/openai/openai-codex-provider.test.ts
pnpm test src/infra/session-cost-usage.test.ts
pnpm test src/auto-reply
pnpm check:changed                # full smart gate
pnpm build                        # required because dist/ is what NAS runs
```

`pnpm check` is the broad sweep; per repo policy, run on Testbox.

### Step 5 — Cutover (REQUIRES EXPLICIT APPROVAL — DO NOT AUTOMATE)

```
sudo systemctl stop openclaw-gateway
git checkout agentweave/v2026.5.2
pnpm install
pnpm build
sudo systemctl start openclaw-gateway
openclaw status
```

Verify after cutover:

- `openclaw status` shows `app 2026.5.2` and `Gateway service: running`.
- New Telegram message produces a `gpt-5.4` reply and `POST /codex/responses 200 OK` at the agentweave proxy.
- `~/.openclaw/agents/main/agent/models.json` still has the `gpt-5.4` row (chmod 444 may need to stay until PR #76428 is in this branch).

### Step 6 — Push fork branch to origin

```
git push origin agentweave/v2026.5.2
```

## Rollback plan

```
sudo systemctl stop openclaw-gateway
git checkout agentweave/v2026.4.29   # or pre-migration/agentweave-v2026.4.29 tag
pnpm install
pnpm build
sudo systemctl start openclaw-gateway
```

Config snapshot restore (only if needed):

```
cp ~/.openclaw/openclaw.json.pre-2026.5.2 ~/.openclaw/openclaw.json
```

## Open questions

- Whether agentweave-bridge plugin still imports only `openclaw/plugin-sdk/diagnostics-otel` on `v2026.5.2`. Verify no SDK subpath was renamed/removed in the 1543-commit window before cutover.
- Whether the `chmod 444` workaround on `models.json` can be dropped: depends on whether v2026.5.2 already includes the synthesis baseUrl fix (PR #76428) or whether we cherry-pick it ourselves in Step 3.
