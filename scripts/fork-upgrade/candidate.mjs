import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseCarries, assertPinnedRetirements } from "./carry.mjs";

export function stableTags(tags) {
  return [...new Set(tags)]
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
export function buildCandidate({
  tags,
  currentTag,
  carries,
  priorCarries = carries,
  migrations = [],
  rollbackTarget,
}) {
  const orderedTags = stableTags(tags);
  const targetTag = orderedTags.slice(orderedTags.indexOf(currentTag) + 1).at(-1);
  if (!targetTag) return { status: "noop", reason: "no newer stable tag" };
  const pinnedRetirements = assertPinnedRetirements(priorCarries, carries);
  return {
    status: pinnedRetirements.length ? "blocked" : "ready",
    targetTag,
    rollbackTarget,
    pinnedRetirements,
    carries: carries.map(({ id, pinned, tests, upstream_pr: upstreamPr }) => ({
      id,
      pinned,
      tests,
      upstreamPr,
      semanticRisk: "review-required",
    })),
    migrationAnalysis: migrations,
    contextPack: [
      "target tag",
      "release notes",
      "carry diffs",
      "touched upstream owners",
      "test matrix",
      "config migrations",
      "rollback target",
    ],
    productionAction: "none",
  };
}
export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
  if (!["--tags", "--state", "--current-tag", "--rollback-target"].every((key) => args.has(key)))
    throw new Error(
      "Usage: candidate.mjs --tags tags.json --state state.json --current-tag vX.Y.Z --rollback-target ref [--migrations migrations.json]",
    );
  const carries = parseCarries(readFileSync(resolve(root, ".fork-upgrade-carry.toml"), "utf8"));
  const statePath = resolve(root, args.get("--state"));
  const state = readJson(statePath, {});
  const candidate = buildCandidate({
    tags: readJson(resolve(root, args.get("--tags")), []),
    currentTag: args.get("--current-tag"),
    carries,
    priorCarries: state.carries ?? carries,
    migrations: args.has("--migrations")
      ? readJson(resolve(root, args.get("--migrations")), [])
      : [],
    rollbackTarget: args.get("--rollback-target"),
  });
  if (state.targetTag === candidate.targetTag && state.status === candidate.status) {
    console.log(JSON.stringify({ ...candidate, duplicate: true }, null, 2));
    return;
  }
  writeJsonAtomic(statePath, { ...candidate, carries, updatedAt: new Date().toISOString() });
  console.log(JSON.stringify({ ...candidate, duplicate: false }, null, 2));
}
if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    main();
  } catch (error) {
    console.error(`[fork-upgrade-candidate] FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
