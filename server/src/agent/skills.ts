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
        keywords: skill.keywords,
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

export type ScoredSkill = SkillMeta & { score: number; reasons: string[] };

/**
 * Score installed skills against a user task using name tokens,
 * optional frontmatter keywords, and description words.
 */
export function suggestSkills(task: string, skills: SkillMeta[], limit = 3): ScoredSkill[] {
  const tokens = tokenize(task);
  if (tokens.size === 0) return [];
  const scored: ScoredSkill[] = [];
  for (const skill of skills) {
    const reasons: string[] = [];
    let score = 0;
    const nameTokens = tokenize(skill.name.replace(/-/g, " "));
    for (const t of nameTokens) {
      if (tokens.has(t) || [...tokens].some((u) => u.includes(t) || t.includes(u))) {
        score += 4;
        reasons.push(t);
      }
    }
    for (const kw of skill.keywords ?? []) {
      const k = kw.toLowerCase().trim();
      if (!k) continue;
      if ([...tokens].some((t) => t.includes(k) || k.includes(t) || task.toLowerCase().includes(k))) {
        score += 5;
        reasons.push(k);
      }
    }
    const descTokens = tokenize(skill.description);
    for (const t of descTokens) {
      if (t.length < 4) continue;
      if (tokens.has(t)) {
        score += 1;
        reasons.push(t);
      }
    }
    if (score > 0) scored.push({ ...skill, score, reasons: [...new Set(reasons)] });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.filter((s) => s.score >= 3).slice(0, limit);
}

export async function loadSuggestedSkills(task: string): Promise<{
  suggested: ScoredSkill[];
  loaded: Skill[];
}> {
  const metas = await listSkills();
  const suggested = suggestSkills(task, metas, 2);
  const loaded: Skill[] = [];
  for (const item of suggested) {
    try {
      loaded.push(await loadSkill(item.name));
    } catch {
      // skip
    }
  }
  return { suggested, loaded };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2),
  );
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
  const keywords = (data.keywords ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name,
    description: data.description || "",
    filename,
    body,
    keywords: keywords.length ? keywords : undefined,
  };
}
