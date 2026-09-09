# v2026.9.2 carry archive

This archive preserves the 37 historical fork commits as provenance, while `.fork-upgrade-carry.toml` defines the five replayable capability-level units. Migration notes, deployment history, and upstream implementation narratives remain documentation, not replay inputs. The iOS carry is pinned because it has no upstream PR and needs an explicit retirement record.

Run `node scripts/fork-upgrade/carry.mjs` before preparing a candidate. It fails closed when the carry budget, owners, test mapping, or source provenance is incomplete.
