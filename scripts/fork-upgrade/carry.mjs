import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const required = ["id", "owner", "kind", "pinned", "commits", "tests"];
export function parseCarries(text) {
  const carries = [];
  let carry;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[carry]]") {
      carry = {};
      carries.push(carry);
      continue;
    }
    const match = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match || !carry) continue;
    const [, key, value] = match;
    carry[key] =
      value === "true"
        ? true
        : value === "false"
          ? false
          : value.startsWith("[")
            ? [...value.matchAll(/"([^"]+)"/g)].map((m) => m[1])
            : value.replace(/^"|"$/g, "");
  }
  return carries;
}
export function validateCarries(carries, { min = 4, max = 8 } = {}) {
  const errors = [];
  if (carries.length < min || carries.length > max)
    errors.push(`functional carry count ${carries.length} is outside ${min}-${max}`);
  const ids = new Set();
  for (const carry of carries) {
    for (const key of required)
      if (carry[key] === undefined) errors.push(`${carry.id ?? "unknown"}: missing ${key}`);
    if (ids.has(carry.id)) errors.push(`duplicate carry id ${carry.id}`);
    ids.add(carry.id);
    if (!Array.isArray(carry.commits) || carry.commits.length === 0)
      errors.push(`${carry.id}: commits must be nonempty`);
    if (!Array.isArray(carry.tests) || carry.tests.length === 0)
      errors.push(`${carry.id}: tests must be nonempty`);
  }
  return errors;
}
export function assertPinnedRetirements(previous, next) {
  const nextIds = new Set(next.map((carry) => carry.id));
  return previous
    .filter((carry) => carry.pinned && !nextIds.has(carry.id))
    .map((carry) => `pinned carry ${carry.id} cannot retire without an explicit retirement record`);
}
function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}
export function validateCommitReachability(root, carries) {
  const errors = [];
  for (const carry of carries)
    for (const commit of carry.commits)
      if (git(root, ["cat-file", "-e", `${commit}^{commit}`]).status !== 0)
        errors.push(`${carry.id}: missing source commit ${commit}`);
  return errors;
}
export function main(argv = process.argv.slice(2), root = process.cwd()) {
  if (argv.length || !existsSync(resolve(root, ".fork-upgrade-carry.toml")))
    throw new Error("Usage: node scripts/fork-upgrade/carry.mjs (run at repository root)");
  const carries = parseCarries(readFileSync(resolve(root, ".fork-upgrade-carry.toml"), "utf8"));
  const errors = [...validateCarries(carries), ...validateCommitReachability(root, carries)];
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    JSON.stringify(
      {
        status: "ok",
        functionalCarryUnits: carries.length,
        carries: carries.map(({ id, owner, pinned }) => ({ id, owner, pinned })),
      },
      null,
      2,
    ),
  );
}
if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    main();
  } catch (error) {
    console.error(`[fork-upgrade-carry] FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
