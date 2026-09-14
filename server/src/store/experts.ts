import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ensureDir } from "../config.ts";
import type { Expert, ExpertKind, ExpertTeam, ExpertTeamMode } from "../types.ts";
import { atomicWriteJson, newId, nowIso } from "../util.ts";
import { BUNDLED_EXPERTS, BUNDLED_TEAMS } from "./bundled-experts.ts";

const DIR = join(DATA_DIR, "experts");
const TEAMS_DIR = join(DIR, "teams");

const KINDS = new Set<ExpertKind>(["scout", "plan", "implement", "review", "custom"]);
const MODES = new Set<ExpertTeamMode>(["chain", "parallel"]);

export function expertFile(id: string): string {
  return join(DIR, `${id}.json`);
}

export function teamFile(id: string): string {
  return join(TEAMS_DIR, `${id}.json`);
}

export function assertSafeId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed || !/^[a-zA-Z0-9_-]{2,80}$/.test(trimmed)) {
    throw new Error("Invalid expert id");
  }
  return trimmed;
}

function normalizeExpert(raw: Expert): Expert {
  const skillIds = Array.isArray(raw.skillIds)
    ? raw.skillIds.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const kind = KINDS.has(raw.kind) ? raw.kind : "custom";
  return {
    ...raw,
    name: raw.name?.trim() || "未命名专家",
    description: raw.description ?? "",
    instruction: raw.instruction ?? "",
    kind,
    skillIds,
    bundled: Boolean(raw.bundled),
  };
}

function normalizeTeam(raw: ExpertTeam): ExpertTeam {
  const expertIds = Array.isArray(raw.expertIds)
    ? raw.expertIds.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const mode = MODES.has(raw.mode) ? raw.mode : "chain";
  return {
    ...raw,
    name: raw.name?.trim() || "未命名小队",
    description: raw.description ?? "",
    mode,
    expertIds,
    bundled: Boolean(raw.bundled),
  };
}

async function readExpertFile(id: string): Promise<Expert | null> {
  const file = expertFile(id);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Expert;
    return normalizeExpert(raw);
  } catch {
    return null;
  }
}

async function readTeamFile(id: string): Promise<ExpertTeam | null> {
  const file = teamFile(id);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as ExpertTeam;
    return normalizeTeam(raw);
  } catch {
    return null;
  }
}

async function writeExpert(expert: Expert): Promise<Expert> {
  expert.updatedAt = nowIso();
  ensureDir(DIR);
  await atomicWriteJson(expertFile(expert.id), expert);
  return expert;
}

async function writeTeam(team: ExpertTeam): Promise<ExpertTeam> {
  team.updatedAt = nowIso();
  ensureDir(TEAMS_DIR);
  await atomicWriteJson(teamFile(team.id), team);
  return team;
}

export async function ensureBundledExperts(): Promise<void> {
  ensureDir(DIR);
  ensureDir(TEAMS_DIR);
  for (const expert of BUNDLED_EXPERTS) {
    if (!existsSync(expertFile(expert.id))) {
      await atomicWriteJson(expertFile(expert.id), expert);
    }
  }
  for (const team of BUNDLED_TEAMS) {
    if (!existsSync(teamFile(team.id))) {
      await atomicWriteJson(teamFile(team.id), team);
    }
  }
}

export async function listExperts(): Promise<Expert[]> {
  await ensureBundledExperts();
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
  const out: Expert[] = [];
  for (const file of files) {
    const expert = await readExpertFile(file.replace(/\.json$/, ""));
    if (expert) out.push(expert);
  }
  out.sort((a, b) => {
    if (a.bundled !== b.bundled) return a.bundled ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
  return out;
}

export async function getExpert(id: string): Promise<Expert | null> {
  await ensureBundledExperts();
  try {
    return await readExpertFile(assertSafeId(id));
  } catch {
    return null;
  }
}

export async function createExpert(input: {
  name: string;
  description?: string;
  instruction: string;
  kind?: ExpertKind;
  skillIds?: string[];
}): Promise<Expert> {
  await ensureBundledExperts();
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  const instruction = input.instruction.trim();
  if (!instruction) throw new Error("instruction is required");
  const ts = nowIso();
  const expert: Expert = {
    id: newId("exp"),
    name,
    description: (input.description ?? "").trim(),
    instruction,
    kind: input.kind && KINDS.has(input.kind) ? input.kind : "custom",
    skillIds: (input.skillIds ?? []).map((s) => s.trim()).filter(Boolean),
    bundled: false,
    createdAt: ts,
    updatedAt: ts,
  };
  return writeExpert(expert);
}

export async function updateExpert(
  id: string,
  patch: {
    name?: string;
    description?: string;
    instruction?: string;
    kind?: ExpertKind;
    skillIds?: string[];
  },
): Promise<Expert | null> {
  const expert = await getExpert(id);
  if (!expert) return null;
  if (typeof patch.name === "string" && patch.name.trim()) expert.name = patch.name.trim();
  if (typeof patch.description === "string") expert.description = patch.description.trim();
  if (typeof patch.instruction === "string") expert.instruction = patch.instruction;
  if (patch.kind && KINDS.has(patch.kind)) expert.kind = patch.kind;
  if (Array.isArray(patch.skillIds)) {
    expert.skillIds = patch.skillIds.map((s) => s.trim()).filter(Boolean);
  }
  return writeExpert(expert);
}

export async function deleteExpert(id: string): Promise<"ok" | "missing" | "bundled"> {
  const expert = await getExpert(id);
  if (!expert) return "missing";
  if (expert.bundled) return "bundled";
  await unlink(expertFile(expert.id));
  return "ok";
}

export async function listExpertTeams(): Promise<ExpertTeam[]> {
  await ensureBundledExperts();
  const files = (await readdir(TEAMS_DIR)).filter((f) => f.endsWith(".json"));
  const out: ExpertTeam[] = [];
  for (const file of files) {
    const team = await readTeamFile(file.replace(/\.json$/, ""));
    if (team) out.push(team);
  }
  out.sort((a, b) => {
    if (a.bundled !== b.bundled) return a.bundled ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
  return out;
}

export async function getExpertTeam(id: string): Promise<ExpertTeam | null> {
  await ensureBundledExperts();
  try {
    return await readTeamFile(assertSafeId(id));
  } catch {
    return null;
  }
}

export async function createExpertTeam(input: {
  name: string;
  description?: string;
  mode?: ExpertTeamMode;
  expertIds: string[];
}): Promise<ExpertTeam> {
  await ensureBundledExperts();
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  const expertIds = input.expertIds.map((s) => s.trim()).filter(Boolean);
  if (expertIds.length === 0) throw new Error("expertIds is required");
  const ts = nowIso();
  const team: ExpertTeam = {
    id: newId("team"),
    name,
    description: (input.description ?? "").trim(),
    mode: input.mode && MODES.has(input.mode) ? input.mode : "chain",
    expertIds,
    bundled: false,
    createdAt: ts,
    updatedAt: ts,
  };
  return writeTeam(team);
}

export async function updateExpertTeam(
  id: string,
  patch: {
    name?: string;
    description?: string;
    mode?: ExpertTeamMode;
    expertIds?: string[];
  },
): Promise<ExpertTeam | null> {
  const team = await getExpertTeam(id);
  if (!team) return null;
  if (typeof patch.name === "string" && patch.name.trim()) team.name = patch.name.trim();
  if (typeof patch.description === "string") team.description = patch.description.trim();
  if (patch.mode && MODES.has(patch.mode)) team.mode = patch.mode;
  if (Array.isArray(patch.expertIds)) {
    team.expertIds = patch.expertIds.map((s) => s.trim()).filter(Boolean);
  }
  return writeTeam(team);
}

export async function deleteExpertTeam(id: string): Promise<"ok" | "missing" | "bundled"> {
  const team = await getExpertTeam(id);
  if (!team) return "missing";
  if (team.bundled) return "bundled";
  await unlink(teamFile(team.id));
  return "ok";
}

function formatExpertBlock(expert: Expert): string {
  const skills =
    expert.skillIds.length > 0
      ? `\nPreferred local skills (already installed; load_skill if needed): ${expert.skillIds.join(", ")}`
      : "";
  return `### ${expert.name} (${expert.kind})\n${expert.instruction.trim()}${skills}`;
}

/**
 * Resolve the playbook text for a session.
 * If `expertId` is set, that expert wins (active role).
 * Else if `expertTeamId` is set, concatenate member instructions in team order.
 */
export async function resolveExpertPlaybook(input: {
  expertId?: string;
  expertTeamId?: string;
}): Promise<{
  instruction?: string;
  skillIds: string[];
  expert?: Expert;
  team?: ExpertTeam;
}> {
  await ensureBundledExperts();
  const skillIds: string[] = [];
  let expert: Expert | undefined;
  let team: ExpertTeam | undefined;

  if (input.expertTeamId) {
    team = (await getExpertTeam(input.expertTeamId)) ?? undefined;
  }

  if (input.expertId) {
    expert = (await getExpert(input.expertId)) ?? undefined;
    if (expert) {
      skillIds.push(...expert.skillIds);
      return {
        instruction: formatExpertBlock(expert),
        skillIds: [...new Set(skillIds)],
        expert,
        team,
      };
    }
  }

  if (team) {
    const blocks: string[] = [];
    for (const id of team.expertIds) {
      const member = await getExpert(id);
      if (!member) continue;
      skillIds.push(...member.skillIds);
      blocks.push(formatExpertBlock(member));
    }
    if (blocks.length === 0) return { skillIds: [], team };
    const header =
      team.mode === "parallel"
        ? `Expert team 「${team.name}」 (parallel metadata — apply all roles as joint guidance; this runtime still runs one agent):`
        : `Expert team 「${team.name}」 (chain metadata — apply roles in order as joint guidance; this runtime still runs one agent):`;
    return {
      instruction: `${header}\n\n${blocks.join("\n\n")}`,
      skillIds: [...new Set(skillIds)],
      team,
    };
  }

  return { skillIds: [] };
}
