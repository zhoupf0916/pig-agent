/** Effective policy is pinned to a run/plan. Missing values never mean consent. */
export function executionPolicy(
  input: { requireApproval?: boolean; networkPolicy?: "ask" | "blocked" },
  defaults: { requireApproval: boolean; networkPolicy: "ask" | "blocked" },
  scope: { sharedProject?: boolean } = {},
) {
  return {
    requireApproval: scope.sharedProject ? true : input.requireApproval ?? defaults.requireApproval,
    networkPolicy: input.networkPolicy ?? defaults.networkPolicy,
  };
}
