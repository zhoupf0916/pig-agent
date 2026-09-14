import { describe, expect, it } from "vitest";
import { listSkills, loadSkill, parseFrontmatter } from "./skills.ts";

describe("skills", () => {
  it("parses YAML-like frontmatter", () => {
    const { data, body } = parseFrontmatter(
      "---\nname: demo\ndescription: Hello\n---\n\n# Title\n\nBody\n",
    );
    expect(data.name).toBe("demo");
    expect(data.description).toBe("Hello");
    expect(body).toContain("# Title");
  });

  it("lists shipped sample skills", async () => {
    const skills = await listSkills();
    const names = skills.map((s) => s.name);
    expect(names).toContain("organize-workspace");
    expect(names).toContain("write-summary");
    expect(names).toContain("daily-notes");
  });

  it("loads a skill body", async () => {
    const skill = await loadSkill("write-summary");
    expect(skill.body).toContain("README");
  });
});
