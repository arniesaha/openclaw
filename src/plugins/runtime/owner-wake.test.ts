// Tests that the owner-wake producer refuses missing, ended and non-subagent targets.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestHeartbeat: vi.fn(),
  loadSessionEntry: vi.fn(),
  isActive: vi.fn(),
}));
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", () => ({
  isSubagentSessionRunActive: mocks.isActive,
}));
vi.mock("../../infra/heartbeat-wake.js", () => ({ requestHeartbeat: mocks.requestHeartbeat }));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));

import {
  hasLiveSubagentOwnerWakeGrant,
  resetLiveSubagentOwnerWakeGrantsForTest,
} from "../../infra/heartbeat-owner-wake-grants.js";
import { requestLiveSubagentOwnerWakeForPlugin } from "./owner-wake.js";

const KEY = "agent:coder:subagent:a";

beforeEach(() => {
  mocks.requestHeartbeat.mockReset();
  mocks.loadSessionEntry.mockReset();
  mocks.isActive.mockReset();
  resetLiveSubagentOwnerWakeGrantsForTest();
});

describe("requestLiveSubagentOwnerWakeForPlugin", () => {
  it("refuses non-subagent keys", () => {
    expect(requestLiveSubagentOwnerWakeForPlugin("p", { sessionKey: "agent:coder:main" })).toEqual({
      ok: false,
      reason: "not-a-subagent-session-key",
    });
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("refuses a missing session without granting", () => {
    mocks.loadSessionEntry.mockReturnValue(undefined);
    expect(requestLiveSubagentOwnerWakeForPlugin("p", { sessionKey: KEY })).toEqual({
      ok: false,
      reason: "session-not-found",
    });
    expect(hasLiveSubagentOwnerWakeGrant(KEY)).toBe(false);
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("refuses an ended session", () => {
    mocks.loadSessionEntry.mockReturnValue({ sessionId: "s", endedAt: 5, status: "done" });
    mocks.isActive.mockReturnValue(false);
    expect(requestLiveSubagentOwnerWakeForPlugin("p", { sessionKey: KEY })).toEqual({
      ok: false,
      reason: "session-ended",
    });
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("grants and wakes a live session internally", () => {
    mocks.loadSessionEntry.mockReturnValue({ sessionId: "s", status: "running" });
    mocks.isActive.mockReturnValue(true);
    expect(requestLiveSubagentOwnerWakeForPlugin("p", { sessionKey: KEY })).toEqual({ ok: true });
    expect(hasLiveSubagentOwnerWakeGrant(KEY)).toBe(true);
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "hook",
      intent: "immediate",
      reason: "hook:plugin-owner-wake:p",
      agentId: "coder",
      sessionKey: KEY,
      heartbeat: { target: "none" },
    });
  });
});
