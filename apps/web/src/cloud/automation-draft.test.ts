import { describe, expect, it } from "vitest";
import { draftPlan, editPlan } from "./automation-draft";
describe("自动化计划编辑", () => {
  it("修改名称后保存仍保留原来的自定义执行时间", () => {
    const plan = { kind: "custom" as const, cron: "15 9 1 * *" };
    expect(draftPlan(editPlan(plan))).toEqual(plan);
  });
  it("每周未选任何一天时阻止保存并说明原因", () => {
    expect(() =>
      draftPlan({ kind: "weekdays", time: "09:00", days: [], cron: "" }),
    ).toThrow("至少选择一天");
  });
});
