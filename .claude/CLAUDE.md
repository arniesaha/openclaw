# Fork-specific operational notes (Arnab's NAS deploy)

These are notes specific to *this* checkout — Arnab's openclaw fork running as the live `openclaw-gateway.service` user-level systemd unit on the NAS. They override nothing in the upstream `CLAUDE.md` / `AGENTS.md` at repo root; they document deploy realities a session needs to know before touching `dist/` or restarting services.

## Live deploy

| Item | Value |
|------|-------|
| Checkout | `/home/Arnab/clawd/projects/openclaw/` (this dir) |
| Runtime entry | `dist/index.js gateway --port 18789` |
| systemd unit | `openclaw-gateway.service` (user-level) |
| Restart cmd | `systemctl --user restart openclaw-gateway.service` |
| Logs | `journalctl --user -u openclaw-gateway.service -n 100 --no-pager` |
| Node | 22.x via `~/.nvm/versions/node/v22.22.1/bin/` — `export PATH=~/.nvm/versions/node/v22.22.1/bin:$PATH` before `pnpm` |
| Build | `pnpm run build` (runs `node scripts/build-all.mjs`) |

Restarting the gateway interrupts any active Nix session and any Telegram bot loop. Don't restart casually — ask first unless the user explicitly told you to.

### Current state (2026-06-21): upgraded to v2026.6.9

- Deploy now tracks branch **`upgrade/v2026.6.9`** (fork carries rebased onto upstream `v2026.6.9`; the old `feat/agentweave-238-clientContext` is the pre-upgrade base). App version `2026.6.9`.
- **v2026.6.9 renamed the codex provider:** `models.providers.openai-codex` → `models.providers.openai`, `api` value `openai-codex-responses` → `openai-chatgpt-responses`, agent model refs `openai-codex/* → openai/*`. The old config fails v2026.6.9's stricter validation (gateway crash-loops on "Invalid config"); `openclaw doctor --fix` migrates it (needed **two passes**). Pre-upgrade config backup: `~/.openclaw/openclaw.json.pre-v6.9-20260621-122305`.
- A third bridge subscription line now appears on healthy startup — `subscribed to trusted lifecycle clientContext via plugin-sdk` — from the `onTrustedDiagnosticEvent` / `clientContext`-on-privateData carry (the agentweave#238 pivot). Upstream v2026.6.9 ships the trusted `privateData` channel natively (`modelContent`/`toolContent`) but without `clientContext`; the fork extends it.

## Long-lived local divergence from upstream

This fork carries patches that are not yet on `upstream/main`. **If you rebase against upstream or build dist and the gateway behavior regresses, check whether one of these got dropped.**

### Patch: `onModelDiagnosticEvent` (plugin-sdk)

- **Upstream status**: open PR <https://github.com/openclaw/openclaw/pull/80497> ("feat(plugin-sdk): onModelDiagnosticEvent for trusted model.* events"), author arniesaha, not merged.
- **Local presence**: cherry-picked onto whatever working branch is current. Commits:
  - `feat(plugin-sdk): onModelDiagnosticEvent for trusted model.* events` (originally `2afde5d20f`)
  - `docs(plugin-sdk): document onModelDiagnosticEvent integrity model` (originally `7b6e32f6cb`)
- Also lives on the branch `feat/model-call-completed-usage` in this checkout.
- **Why it matters**: the `agentweave-bridge` plugin in `~/.openclaw/user-plugins/agentweave-bridge/` subscribes to `onModelDiagnosticEvent` to enrich codex turn spans with `prov.llm.{provider,model}`. Without this export, codex turns (Nix on `openai/gpt-5.5`, formerly `openai-codex/gpt-5.5` pre-v2026.6.9) land in AgentWeave/Tempo bucketed as **"unknown"**. The bridge logs a startup warning when the export is missing — see verification below.

### Sanity check on every restart

After `pnpm run build` + restart, confirm BOTH lines appear in the gateway log:

```bash
journalctl --user -u openclaw-gateway.service --since "1 minute ago" --no-pager | grep agentweave-bridge
```

Expected:
```
[agentweave-bridge] subscribed to diagnostic events via plugin-sdk
[agentweave-bridge] subscribed to model.* trusted events via plugin-sdk   ← this one is the load-bearing line
```

If you see instead:
```
[agentweave-bridge] openclaw plugin-sdk is missing onModelDiagnosticEvent — codex turn spans will not be enriched with prov.llm.model. Upgrade openclaw to a build that exports it.
```

…then the `onModelDiagnosticEvent` patch is missing from the current build. To restore:

```bash
# Confirm the commits are on this branch
git log --oneline | grep -i onModelDiagnosticEvent

# If absent, cherry-pick from the feat branch
git cherry-pick feat/model-call-completed-usage~1 feat/model-call-completed-usage

# Rebuild + restart
export PATH=~/.nvm/versions/node/v22.22.1/bin:$PATH
pnpm run build
systemctl --user restart openclaw-gateway.service
```

Verify the dist actually has the export before restarting:
```bash
grep -c onModelDiagnosticEvent dist/plugin-sdk/diagnostic-runtime.js   # expect 2
```

## Companion plugin: `agentweave-bridge`

Lives outside this repo at `~/.openclaw/user-plugins/agentweave-bridge/`. It has its own build (`npm run build` — pure tsc, no pnpm). The plugin's `dist/src/service.js` must contain a `case "model.call.completed"` handler:

```bash
grep 'case "model.call.completed"' ~/.openclaw/user-plugins/agentweave-bridge/dist/src/service.js
```

If absent, the plugin source was edited but never recompiled:
```bash
cd ~/.openclaw/user-plugins/agentweave-bridge
export PATH=~/.nvm/versions/node/v22.22.1/bin:$PATH
npm run build
```

### `muxUrl` field (removed 2026-05-31)

The bridge config previously had a `muxUrl` field (alongside `proxyUrl`) that injected `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`/`OPENAI_API_BASE` at turn start to route LLM calls through Mux. It was **removed on 2026-05-31** (backup `~/.openclaw/openclaw.json.pre-muxremove.20260531-123532`) and is **not** in the current config.

Current bridge config lives at `plugins.entries.agentweave-bridge.config` in `~/.openclaw/openclaw.json`:
```json
{
  "otlpEndpoint": "http://10.43.221.47:4318",
  "agentId": "nix-v1",
  "project": "nix",
  "proxyUrl": "http://192.168.1.70:30400/v1",
  "enabled": true
}
```

Both the `/session` POST and LLM `baseUrl` point at the AgentWeave proxy directly. (Codex CLI in OAuth mode ignores `OPENAI_BASE_URL` regardless.) See arniesaha/mux#67 for the wider context.

## Topology context (for cross-repo work)

- Mux router: `/home/Arnab/dev/mux` (development), `/home/Arnab/clawd/projects/mux` (live, port 8787). See its own CLAUDE.md.
- AgentWeave proxy: Kubernetes deployment `agentweave-proxy` in namespace `agentweave`, NodePort 30400, internal port 4000. Tempo OTLP at NodePort 30418.
- Current OpenClaw config (`~/.openclaw/openclaw.json`) sends **anthropic** and **openai** (the codex provider, renamed from `openai-codex` in v2026.6.9) directly to the AgentWeave proxy (30400), bypassing Mux. Only **minimax** routes through Mux (`localhost:8787/v1`). This is documented as a known gap in mux issue #67 — do not "fix" it by repointing without coordinating with the mux repo.

## Pnpm packageManager

`package.json` pins `pnpm@11.1.0`. Use that or you'll get warnings.
