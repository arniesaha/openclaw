# Immutable candidate rollout

The rollout control stages a versioned release directory and never overwrites it. A canary must run on an alternate, isolated environment and produce config, plugin, provider-auth, model-call, channel, and trace probe results before cutover. Cutover is impossible without an operator approval packet; failed defined post-cutover probes select the recorded prior release as rollback target. The tool is local and pull-oriented: it has no GitHub Actions deployment credentials or service-management behavior.
