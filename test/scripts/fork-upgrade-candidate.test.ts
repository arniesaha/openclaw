import { describe, expect, it } from "vitest";
import {
  buildCandidate,
  candidateFingerprint,
  resolveInside,
  stableTags,
} from "../../scripts/fork-upgrade/candidate.mjs";
const carry = {
  id: "carry",
  owner: "owner",
  kind: "functional",
  pinned: false,
  commits: ["commit"],
  tests: ["test"],
  upstream_pr: "https://example.invalid/pr",
};
describe("fork upgrade candidate", () => {
  it("filters prerelease and duplicate tags", () =>
    expect(stableTags(["v2026.10.1-beta.1", "v2026.9.2", "v2026.9.2", "v2026.10.1"])).toEqual([
      "v2026.9.2",
      "v2026.10.1",
    ]));
  it("fails closed for absent or malformed current tags", () => {
    expect(
      buildCandidate({
        tags: ["v2026.9.2", "v2026.10.1"],
        currentTag: "v2026.9",
        carries: [carry],
        rollbackTarget: "old",
      }).status,
    ).toBe("blocked");
    expect(
      buildCandidate({
        tags: ["v2026.9.2", "v2026.10.1"],
        currentTag: "v2026.9.3",
        carries: [carry],
        rollbackTarget: "old",
      }).status,
    ).toBe("blocked");
  });
  it("validates carries before candidate readiness", () =>
    expect(
      buildCandidate({
        tags: ["v2026.9.2", "v2026.10.1"],
        currentTag: "v2026.9.2",
        carries: [{ ...carry, tests: [] }],
        rollbackTarget: "old",
      }).status,
    ).toBe("blocked"));
  it("fingerprints changed review material instead of treating it as a duplicate", () => {
    const base = buildCandidate({
      tags: ["v2026.9.2", "v2026.10.1"],
      currentTag: "v2026.9.2",
      carries: [carry],
      rollbackTarget: "old",
      migrations: ["one"],
    });
    const changed = { ...base, migrationAnalysis: ["two"] };
    expect(candidateFingerprint(base)).not.toBe(candidateFingerprint(changed));
  });
  it("rejects input paths outside the repository", () => {
    expect(() => resolveInside("/repo", "../state.json")).toThrow("escapes repository root");
    expect(() => resolveInside("/repo", "/tmp/state.json")).toThrow("non-absolute");
  });
});
