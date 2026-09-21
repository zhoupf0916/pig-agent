import { describe, expect, it } from "vitest";
import { listSkills, loadSkill, parseFrontmatter, suggestSkills } from "./skills.ts";

describe("skills", () => {
  it("parses YAML-like frontmatter", () => {
    const { data, body } = parseFrontmatter(
      "---\nname: demo\ndescription: Hello\nkeywords: a, b\n---\n\n# Title\n\nBody\n",
    );
    expect(data.name).toBe("demo");
    expect(data.description).toBe("Hello");
    expect(data.keywords).toBe("a, b");
    expect(body).toContain("# Title");
  });

  it("lists shipped sample skills", async () => {
    const skills = await listSkills();
    const names = skills.map((s) => s.name);
    expect(names).toContain("organize-workspace");
    expect(names).toContain("write-summary");
    expect(names).toContain("daily-notes");
    expect(names).toContain("doc-writing");
    expect(names).toContain("data-cleanup");
    expect(names).toContain("research-report");
    expect(names).toContain("coding-helper");
  });

  it("loads a skill body", async () => {
    const skill = await loadSkill("write-summary");
    expect(skill.body).toContain("README");
  });

  it("suggests skills from task keywords", async () => {
    const skills = await listSkills();
    const research = suggestSkills("请根据笔记做一份中文调研报告", skills);
    expect(research[0]?.name).toBe("research-report");
    const code = suggestSkills("帮我 refactor 这段代码并打一个 patch", skills);
    expect(code.some((s) => s.name === "coding-helper")).toBe(true);
    const tidy = suggestSkills("整理工作区并把散落文件归类", skills);
    expect(tidy.some((s) => s.name === "organize-workspace")).toBe(true);
  });
});
