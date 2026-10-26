// Tests that live-subagent owner wakes are gated by the plugin manifest contract.
import { describe, expect, it, vi } from "vitest";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const wakeMock = vi.hoisted(() => vi.fn(() => ({ ok: true as const })));
vi.mock("./runtime/owner-wake.js", () => ({
  LIVE_SUBAGENT_OWNER_WAKE_CONTRACT: "live-subagent-session",
  requestLiveSubagentOwnerWakeForPlugin: wakeMock,
}));

function createApi(contracts?: { heartbeatOwnerWake?: string[] }) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createLazyPluginRuntime({}),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "owner-plugin", contracts });
  builder.registry.plugins.push(record);
  return builder.createApi(record, { config: {} });
}

describe("requestLiveSubagentOwnerWake contract gate", () => {
  const opts = { sessionKey: "agent:coder:subagent:a" };

  it("rejects plugins without the contract", () => {
    wakeMock.mockClear();
    expect(() => createApi().runtime.system.requestLiveSubagentOwnerWake(opts)).toThrow(
      /heartbeatOwnerWake/,
    );
    expect(() =>
      createApi({ heartbeatOwnerWake: ["other"] }).runtime.system.requestLiveSubagentOwnerWake(
        opts,
      ),
    ).toThrow(/heartbeatOwnerWake/);
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it("forwards the host-owned plugin id for entitled plugins", () => {
    wakeMock.mockClear();
    const api = createApi({ heartbeatOwnerWake: ["live-subagent-session"] });
    expect(api.runtime.system.requestLiveSubagentOwnerWake(opts)).toEqual({ ok: true });
    expect(wakeMock).toHaveBeenCalledWith("owner-plugin", opts);
  });
});
