#!/usr/bin/env bash
# Fork-upgrade build gate, deferred to the final hop.
#
# WHY: `pnpm build` writes dist/, which is the artifact the LIVE
# openclaw-gateway.service runs from, and build-all removes existing output
# before it starts. Running it at every ladder hop means three extra windows in
# which a host reboot or crash would bring the gateway up on unvalidated
# intermediate code, for no proof value -- intermediate hops are waypoints.
#
# Build therefore runs only once v2026.9.2 is an ancestor of HEAD, i.e. at the
# final hop, which is the build that actually ships.
#
# Live artifact backed up to ~/openclaw-dist-backup-pre-v2026.9.2-*.tgz before
# this gate was introduced; restore with `tar xzf <backup> -C .` if a build dies
# partway.
set -euo pipefail
cd "$(dirname "$0")/.."
FINAL="v2026.9.2"
if ! git rev-parse -q --verify "refs/tags/$FINAL" >/dev/null; then
  echo "[build-gate] FAILED: tag $FINAL not found; cannot tell which hop this is"; exit 1
fi
if ! git merge-base --is-ancestor "$FINAL" HEAD; then
  echo "[build-gate] SKIP: intermediate hop (HEAD is not yet on $FINAL); build deferred to the final hop"
  exit 0
fi
echo "[build-gate] final hop reached -- building"
exec pnpm build
