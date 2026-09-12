import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export const requiredProbes = [
  "config-validation",
  "plugin-compatibility",
  "provider-auth",
  "model-call",
  "channel",
  "agentweave-trace",
];
const stableTag = /^v\d+\.\d+\.\d+$/;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function probeSummaryHash(probes) {
  return createHash("sha256")
    .update(
      canonical(
        [...probes]
          .map(({ name, status }) => ({ name, status }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    )
    .digest("hex");
}
export function releaseDirectory(releasesRoot, version) {
  if (!stableTag.test(version ?? ""))
    throw new Error("release version must be a stable vYYYY.M.D tag");
  return join(resolve(releasesRoot), version);
}
export function validateReleasesRoot(releasesRoot) {
  const root = resolve(releasesRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory())
    throw new Error(`releasesRoot must be an existing directory: ${root}`);
  return realpathSync(root);
}
export function validateRelease(root, version) {
  const path = releaseDirectory(root, version);
  if (
    !existsSync(path) ||
    !lstatSync(path).isDirectory() ||
    resolve(path).slice(0, root.length + 1) !== `${root}/`
  )
    throw new Error(`release must be an existing direct child of releasesRoot: ${version}`);
  return path;
}
export function validateProbes(probes) {
  const byName = new Map((probes ?? []).map((probe) => [probe.name, probe.status]));
  const missing = requiredProbes.filter((name) => !byName.has(name));
  const failed = requiredProbes.filter((name) => byName.has(name) && byName.get(name) !== "passed");
  return { complete: missing.length === 0, missing, failed };
}
export function validateApproval(
  approval,
  { version, source, rollbackTarget, probes, now = Date.now(), maxAgeMs = 15 * 60_000 },
) {
  if (
    !approval ||
    approval.approved !== true ||
    typeof approval.operator !== "string" ||
    !approval.operator.trim()
  )
    return { valid: false, reason: "approval must contain approved:true and a nonempty operator" };
  if (
    approval.version !== version ||
    approval.source !== source ||
    approval.rollbackTarget !== rollbackTarget
  )
    return { valid: false, reason: "approval is not bound to this candidate" };
  if (approval.probeSummaryHash !== probeSummaryHash(probes))
    return { valid: false, reason: "approval probe summary does not match current probes" };
  const timestamp = Date.parse(approval.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > maxAgeMs)
    return { valid: false, reason: "approval timestamp is missing, future, or stale" };
  return { valid: true };
}
export function decidePreCutover({ approval, version, source, rollbackTarget, probes, now }) {
  const probeState = validateProbes(probes);
  if (!probeState.complete || probeState.failed.length)
    return { action: "await-probes", ...probeState };
  const approvalState = validateApproval(approval, {
    version,
    source,
    rollbackTarget,
    probes,
    now,
  });
  return approvalState.valid
    ? { action: "cutover" }
    : { action: "await-approval", reason: approvalState.reason };
}
function setSelector(root, version) {
  const target = validateRelease(root, version);
  const current = join(root, "current");
  const temporary = join(root, ".current.next");
  rmSync(temporary, { force: true });
  symlinkSync(basename(target), temporary);
  renameSync(temporary, current);
  return target;
}
export function stageRelease({ releasesRoot, version, source, execute = false }) {
  const root = validateReleasesRoot(releasesRoot);
  const directory = releaseDirectory(root, version);
  if (existsSync(directory)) return { status: "existing", directory };
  if (!execute) return { status: "planned", directory, source };
  mkdirSync(directory, { recursive: false, mode: 0o755 });
  writeFileSync(
    join(directory, "RELEASE.json"),
    `${JSON.stringify({ version, source, immutable: true }, null, 2)}\n`,
    { flag: "wx", mode: 0o444 },
  );
  return { status: "staged", directory };
}
export function switchCurrent({
  releasesRoot,
  version,
  source,
  approval,
  probes,
  priorRelease,
  now,
}) {
  const root = validateReleasesRoot(releasesRoot);
  validateRelease(root, priorRelease);
  const decision = decidePreCutover({
    approval,
    version,
    source,
    rollbackTarget: priorRelease,
    probes,
    now,
  });
  if (decision.action !== "cutover") return { ...decision, rollbackTarget: priorRelease };
  const current = join(root, "current");
  if (existsSync(current) && realpathSync(current) === validateRelease(root, version))
    return { action: "already-current", current: validateRelease(root, version) };
  return { action: "cutover", current: setSelector(root, version), rollbackTarget: priorRelease };
}
export function rollbackCurrent({ releasesRoot, priorRelease, postCutoverProbes }) {
  const root = validateReleasesRoot(releasesRoot);
  const probeState = validateProbes(postCutoverProbes);
  if (probeState.complete && probeState.failed.length === 0)
    return { action: "healthy", ...probeState };
  return {
    action: "rollback",
    current: setSelector(root, priorRelease),
    rollbackTarget: priorRelease,
    ...probeState,
  };
}
function approvalAt(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("approval must be valid JSON");
  }
}
export function main(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  if (
    !["--releases-root", "--version", "--source", "--prior-release"].every((key) => args.has(key))
  )
    throw new Error(
      "Usage: rollout.mjs --releases-root path --version vX.Y.Z --source ref --prior-release vX.Y.Z [--execute] [--approval approval.json --probes probes.json --cutover|--post-cutover]",
    );
  const staged = stageRelease({
    releasesRoot: args.get("--releases-root"),
    version: args.get("--version"),
    source: args.get("--source"),
    execute: args.has("--execute"),
  });
  const probes = args.has("--probes")
    ? JSON.parse(readFileSync(resolve(args.get("--probes")), "utf8"))
    : [];
  const result = args.has("--post-cutover")
    ? rollbackCurrent({
        releasesRoot: args.get("--releases-root"),
        priorRelease: args.get("--prior-release"),
        postCutoverProbes: probes,
      })
    : args.has("--cutover")
      ? switchCurrent({
          releasesRoot: args.get("--releases-root"),
          version: args.get("--version"),
          source: args.get("--source"),
          approval: approvalAt(resolve(args.get("--approval") ?? "")),
          probes,
          priorRelease: args.get("--prior-release"),
        })
      : { action: "canary-only", approvalRequiredForCutover: true };
  console.log(JSON.stringify({ staged, result }, null, 2));
}
if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    main();
  } catch (error) {
    console.error(`[fork-upgrade-rollout] FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
