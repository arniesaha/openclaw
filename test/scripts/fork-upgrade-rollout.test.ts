import { mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideRollout, stageRelease, switchCurrent } from "../../scripts/fork-upgrade/rollout.mjs";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots) require("node:fs").rmSync(root, { recursive: true, force: true });
});
describe("immutable canary rollout", () => {
  it("plans a versioned release without creating it", () => {
    const root = mkdtempSync(join(tmpdir(), "rollout-"));
    roots.push(root);
    expect(
      stageRelease({ releasesRoot: root, version: "v2026.10.1", source: "candidate" }),
    ).toMatchObject({ status: "planned" });
  });
  it("requires approval before cutover", () =>
    expect(decideRollout({ approval: false, probes: [], priorRelease: "v2026.9.2" }).action).toBe(
      "await-approval",
    ));
  it("rolls back on defined probe failure", () =>
    expect(
      decideRollout({
        approval: true,
        probes: [{ name: "model-call", status: "failed" }],
        priorRelease: "v2026.9.2",
      }),
    ).toMatchObject({ action: "rollback", failures: ["model-call"] }));
  it("switches current atomically only after approved probes", () => {
    const root = mkdtempSync(join(tmpdir(), "rollout-"));
    roots.push(root);
    const target = stageRelease({
      releasesRoot: root,
      version: "v2026.10.1",
      source: "candidate",
      execute: true,
    });
    expect(
      switchCurrent({
        releasesRoot: root,
        version: "v2026.10.1",
        approval: true,
        probes: [{ name: "config", status: "passed" }],
        priorRelease: "v2026.9.2",
      }).action,
    ).toBe("cutover");
    expect(readlinkSync(join(root, "current"))).toBe("v2026.10.1");
    expect(target.status).toBe("staged");
  });
});
