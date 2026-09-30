import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.fn();
const getBuiltinModule = process.getBuiltinModule.bind(process);

describe("Anthropic host CLI identity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    execFileSync.mockReset();
  });

  it.each<{ name: string; output?: string; override?: string; expected: string }>([
    { name: "missing", output: undefined, expected: "2.1.280" },
    { name: "older", output: "2.1.234 (Claude Code)", expected: "2.1.280" },
    { name: "newer", output: "2.1.300 (Claude Code)", expected: "2.1.300" },
    ...["garbage", "2.1.234", "2.1.300-beta", "9007199254740992.1.0"].map((override) => ({
      name: `invalid override ${override}`,
      override,
      output: "2.1.300 (Claude Code)",
      expected: "2.1.300",
    })),
  ])(
    "keeps matching OAuth wire and billing identity with $name host CLI",
    async ({ output, expected, override }) => {
      vi.stubEnv("OPENCLAW_CLAUDE_CODE_VERSION", override ?? "");
      vi.stubEnv("OPENCLAW_CLAUDE_BIN", "fixture-claude");
      execFileSync.mockImplementation(() => {
        if (output === undefined) {
          throw new Error("CLI not installed");
        }
        return output;
      });
      vi.spyOn(process, "getBuiltinModule").mockImplementation((name) =>
        name === "node:child_process" ? { execFileSync } : getBuiltinModule(name),
      );
      const { buildAnthropicClaudeCodeIdentity } = await import("./anthropic-model-contract.js");
      const identity = buildAnthropicClaudeCodeIdentity(undefined);
      expect(identity.version).toBe(expected);
      expect(identity.headers["user-agent"]).toBe(`claude-cli/${expected}`);
      expect(execFileSync).toHaveBeenCalledWith(
        "fixture-claude",
        ["--version"],
        expect.objectContaining({ timeout: 5000 }),
      );
    },
  );

  it("uses the existing explicit override without starting a host CLI", async () => {
    vi.stubEnv("OPENCLAW_CLAUDE_CODE_VERSION", "2.1.310");
    vi.spyOn(process, "getBuiltinModule").mockImplementation((name) =>
      name === "node:child_process" ? { execFileSync } : getBuiltinModule(name),
    );
    const { buildAnthropicClaudeCodeIdentity } = await import("./anthropic-model-contract.js");
    const identity = buildAnthropicClaudeCodeIdentity(undefined);
    expect(identity.version).toBe("2.1.310");
    expect(identity.headers["user-agent"]).toBe("claude-cli/2.1.310");
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
