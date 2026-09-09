import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function releaseDirectory(releasesRoot, version) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("version must be a stable vYYYY.M.D tag");
  return join(resolve(releasesRoot), version);
}
export function decideRollout({ approval, probes, priorRelease }) {
  if (!approval) return { action: "await-approval", rollbackTarget: priorRelease };
  const failures = probes.filter((probe) => probe.status !== "passed").map((probe) => probe.name);
  return failures.length
    ? { action: "rollback", rollbackTarget: priorRelease, failures }
    : { action: "cutover", rollbackTarget: priorRelease };
}
export function stageRelease({ releasesRoot, version, source, execute = false }) {
  const directory = releaseDirectory(releasesRoot, version);
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
export function switchCurrent({ releasesRoot, version, approval, probes, priorRelease }) {
  const decision = decideRollout({ approval, probes, priorRelease });
  if (decision.action !== "cutover") return decision;
  const root = resolve(releasesRoot);
  const target = releaseDirectory(root, version);
  if (!existsSync(target)) throw new Error(`candidate release is absent: ${target}`);
  const current = join(root, "current");
  const temporary = join(root, ".current.next");
  rmSync(temporary, { force: true });
  symlinkSync(basename(target), temporary);
  renameSync(temporary, current);
  return { ...decision, current: target };
}
export function main(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  if (
    !["--releases-root", "--version", "--source", "--prior-release"].every((key) => args.has(key))
  )
    throw new Error(
      "Usage: rollout.mjs --releases-root path --version vX.Y.Z --source ref --prior-release path [--execute] [--approval approval.json] [--probes probes.json]",
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
  const approval = args.has("--approval") && existsSync(resolve(args.get("--approval")));
  const result = args.has("--cutover")
    ? switchCurrent({
        releasesRoot: args.get("--releases-root"),
        version: args.get("--version"),
        approval,
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
