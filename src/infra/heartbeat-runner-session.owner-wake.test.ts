// Tests that subagent heartbeat routing opens only for a granted, live, same-agent owner.
import { afterEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ active: new Set<string>() }));
vi.mock("../agents/subagents/registry/subagent-registry-read.js", () => ({
  isSubagentSessionRunActive: (key: string) => registry.active.has(key),
}));

import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  grantLiveSubagentOwnerWake,
  resetLiveSubagentOwnerWakeGrantsForTest,
  revokeLiveSubagentOwnerWake,
} from "./heartbeat-owner-wake-grants.js";
import { resolveHeartbeatSessionKey } from "./heartbeat-runner-session.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

const OWNER = "agent:coder:subagent:owner-1";
const seed = { lastChannel: "telegram", lastProvider: "telegram", lastTo: "1" };

afterEach(() => {
  registry.active.clear();
  resetLiveSubagentOwnerWakeGrantsForTest();
});

describe("resolveHeartbeatSessionKey subagent owner wake", () => {
  const cfgFor = (storePath: string): OpenClawConfig => ({ session: { store: storePath } });
  const mainKey = "agent:coder:main";

  it("keeps routing ordinary forced subagent keys to main", async () => {
    await withTempHeartbeatSandbox(async ({ storePath }) => {
      await seedSessionStore(storePath, OWNER, seed);
      const resolved = resolveHeartbeatSessionKey(cfgFor(storePath), "coder", undefined, OWNER);
      expect(resolved.sessionKey).toBe(mainKey);
    });
  });

  it("routes a granted live subagent owner", async () => {
    await withTempHeartbeatSandbox(async ({ storePath }) => {
      await seedSessionStore(storePath, OWNER, seed);
      registry.active.add(OWNER);
      grantLiveSubagentOwnerWake({ pluginId: "p", sessionKey: OWNER });
      const resolved = resolveHeartbeatSessionKey(cfgFor(storePath), "coder", undefined, OWNER);
      expect(resolved.sessionKey).toBe(OWNER);
      expect(resolved.suppressOriginatingContext).toBe(true);
    });
  });

  it("falls back to main when the granted session was never created", async () => {
    await withTempHeartbeatSandbox(async ({ storePath }) => {
      grantLiveSubagentOwnerWake({ pluginId: "p", sessionKey: OWNER });
      const resolved = resolveHeartbeatSessionKey(cfgFor(storePath), "coder", undefined, OWNER);
      expect(resolved.sessionKey).toBe(mainKey);
    });
  });

  it("falls back to main when the registry no longer has a live run", async () => {
    await withTempHeartbeatSandbox(async ({ storePath }) => {
      await seedSessionStore(storePath, OWNER, { ...seed, endedAt: 1, status: "done" });
      grantLiveSubagentOwnerWake({ pluginId: "p", sessionKey: OWNER });
      const resolved = resolveHeartbeatSessionKey(cfgFor(storePath), "coder", undefined, OWNER);
      expect(resolved.sessionKey).toBe(mainKey);
    });
  });

  it("falls back to main for another agent's subagent", async () => {
    await withTempHeartbeatSandbox(async ({ storePath }) => {
      const foreign = "agent:other:subagent:x";
      await seedSessionStore(storePath, foreign, seed);
      registry.active.add(foreign);
      grantLiveSubagentOwnerWake({ pluginId: "p", sessionKey: foreign });
      const resolved = resolveHeartbeatSessionKey(cfgFor(storePath), "coder", undefined, foreign);
      expect(resolved.sessionKey).toBe(mainKey);
    });
  });

  it("falls back to main after the grant is revoked or expires", async () => {
    await withTempHeartbeatSandbox(async ({ storePath }) => {
      await seedSessionStore(storePath, OWNER, seed);
      registry.active.add(OWNER);
      grantLiveSubagentOwnerWake({ pluginId: "p", sessionKey: OWNER, now: 0 });
      expect(
        resolveHeartbeatSessionKey(cfgFor(storePath), "coder", undefined, OWNER).sessionKey,
      ).toBe(mainKey);
      grantLiveSubagentOwnerWake({ pluginId: "p", sessionKey: OWNER });
      revokeLiveSubagentOwnerWake(OWNER);
      expect(
        resolveHeartbeatSessionKey(cfgFor(storePath), "coder", undefined, OWNER).sessionKey,
      ).toBe(mainKey);
    });
  });
});

describe("runHeartbeatOnce subagent owner wake", () => {
  it("skips an owner wake retry whose grant expired instead of rerouting to main", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
        session: { store: storePath },
      };
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "coder",
        sessionKey: OWNER,
        source: "hook",
        intent: "immediate",
        reason: "hook:plugin-owner-wake:p",
      });
      expect(result).toMatchObject({ status: "skipped", reason: "owner-wake-expired" });
    });
  });
});
