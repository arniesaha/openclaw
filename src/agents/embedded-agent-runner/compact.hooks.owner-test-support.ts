export { containsRealConversationMessages } from "./compaction-diagnostics.js";
export {
  buildBeforeCompactionHookMetrics,
  estimateTokensAfterCompaction,
  runPostCompactionSideEffects,
} from "./compaction-hooks.js";
// Fork carry: the carried compaction attribution test drives this directly.
export { prepareCompactionSessionAgent } from "./compaction-session-agent.js";
