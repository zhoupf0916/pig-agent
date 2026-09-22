/** Effective policy is pinned to a run/plan. Missing values never mean consent. */
export function executionPolicy(
  input: { requireApproval?: boolean; networkPolicy?: "ask" | "blocked" },
  defaults: { requireApproval: boolean; networkPolicy: "ask" | "blocked" },
) {
  return {
    requireApproval: input.requireApproval ?? defaults.requireApproval,
    networkPolicy: input.networkPolicy ?? defaults.networkPolicy,
  };
}
