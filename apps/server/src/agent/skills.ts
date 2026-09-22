import { pluginSkills } from "../store/plugins.ts";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, SKILLS_DIR } from "../config.ts";
import type { Skill, SkillMeta } from "../types.ts";

const USER_SKILLS_DIR = join(DATA_DIR, "skills");

export async function saveUserSkill(input: { name: string; description: string; body: string }): Promise<Skill> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.name)) throw new Error("技能标识只能包含小写字母、数字和连字符");
  if ((await listSkills()).some(skill => skill.name === input.name || skill.filename === `${input.name}.md`)) throw new Error("同名技能已存在，请修改标识");
  await mkdir(USER_SKILLS_DIR, { recursive: true });
  const filename = `${input.name}.md`;
  const description = input.description.replace(/[\r\n]/g, " ");
  await writeFile(join(USER_SKILLS_DIR, filename), `---\nname: ${input.name}\ndescription: ${description}\n---\n\n${input.body}\n`, { flag: "wx", mode: 0o600 });
  return { ...input, description, filename };
}

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
  const directories = await Promise.all([SKILLS_DIR, USER_SKILLS_DIR].map(dir => readdir(dir).catch(() => [] as string[])));
  const names = [...new Set(directories.flat().filter(n => n.endsWith(".md")))];
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
  for (const skill of await pluginSkills()) {
    if (!skills.some(existing => existing.name === skill.name || existing.filename === skill.filename)) {
      const { body: _body, ...meta } = skill;
      skills.push(meta);
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
  const plugin = (await pluginSkills()).find(skill => skill.filename === match.filename);
  if (plugin) return plugin;
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
    raw = await readFile(join(USER_SKILLS_DIR, filename), "utf8").catch(() => readFile(full, "utf8"));
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
