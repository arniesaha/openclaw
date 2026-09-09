import { describe, expect, it } from "vitest";
import {
  assertPinnedRetirements,
  parseCarries,
  validateCarries,
} from "../../scripts/fork-upgrade/carry.mjs";
describe("fork carry manifest", () => {
  it("enforces the capability carry budget and required ownership", () => {
    expect(
      validateCarries(
        parseCarries(
          `[[carry]]\nid = "a"\nowner = "owner"\nkind = "functional"\npinned = false\ncommits = ["a"]\ntests = ["a"]`,
        ),
      ),
    ).toContain("functional carry count 1 is outside 4-8");
  });
  it("does not silently retire pinned carries", () => {
    expect(assertPinnedRetirements([{ id: "ios", pinned: true }], [])).toEqual([
      "pinned carry ios cannot retire without an explicit retirement record",
    ]);
  });
});
