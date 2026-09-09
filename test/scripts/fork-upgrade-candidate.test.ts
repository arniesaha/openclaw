import { describe, expect, it } from "vitest";
import { buildCandidate, stableTags } from "../../scripts/fork-upgrade/candidate.mjs";
const carry = {
  id: "carry",
  pinned: false,
  tests: ["test"],
  upstream_pr: "https://example.invalid/pr",
};
describe("fork upgrade candidate", () => {
  it("filters prerelease and duplicate tags", () =>
    expect(stableTags(["v2026.10.1-beta.1", "v2026.9.2", "v2026.9.2", "v2026.10.1"])).toEqual([
      "v2026.9.2",
      "v2026.10.1",
    ]));
  it("is idempotent when there is no newer stable tag", () =>
    expect(
      buildCandidate({
        tags: ["v2026.9.2-beta.1", "v2026.9.2"],
        currentTag: "v2026.9.2",
        carries: [carry],
        rollbackTarget: "old",
      }),
    ).toEqual({ status: "noop", reason: "no newer stable tag" }));
  it("blocks retirement of a pinned carry", () =>
    expect(
      buildCandidate({
        tags: ["v2026.10.1"],
        currentTag: "v2026.9.2",
        carries: [],
        priorCarries: [{ ...carry, pinned: true }],
        rollbackTarget: "old",
      }).status,
    ).toBe("blocked"));
});
