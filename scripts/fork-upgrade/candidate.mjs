import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseCarries, assertPinnedRetirements, validateCarries } from "./carry.mjs";

const stableTag = /^v\d+\.\d+\.\d+$/;
export function stableTags(tags) {
  return [...new Set(tags)]
    .filter((tag) => stableTag.test(tag))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
export function resolveInside(root, path) {
  if (!path || isAbsolute(path))
    throw new Error("candidate paths must be non-absolute repository-relative paths");
  const resolved = resolve(root, path);
  if (relative(root, resolved).startsWith(".."))
    throw new Error(`candidate path escapes repository root: ${path}`);
  return resolved;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function candidateFingerprint(candidate) {
  const {
    fingerprint: _fingerprint,
    duplicate: _duplicate,
    updatedAt: _updatedAt,
    ...reviewMaterial
  } = candidate;
  return createHash("sha256").update(canonical(reviewMaterial)).digest("hex");
}
export function buildCandidate({
  tags,
  currentTag,
  carries,
  priorCarries = carries,
  migrations = [],
  rollbackTarget,
  releaseNotes = [],
}) {
  const orderedTags = stableTags(tags);
  const carryErrors = validateCarries(carries);
  if (!stableTag.test(currentTag ?? "") || !orderedTags.includes(currentTag))
    return {
      status: "blocked",
      errors: ["currentTag must be a stable tag present in the stable tag set"],
    };
  if (carryErrors.length) return { status: "blocked", errors: carryErrors };
  const targetTag = orderedTags.slice(orderedTags.indexOf(currentTag) + 1).at(-1);
  if (!targetTag) return { status: "noop", reason: "no newer stable tag" };
  const pinnedRetirements = assertPinnedRetirements(priorCarries, carries);
  const candidate = {
    status: pinnedRetirements.length ? "blocked" : "ready",
    targetTag,
    rollbackTarget,
    pinnedRetirements,
    carries: carries.map(({ id, pinned, tests, upstream_pr: upstreamPr, commits }) => ({
      id,
      pinned,
      commits,
      tests,
      upstreamPr,
      semanticRisk: "review-required",
    })),
    migrationAnalysis: migrations,
    releaseNotes,
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
  return { ...candidate, fingerprint: candidateFingerprint(candidate) };
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
      "Usage: candidate.mjs --tags tags.json --state state.json --current-tag vX.Y.Z --rollback-target ref [--migrations migrations.json] [--release-notes release-notes.json]",
    );
  const statePath = resolveInside(root, args.get("--state"));
  const tagsPath = resolveInside(root, args.get("--tags"));
  const migrationsPath = args.has("--migrations")
    ? resolveInside(root, args.get("--migrations"))
    : undefined;
  const notesPath = args.has("--release-notes")
    ? resolveInside(root, args.get("--release-notes"))
    : undefined;
  const carries = parseCarries(
    readFileSync(resolveInside(root, ".fork-upgrade-carry.toml"), "utf8"),
  );
  const state = readJson(statePath, {});
  const candidate = buildCandidate({
    tags: readJson(tagsPath, []),
    currentTag: args.get("--current-tag"),
    carries,
    priorCarries: state.carries ?? carries,
    migrations: migrationsPath ? readJson(migrationsPath, []) : [],
    releaseNotes: notesPath ? readJson(notesPath, []) : [],
    rollbackTarget: args.get("--rollback-target"),
  });
  if (state.fingerprint && state.fingerprint === candidate.fingerprint) {
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
