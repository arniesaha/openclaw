#!/usr/bin/env bash
# Fork-upgrade gate wrapper for the compaction attribution surface.
#
# WHY THIS EXISTS: at the intermediate ladder hop v2026.8.1, upstream's own
# compact.hooks.test.ts has 10 failing tests that reproduce on a PRISTINE
# upstream tree (proven by checking out v2026.8.1 -- src/agents/embedded-agent-runner/
# with no carries applied: 10 failed | 155 passed). They are not fork-caused, and
# an intermediate hop is a waypoint, not a deliverable.
#
# Rather than drop the file from the gate -- which would blind us to a real carry
# regression in it, exactly the failure class this whole run keeps hitting -- the
# full file still runs and only failures OUTSIDE the recorded baseline fail the hop.
#
# THE BASELINE IS HOP-SPECIFIC AND MUST NOT SURVIVE THE RUN. Upstream rewrites
# compact.hooks.test.ts by v2026.9.2 (+686/-169), so the tolerance is now
# MECHANICALLY scoped to the intermediate hops: once v2026.9.2 is an ancestor of
# HEAD the baseline is ignored entirely and the file must be green outright.
# Nothing here depends on a human remembering to clear it.
set -uo pipefail
cd "$(dirname "$0")/.."
BASE=".fork-upgrade-gates/compact-hooks-upstream-baseline.txt"
FINAL="v2026.9.2"
OUT="$(mktemp)"; trap 'rm -f "$OUT" "$OUT.f"' EXIT

pnpm test src/agents/embedded-agent-runner/stream-resolution.test.ts \
          src/agents/embedded-agent-runner/compact.hooks.test.ts 2>&1 | tee "$OUT"

# stream-resolution.test.ts must be clean outright; it carries the header stamp.
if grep -qE '^ FAIL .*stream-resolution\.test\.ts' "$OUT"; then
  echo "[compaction-gate] FAILED: stream-resolution.test.ts must be green (carry surface)"; exit 1
fi

# Final hop: the v2026.8.1 baseline is meaningless against a rewritten file.
if git merge-base --is-ancestor "$FINAL" HEAD 2>/dev/null; then
  if grep -qE '^ FAIL ' "$OUT"; then
    echo "[compaction-gate] FAILED: final hop ($FINAL) requires compact.hooks.test.ts green;"
    echo "                 the intermediate-hop baseline is intentionally not applied here."
    grep -E '^ FAIL ' "$OUT"
    exit 1
  fi
  echo "[compaction-gate] OK: clean at the final hop, baseline retired"
  exit 0
fi

grep -E '^ FAIL ' "$OUT" | sed 's/.*compact\.hooks\.test\.ts > //' | sort -u > "$OUT.f"
UNEXPECTED="$(comm -23 "$OUT.f" <(sort -u "$BASE"))"
if [ -n "$UNEXPECTED" ]; then
  echo "[compaction-gate] FAILED: failures outside the known upstream baseline:"
  echo "$UNEXPECTED"; exit 1
fi
echo "[compaction-gate] OK: only the $(grep -c . "$BASE") known-upstream v2026.8.1 failures remain (intermediate hop)"
