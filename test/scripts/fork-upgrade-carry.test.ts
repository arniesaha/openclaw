import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertPinnedRetirements,
  parseCarries,
  validateCarries,
  validateCommitReachability,
} from "../../scripts/fork-upgrade/carry.mjs";
describe("fork carry manifest", () => {
  it("parses the committed multiline manifest and verifies every active carry source commit", () => {
    const carries = parseCarries(readFileSync(".fork-upgrade-carry.toml", "utf8"));
    expect(validateCarries(carries)).toEqual([]);
    for (const carry of carries) {
      expect(carry.commits.length).toBeGreaterThan(0);
      expect(carry.tests.length).toBeGreaterThan(0);
    }
    expect(validateCommitReachability(process.cwd(), carries)).toEqual([]);
  });
  it("requires explicit supersession for material changes to pinned carries", () => {
    const pinned = {
      id: "ios",
      owner: "owner",
      kind: "functional",
      pinned: true,
      commits: ["one"],
      tests: ["test"],
    };
    expect(assertPinnedRetirements([pinned], [{ ...pinned, commits: ["two"] }])).toEqual([
      "pinned carry ios changed material metadata without explicit supersession",
    ]);
    expect(
      assertPinnedRetirements([pinned], [{ ...pinned, commits: ["two"], supersedes: "ios" }]),
    ).toEqual([]);
  });
});
