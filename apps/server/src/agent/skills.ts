import { pluginSkills } from "../store/plugins.ts";
import { readdir, readFile, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  parseSkillFrontmatter,
  validateSkillName,
  validateSkillPackFiles,
  validateSkillUpload,
  type SkillPackFile,
  type SkillSnapshot,
} from "@pig-agent/contracts";
import { DATA_DIR, SKILLS_DIR } from "../config.ts";
import type { Skill, SkillMeta } from "../types.ts";

const USER_SKILLS_DIR = join(DATA_DIR, "skills");

export async function assertKnownSkillIds(ids: string[]): Promise<void> {
  const known = new Set((await listSkills()).map((skill) => skill.name));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new Error(`所选技能不存在：${missing.join("、")}`);
}

export async function snapshotSkills(ids: string[]): Promise<SkillSnapshot[]> {
  await assertKnownSkillIds(ids);
  const snapshots: SkillSnapshot[] = [];
  for (const id of ids) snapshots.push(skillToSnapshot(await loadSkill(id)));
  return snapshots;
}

export function skillToSnapshot(skill: Skill): SkillSnapshot {
  const candidates = [skill.machineName, skill.name, skill.name.replaceAll("_", "-")].filter((item): item is string => Boolean(item));
  const name = candidates.find((item) => validateSkillName(item) === null);
  if (!name) throw new Error("技能标识不符合规范，不能作为技能包 name");
  return {
    id: skill.name,
    name,
    displayName: skill.displayName,
    description: skill.description,
    body: skill.body,
    allowedTools: skill.allowedTools,
    files: skill.files ?? [],
  };
}

export async function importSkillPack(files: SkillPackFile[]): Promise<Skill> {
  const skillFile = files.find((file) => file.path === "SKILL.md");
  if (!skillFile) throw new Error("技能包必须包含 SKILL.md");
  const parsed = parseSkillFrontmatter(skillFile.content);
  const invalid = validateSkillUpload(files);
  if (invalid) throw new Error(invalid.message);
  const resources = files.filter((file) => file.path !== "SKILL.md");
  if ((await listSkills()).some((skill) => skill.name === parsed.name))
    throw new Error("同名技能已存在，请修改标识");
  await mkdir(USER_SKILLS_DIR, { recursive: true });
  const staging = join(USER_SKILLS_DIR, `.import-${randomUUID()}`);
  const dir = join(USER_SKILLS_DIR, parsed.name);
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, "SKILL.md"), skillFile.content, { mode: 0o600 });
    for (const file of resources) {
      const target = join(staging, file.path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, file.content, { mode: 0o600 });
    }
    await rename(staging, dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY")
      throw new Error("同名技能已存在，请修改标识");
    throw error;
  }
  return {
    name: parsed.name,
    displayName: parsed.displayName,
    description: parsed.description,
    filename: `${parsed.name}/SKILL.md`,
    body: parsed.body,
    allowedTools: parsed.allowedTools,
    files: resources,
  };
}

export async function saveUserSkill(input: { name: string; description: string; body: string; displayName?: string }): Promise<Skill> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.name)) throw new Error("技能标识只能包含小写字母、数字和连字符");
  const displayName = input.displayName?.trim();
  if (displayName && displayName.length > 40) throw new Error("中文展示名不能超过 40 个字符");
  if ((await listSkills()).some(skill => skill.name === input.name || skill.filename === `${input.name}.md`)) throw new Error("同名技能已存在，请修改标识");
  await mkdir(USER_SKILLS_DIR, { recursive: true });
  const filename = `${input.name}.md`;
  const description = input.description.replace(/[\r\n]/g, " ");
  const meta = displayName ? `metadata:\n  display-name: ${displayName.replace(/[\r\n]/g, " ")}\n` : "";
  await writeFile(join(USER_SKILLS_DIR, filename), `---\nname: ${input.name}\ndescription: ${description}\n${meta}---\n\n${input.body}\n`, { flag: "wx", mode: 0o600 });
  return { ...input, displayName: displayName || undefined, description, filename };
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

async function skillFilenames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) names.push(entry.name);
    else if (entry.isDirectory()) names.push(`${entry.name}/SKILL.md`);
  }
  return names;
}

export async function listSkills(): Promise<SkillMeta[]> {
  const names = [...new Set((await Promise.all([SKILLS_DIR, USER_SKILLS_DIR].map(skillFilenames))).flat())];
  const skills: SkillMeta[] = [];
  for (const filename of names.sort()) {
    const skill = await readSkillFile(filename);
    if (skill) {
      skills.push({
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        filename: skill.filename,
        keywords: skill.keywords,
        filePaths: skill.files?.map((file) => file.path),
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

async function readPackFiles(dir: string): Promise<SkillPackFile[]> {
  const files: SkillPackFile[] = [];
  for (const folder of ["scripts", "references", "assets"] as const) {
    const entries = await readdir(join(dir, folder)).catch(() => [] as string[]);
    for (const name of entries) {
      files.push({
        path: `${folder}/${name}`,
        content: await readFile(join(dir, folder, name), "utf8"),
      });
    }
  }
  return validateSkillPackFiles(files) ? [] : files;
}

async function readExisting(paths: string[]): Promise<{ raw: string; path: string } | null> {
  for (const path of paths) {
    try {
      return { raw: await readFile(path, "utf8"), path };
    } catch {
      // try the next location
    }
  }
  return null;
}

async function readSkillFile(filename: string): Promise<Skill | null> {
  const packed = filename.endsWith("/SKILL.md");
  const found = await readExisting([
    join(USER_SKILLS_DIR, filename),
    join(SKILLS_DIR, filename),
  ]);
  if (!found) return null;
  const raw = found.raw;
  const packDir = packed ? join(found.path, "..") : "";
  const { data, body } = parseFrontmatter(raw);
  let parsed: ReturnType<typeof parseSkillFrontmatter> | undefined;
  try {
    parsed = parseSkillFrontmatter(raw);
  } catch {
    parsed = undefined;
  }
  if (packed && (!parsed || `${parsed.name}/SKILL.md` !== filename)) return null;
  const name = parsed?.name || data.name || filename.replace(/\.md$/, "");
  const keywords = (data.keywords ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name,
    displayName: parsed?.displayName,
    description: parsed?.description || data.description || "",
    filename,
    body: parsed?.body ?? body,
    allowedTools: parsed?.allowedTools,
    keywords: keywords.length ? keywords : undefined,
    files: packDir ? await readPackFiles(packDir) : undefined,
  };
}
