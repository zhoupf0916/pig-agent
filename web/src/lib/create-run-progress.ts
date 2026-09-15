import type { PlanStep } from "../types";

/** Must match server `CREATE_RUN_PROGRESS_ID_PREFIX`. */
export const CREATE_RUN_PROGRESS_ID_PREFIX = "create-run:";

/** Must match server `FOLLOW_UP_PROGRESS_ID_PREFIX`. */
export const FOLLOW_UP_PROGRESS_ID_PREFIX = "follow-up:";

/** Must match server `LOCAL_STUB_PROGRESS_ID_PREFIX`. */
export const LOCAL_STUB_PROGRESS_ID_PREFIX = "local-stub:";

export function isCreateRunProgressStep(step: PlanStep): boolean {
  return step.id.startsWith(CREATE_RUN_PROGRESS_ID_PREFIX);
}

export function isFollowUpProgressStep(step: PlanStep): boolean {
  return step.id.startsWith(FOLLOW_UP_PROGRESS_ID_PREFIX);
}

export function isLocalStubProgressStep(step: PlanStep): boolean {
  return step.id.startsWith(LOCAL_STUB_PROGRESS_ID_PREFIX);
}

export function isRemoteWaitProgressStep(step: PlanStep): boolean {
  return (
    isCreateRunProgressStep(step) || isFollowUpProgressStep(step) || isLocalStubProgressStep(step)
  );
}

/** Prefer the in-flight bootstrap chip over the generic 正在思考… placeholder. */
export function streamingStatusLabel(steps: PlanStep[]): string {
  const running = steps.find(
    (step) => step.status === "running" && isRemoteWaitProgressStep(step),
  );
  return running?.title ?? "正在思考…";
}
