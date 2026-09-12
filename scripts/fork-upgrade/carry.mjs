import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const required = ["id", "owner", "kind", "pinned", "commits", "tests"];
const materialFields = ["owner", "kind", "commits", "tests", "upstream_pr"];
function quotedValues(value) {
  return [...value.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((match) =>
    match[1].replaceAll('\\"', '"'),
  );
}
export function parseCarries(text) {
  const carries = [];
  let carry;
  let arrayKey;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[carry]]") {
      if (arrayKey) throw new Error(`unterminated array for ${arrayKey}`);
      carry = {};
      carries.push(carry);
      continue;
    }
    if (arrayKey) {
      carry[arrayKey].push(...quotedValues(line));
      if (line.includes("]")) arrayKey = undefined;
      continue;
    }
    const match = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match || !carry) throw new Error(`unsupported carry manifest line: ${line}`);
    const [, key, value] = match;
    if (value.startsWith("[")) {
      carry[key] = quotedValues(value);
      if (!value.includes("]")) arrayKey = key;
    } else
      carry[key] =
        value === "true" ? true : value === "false" ? false : value.replace(/^"|"$/g, "");
  }
  if (arrayKey) throw new Error(`unterminated array for ${arrayKey}`);
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
    for (const key of ["commits", "tests"])
      if (!Array.isArray(carry[key]) || carry[key].length === 0)
        errors.push(`${carry.id}: ${key} must be nonempty`);
  }
  return errors;
}
function canonical(value) {
  return JSON.stringify(value);
}
export function assertPinnedRetirements(previous, next) {
  const nextById = new Map(next.map((carry) => [carry.id, carry]));
  const errors = [];
  for (const prior of previous.filter((carry) => carry.pinned)) {
    const replacement = nextById.get(prior.id);
    if (!replacement) {
      errors.push(
        `pinned carry ${prior.id} cannot retire without an explicit retirement/supersession record`,
      );
      continue;
    }
    const changed = materialFields.some(
      (field) => canonical(prior[field] ?? null) !== canonical(replacement[field] ?? null),
    );
    if (changed && replacement.supersedes !== prior.id)
      errors.push(
        `pinned carry ${prior.id} changed material metadata without explicit supersession`,
      );
  }
  return errors;
}
function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}
export function validateCommitReachability(root, carries) {
  const errors = [];
  for (const carry of carries)
    for (const commit of carry.commits ?? [])
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
