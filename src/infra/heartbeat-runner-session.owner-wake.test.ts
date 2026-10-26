// Tests that subagent heartbeat routing opens only for a granted, live, same-agent owner.
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  grantLiveSubagentOwnerWake,
  resetLiveSubagentOwnerWakeGrantsForTest,
  revokeLiveSubagentOwnerWake,
} from "./heartbeat-owner-wake-grants.js";
import { resolveHeartbeatSessionKey } from "./heartbeat-runner-session.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

const OWNER = "agent:coder:subagent:owner-1";
const seed = { lastChannel: "telegram", lastProvider: "telegram", lastTo: "1" };

afterEach(() => {
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

  it.each([
    { name: "endedAt set", entry: { endedAt: 1 } },
    { name: "terminal status", entry: { status: "done" as const } },
  ])("falls back to main for an ended session ($name)", async ({ entry }) => {
    await withTempHeartbeatSandbox(async ({ storePath }) => {
      await seedSessionStore(storePath, OWNER, { ...seed, ...entry });
      grantLiveSubagentOwnerWake({ pluginId: "p", sessionKey: OWNER });
      const resolved = resolveHeartbeatSessionKey(cfgFor(storePath), "coder", undefined, OWNER);
      expect(resolved.sessionKey).toBe(mainKey);
    });
  });

  it("falls back to main for another agent's subagent", async () => {
    await withTempHeartbeatSandbox(async ({ storePath }) => {
      const foreign = "agent:other:subagent:x";
      await seedSessionStore(storePath, foreign, seed);
      grantLiveSubagentOwnerWake({ pluginId: "p", sessionKey: foreign });
      const resolved = resolveHeartbeatSessionKey(cfgFor(storePath), "coder", undefined, foreign);
      expect(resolved.sessionKey).toBe(mainKey);
    });
  });

  it("falls back to main after the grant is revoked or expires", async () => {
    await withTempHeartbeatSandbox(async ({ storePath }) => {
      await seedSessionStore(storePath, OWNER, seed);
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
