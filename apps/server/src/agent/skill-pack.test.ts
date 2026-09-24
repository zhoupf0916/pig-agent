import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { describe, expect, it } from "vitest";
import {
  parseSkillFrontmatter,
  skillActivationPrompt,
  skillContentDigest,
  skillMaterialPrefix,
  validateSkillName,
  validateSkillPackFiles,
} from "@pig-agent/contracts";
import { materializeSkillSnapshots } from "./skill-pack.ts";
import { importSkillPack } from "./skills.ts";

const SCRIPT = "print('ONLY_ON_DISK_MARKER')\n";

describe("skill pack contract", () => {
  it("rejects names that break the public skill spec", () => {
    expect(validateSkillName("data-analysis")).toBeNull();
    expect(validateSkillName("-data")).toMatch(/连字符/);
    expect(validateSkillName("data-")).toMatch(/连字符/);
    expect(validateSkillName("data--analysis")).toMatch(/连续/);
    expect(validateSkillName("Data")).toMatch(/小写/);
    expect(validateSkillName("a".repeat(65))).toMatch(/64/);
  });

  it("reads multiline YAML and a Chinese display name", () => {
    const parsed = parseSkillFrontmatter(`---
name: data-analysis
description: |
  汇总表格。
  在用户给出 CSV 时使用。
metadata:
  display-name: 数据分析
allowed-tools: run_shell read_file
---

先读 references/metrics.md。
`);
    expect(parsed.name).toBe("data-analysis");
    expect(parsed.description).toBe("汇总表格。\n在用户给出 CSV 时使用。");
    expect(parsed.displayName).toBe("数据分析");
    expect(parsed.allowedTools).toEqual(["run_shell", "read_file"]);
    expect(parsed.body).toContain("references/metrics.md");
  });

  it("rejects traversal, absolute paths, duplicates, and oversized packs", () => {
    expect(
      validateSkillPackFiles([{ path: "../secrets.py", content: "x" }])?.message,
    ).toMatch(/相对路径/);
    expect(
      validateSkillPackFiles([{ path: "/tmp/x.py", content: "x" }])?.message,
    ).toMatch(/相对路径/);
    expect(
      validateSkillPackFiles([
        { path: "scripts/a.py", content: "a" },
        { path: "scripts/a.py", content: "b" },
      ])?.message,
    ).toMatch(/重复/);
    expect(
      validateSkillPackFiles([{ path: "scripts/a.py", content: "x".repeat(70_000) }])
        ?.message,
    ).toMatch(/体积/);
  });

  it("puts only the skill instructions in the prompt and leaves file bytes out", () => {
    const skill = {
      id: "data-analysis",
      name: "data-analysis",
      displayName: "数据分析",
      description: "汇总表格",
      body: "需要时再读脚本。",
      allowedTools: ["run_shell"],
      files: [{ path: "scripts/profile_csv.py", content: SCRIPT }],
    };
    const text = skillActivationPrompt([skill]);
    expect(text).toContain("需要时再读脚本");
    expect(text).toContain(`${skillMaterialPrefix(skill)}/scripts/profile_csv.py`);
    expect(text).not.toContain("ONLY_ON_DISK_MARKER");
    expect(text).toContain("不扩大");
  });

  it("gives metadata-only skill versions different content digests", () => {
    const base = {
      id: "data-analysis",
      name: "data-analysis",
      displayName: "数据分析",
      description: "汇总表格",
      allowedTools: ["read_file"],
      body: "同一正文",
      files: [{ path: "scripts/profile_csv.py", content: SCRIPT }],
    };
    expect(skillContentDigest({ ...base, description: "另一口径" })).not.toBe(skillContentDigest(base));
    expect(skillContentDigest({ ...base, displayName: "表格汇总" })).not.toBe(skillContentDigest(base));
    expect(skillContentDigest({ ...base, allowedTools: ["run_shell"] })).not.toBe(skillContentDigest(base));
  });
});

describe("skill pack import", () => {
  it("keeps an existing pack when a second import loses the rename", async () => {
    const skill = `---\nname: import-race\ndescription: 汇总表格\nmetadata:\n  display-name: 导入竞赛\n---\n\n先读脚本。\n`;
    const first = await importSkillPack([
      { path: "SKILL.md", content: skill },
      { path: "scripts/profile_csv.py", content: "print('kept')\n" },
    ]);
    expect(first.displayName).toBe("导入竞赛");
    expect(first.name).toBe("import-race");
    const results = await Promise.allSettled([
      importSkillPack([{ path: "SKILL.md", content: skill.replace("先读脚本", "后来的") }]),
      importSkillPack([{ path: "SKILL.md", content: skill.replace("先读脚本", "另一个") }]),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(await readFile(join(DATA_DIR, "skills/import-race/scripts/profile_csv.py"), "utf8")).toBe(
      "print('kept')\n",
    );
    expect(await readFile(join(DATA_DIR, "skills/import-race/SKILL.md"), "utf8")).toContain("先读脚本");
  });
});

describe("skill pack materialization", () => {
  it("writes pack files into the workspace and does not run them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pig-skill-"));
    const snapshot = {
      id: "data-analysis",
      name: "data-analysis",
      displayName: "数据分析",
      description: "汇总",
      body: "看脚本。",
      files: [
        { path: "scripts/profile_csv.py", content: SCRIPT },
        { path: "references/metrics.md", content: "列口径\n" },
      ],
    };
    await materializeSkillSnapshots(root, [snapshot]);
    const prefix = skillMaterialPrefix(snapshot);
    const script = await readFile(join(root, prefix, "scripts/profile_csv.py"), "utf8");
    expect(script).toBe(SCRIPT);
    expect(await readFile(join(root, prefix, "SKILL.md"), "utf8")).toContain("看脚本");
    expect(await readFile(join(root, prefix, "references/metrics.md"), "utf8")).toContain("列口径");
  });

  it("refuses to write a snapshot that escapes the skill directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pig-skill-"));
    await mkdir(join(root, "keep"), { recursive: true });
    await writeFile(join(root, "keep/safe.txt"), "stay");
    await expect(
      materializeSkillSnapshots(root, [
        {
          id: "data-analysis",
          name: "data-analysis",
          description: "汇总",
          body: "正文",
          files: [{ path: "../../keep/safe.txt", content: "pwned" }],
        },
      ]),
    ).rejects.toThrow(/路径/);
    expect(await readFile(join(root, "keep/safe.txt"), "utf8")).toBe("stay");
  });
});
