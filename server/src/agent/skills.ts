import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SKILLS_DIR } from "../config.ts";
import type { Skill, SkillMeta } from "../types.ts";

type Frontmatter = Record<string, string>;

export function parseFrontmatter(raw: string): {
  data: Frontmatter;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { data: {}, body: raw };
  }
  const rest = raw.slice(3);
  const end = rest.search(/\r?\n---\r?\n/);
  if (end === -1) {
    return { data: {}, body: raw };
  }
  const yaml = rest.slice(0, end).replace(/^\r?\n/, "");
  const body = rest.slice(end).replace(/^\r?\n---\r?\n/, "");
  const data: Frontmatter = {};
  for (const line of yaml.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) data[key] = value;
  }
  return { data, body: body.trimStart() };
}

export async function listSkills(): Promise<SkillMeta[]> {
  let names: string[] = [];
  try {
    names = (await readdir(SKILLS_DIR)).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const skills: SkillMeta[] = [];
  for (const filename of names.sort()) {
    const skill = await readSkillFile(filename);
    if (skill) {
      skills.push({
        name: skill.name,
        description: skill.description,
        filename: skill.filename,
      });
    }
  }
  return skills;
}

export async function loadSkill(name: string): Promise<Skill> {
  const skills = await listSkills();
  const match = skills.find(
    (s) => s.name === name || s.filename === name || s.filename === `${name}.md`,
  );
  if (!match) {
    throw new Error(`Skill not found: ${name}`);
  }
  const skill = await readSkillFile(match.filename);
  if (!skill) throw new Error(`Skill not found: ${name}`);
  return skill;
}

async function readSkillFile(filename: string): Promise<Skill | null> {
  const full = join(SKILLS_DIR, filename);
  let raw: string;
  try {
    raw = await readFile(full, "utf8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const name = data.name || filename.replace(/\.md$/, "");
  return {
    name,
    description: data.description || "",
    filename,
    body,
  };
}
