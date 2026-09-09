import { mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decidePreCutover,
  probeSummaryHash,
  rollbackCurrent,
  stageRelease,
  switchCurrent,
} from "../../scripts/fork-upgrade/rollout.mjs";
const roots: string[] = [];
const probes = [
  "config-validation",
  "plugin-compatibility",
  "provider-auth",
  "model-call",
  "channel",
  "agentweave-trace",
].map((name) => ({ name, status: "passed" }));
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rollout-"));
  roots.push(root);
  stageRelease({ releasesRoot: root, version: "v2026.9.2", source: "prior", execute: true });
  stageRelease({ releasesRoot: root, version: "v2026.10.1", source: "candidate", execute: true });
  return root;
}
function approval(now = Date.now()) {
  return {
    approved: true,
    version: "v2026.10.1",
    source: "candidate",
    rollbackTarget: "v2026.9.2",
    probeSummaryHash: probeSummaryHash(probes),
    timestamp: new Date(now).toISOString(),
    operator: "operator",
  };
}
describe("immutable canary rollout", () => {
  it("plans an immutable versioned release without creating it", () => {
    const root = mkdtempSync(join(tmpdir(), "rollout-"));
    roots.push(root);
    expect(
      stageRelease({ releasesRoot: root, version: "v2026.10.1", source: "candidate" }),
    ).toMatchObject({ status: "planned" });
  });
  it("requires every required probe before cutover", () =>
    expect(
      decidePreCutover({
        approval: approval(),
        version: "v2026.10.1",
        source: "candidate",
        rollbackTarget: "v2026.9.2",
        probes: [],
      }).action,
    ).toBe("await-probes"));
  it("rejects wrong-candidate and stale approvals", () => {
    expect(
      decidePreCutover({
        approval: { ...approval(), version: "v2026.10.2" },
        version: "v2026.10.1",
        source: "candidate",
        rollbackTarget: "v2026.9.2",
        probes,
      }).action,
    ).toBe("await-approval");
    expect(
      decidePreCutover({
        approval: approval(0),
        version: "v2026.10.1",
        source: "candidate",
        rollbackTarget: "v2026.9.2",
        probes,
        now: 1_000_000_000,
      }).action,
    ).toBe("await-approval");
  });
  it("cuts over atomically only with a candidate-bound approval and is idempotent", () => {
    const root = fixture();
    expect(
      switchCurrent({
        releasesRoot: root,
        version: "v2026.10.1",
        source: "candidate",
        approval: approval(),
        probes,
        priorRelease: "v2026.9.2",
      }).action,
    ).toBe("cutover");
    expect(readlinkSync(join(root, "current"))).toBe("v2026.10.1");
    expect(
      switchCurrent({
        releasesRoot: root,
        version: "v2026.10.1",
        source: "candidate",
        approval: approval(),
        probes,
        priorRelease: "v2026.9.2",
      }).action,
    ).toBe("already-current");
  });
  it("restores the prior selector after a post-cutover probe failure", () => {
    const root = fixture();
    switchCurrent({
      releasesRoot: root,
      version: "v2026.10.1",
      source: "candidate",
      approval: approval(),
      probes,
      priorRelease: "v2026.9.2",
    });
    expect(
      rollbackCurrent({
        releasesRoot: root,
        priorRelease: "v2026.9.2",
        postCutoverProbes: probes.map((probe) =>
          probe.name === "model-call" ? { ...probe, status: "failed" } : probe,
        ),
      }).action,
    ).toBe("rollback");
    expect(readlinkSync(join(root, "current"))).toBe("v2026.9.2");
  });
  it("rejects traversal and invalid rollback releases", () => {
    const root = fixture();
    expect(() =>
      stageRelease({ releasesRoot: root, version: "../escape", source: "candidate" }),
    ).toThrow("stable");
    expect(() =>
      switchCurrent({
        releasesRoot: root,
        version: "v2026.10.1",
        source: "candidate",
        approval: approval(),
        probes,
        priorRelease: "../escape",
      }),
    ).toThrow("stable");
  });
});
