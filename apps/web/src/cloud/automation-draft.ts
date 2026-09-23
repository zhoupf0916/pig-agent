import { planToCron, type SchedulePlan } from "@pig-agent/contracts";
export type PlanDraft = {
  kind: SchedulePlan["kind"];
  time: string;
  days: number[];
  cron: string;
};
export function editPlan(plan: SchedulePlan): PlanDraft {
  return {
    kind: plan.kind,
    time: "time" in plan ? plan.time : "09:00",
    days: plan.kind === "weekdays" ? plan.days : [1, 2, 3, 4, 5],
    cron: plan.kind === "custom" ? plan.cron : "",
  };
}
export function draftPlan(draft: PlanDraft): SchedulePlan {
  if (draft.kind === "manual" || draft.kind === "hourly")
    return { kind: draft.kind };
  if (draft.kind === "custom") {
    if (!draft.cron.trim()) throw Error("请输入执行计划");
    return { kind: "custom", cron: draft.cron.trim() };
  }
  if (draft.kind === "weekdays") {
    planToCron({ kind: "weekdays", time: draft.time, days: draft.days });
  }
  if (draft.kind === "weekdays")
    return { kind: "weekdays", time: draft.time, days: draft.days };
  return { kind: "daily", time: draft.time };
}
