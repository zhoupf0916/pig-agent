import type { PlanStep } from "../types";

/** Must match server `CREATE_RUN_PROGRESS_ID_PREFIX`. */
export const CREATE_RUN_PROGRESS_ID_PREFIX = "create-run:";

export function isCreateRunProgressStep(step: PlanStep): boolean {
  return step.id.startsWith(CREATE_RUN_PROGRESS_ID_PREFIX);
}

/** Prefer the in-flight create-run chip over the generic 正在思考… placeholder. */
export function streamingStatusLabel(steps: PlanStep[]): string {
  const running = steps.find(
    (step) => step.status === "running" && isCreateRunProgressStep(step),
  );
  return running?.title ?? "正在思考…";
}
