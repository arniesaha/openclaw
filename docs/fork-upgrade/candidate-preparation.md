# Candidate preparation

Run the candidate script from a disposable worktree with a sanitized tag list and an operator-owned state path outside the checkout. It only writes a local candidate report; it never deploys, restarts a gateway, or changes a production selector. Stable tags use `vYYYY.M.D`; prereleases and maintenance variants are ignored. A repeated target/status is reported as a duplicate without rewriting state. Pinned carry retirement blocks candidate preparation until an explicit replacement manifest is reviewed.
