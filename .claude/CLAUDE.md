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
| Node | **24.19.0** via `~/.nvm/versions/node/v24.19.0/bin/` — `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH` before `pnpm`. The systemd unit pins the same interpreter in both `ExecStart` and its `Environment=PATH`. |
| pnpm | 11.2.2, resolved through `corepack` under Node 24.19.0 (matches the repo's `packageManager` pin). If `pnpm: command not found` after a Node upgrade, run `corepack enable` for the new version — nvm installs are per-version. |
| Build | `pnpm run build` (runs `node scripts/build-all.mjs`) |

**Node floor is enforced, not advisory.** v2026.7.1 declares `engines: >=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`, and `src/infra/node-sqlite.ts` refuses to open *any* SQLite state DB when the embedded SQLite is affected by the upstream WAL-reset corruption bug (needs 3.51.3+, or patched 3.50.7+/3.44.6+). A too-old Node does not degrade — the gateway will not start. Node 24.19.0 embeds SQLite 3.53.3.

Both previously-installed runtimes fail that check, so do not fall back to them: **v22.22.1** ships SQLite 3.51.2, and **v24.13.0** — which this unit ran until 2026-08-05 — ships 3.50.4. Earlier revisions of this file described the runtime as "22.x"; that was the build-shell PATH, while the service itself was on v24.13.0.

When changing Node, update `ExecStart` **and** `Environment=PATH` in `~/.config/systemd/user/openclaw-gateway.service`, then `systemctl --user daemon-reload`. The change takes effect on the next restart, not on reload. Backup from the last bump: `openclaw-gateway.service.bak-pre-node24.19-20260805-063829`.

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

### Patch: iOS assistant-bubble dedupe (OpenClawKit)

- **Upstream status**: never proposed. Fork-local client-side fix.
- **Local presence**: commit `7e363239b0e` ("fix(ios): collapse duplicate adjacent assistant text bubbles in chat transcript") on `upgrade/v2026.6.9`. Touches `apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel.swift` (+87/-1) and `apps/shared/OpenClawKit/Tests/OpenClawKitTests/ChatViewModelTests.swift` (+59).
- **Why it matters**: found while using the **official OpenClaw iOS app** against this fork's gateway. An assistant reply arrives on two delivery paths — a `sessionMessage` carrying the traced transcript (text plus the `tool_call` blocks that produced it), and a `chat` event with `state: "final"` carrying only the plain text. Both events are legitimate, so neither can be suppressed gateway-side; the app rendered **two visually identical assistant bubbles**.
- **Mechanism**: `dedupeAdjacentAssistantTextMessages` runs as a final pass in `ChatViewModel`. Adjacent assistant messages collapse when their whitespace-folded text-block content matches and timestamps are within **5 minutes** (the window stops a genuinely repeated reply later in the conversation from being swallowed; both-timestamps-absent is treated as the same message, since duplicate delivery is the only way that shape occurs). On collapse it keeps the variant **without** a tool trace — the clean `final` text — because the traced variant's tool blocks already have their own transcript rows.
- **⚠️ UNVERIFIED**: committed without ever being compiled or run. The NAS has no Swift toolchain (`swift`/`swiftc`/`xcodebuild` all absent), so `ChatViewModelTests` has never executed. **Run the OpenClawKit suite on macOS before trusting this.** Per root `AGENTS.md`, check real iOS devices before simulator.
- **Rebase risk**: `ChatViewModel.swift` is upstream-owned and actively changed. Expect conflicts on hops; the carry is `pin = true` in the fork-upgrade manifest so it is never auto-skipped.

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
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
pnpm run build
systemctl --user restart openclaw-gateway.service
```

Verify the dist actually has the export before restarting:
```bash
grep -c onModelDiagnosticEvent dist/plugin-sdk/diagnostic-runtime.js   # expect 2
```

## Companion plugin: `agentweave-bridge`

**Source of truth is the agentweave repo, not the deployed directory.** The bridge is developed at `/home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge/` and deployed as a **prebuilt esbuild bundle** copied to `~/.openclaw/user-plugins/agentweave-bridge/index.js`. That deployed `package.json` declares `"openclaw": { "extensions": ["./index.js"] }` — the top-level `index.js` (~2.5 MB) is the only artifact OpenClaw loads.

Do **not** edit or build in the deployed directory. Its `src/`, `index.ts`, and `dist/` are stale leftovers: `dist/index.js` is a 342-byte stub and `dist/src/` has not been regenerated since 2026-05-07. An earlier revision of this file told you to run `npm run build` there and grep `dist/src/service.js` — both are wrong and will silently check a file the gateway never loads.

Verify the *live* artifact instead:

```bash
grep -c 'case "model.call.completed"' ~/.openclaw/user-plugins/agentweave-bridge/index.js
```

To rebuild and deploy after editing the source:
```bash
export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH
cd /home/Arnab/dev/agentweave/plugins/openclaw-agentweave-bridge
npm run build:bundle            # esbuild → bundle/index.js
npm run verify:bundle
cp ~/.openclaw/user-plugins/agentweave-bridge/index.js \
   ~/.openclaw/user-plugins/agentweave-bridge/index.js.bak-$(date +%Y%m%d-%H%M%S)
cp bundle/index.js ~/.openclaw/user-plugins/agentweave-bridge/index.js
```

The bundle is only picked up on gateway restart — which interrupts live sessions, so ask first.

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
