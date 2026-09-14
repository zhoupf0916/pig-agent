import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ensureDir } from "../config.ts";
import type { AgentRuntime, Automation } from "../types.ts";
import { atomicWriteJson, newId, nowIso } from "../util.ts";
import { isScheduleDue, validateSchedule } from "./cron.ts";

const DIR = join(DATA_DIR, "automations");
const RUNTIMES = new Set<AgentRuntime>(["pig", "codex", "cloud"]);

export function automationFile(id: string): string {
  return join(DIR, `${id}.json`);
}

export function assertSafeAutomationId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed || !/^[a-zA-Z0-9_-]{2,80}$/.test(trimmed)) {
    throw new Error("Invalid automation id");
  }
  return trimmed;
}

function normalizeAutomation(raw: Automation): Automation {
  const runtime = RUNTIMES.has(raw.runtime) ? raw.runtime : "pig";
  let schedule: string | null = null;
  try {
    schedule = validateSchedule(raw.schedule);
  } catch {
    schedule = null;
  }
  return {
    ...raw,
    name: raw.name?.trim() || "未命名自动化",
    enabled: Boolean(raw.enabled),
    prompt: raw.prompt ?? "",
    schedule,
    runtime,
    expertId:
      typeof raw.expertId === "string" && raw.expertId.trim() ? raw.expertId.trim() : undefined,
    expertTeamId:
      typeof raw.expertTeamId === "string" && raw.expertTeamId.trim()
        ? raw.expertTeamId.trim()
        : undefined,
    projectId:
      typeof raw.projectId === "string" && raw.projectId.trim() ? raw.projectId.trim() : undefined,
    lastRunAt:
      typeof raw.lastRunAt === "string" && raw.lastRunAt.trim() ? raw.lastRunAt.trim() : undefined,
    lastSessionId:
      typeof raw.lastSessionId === "string" && raw.lastSessionId.trim()
        ? raw.lastSessionId.trim()
        : undefined,
    lastError:
      typeof raw.lastError === "string" && raw.lastError.trim() ? raw.lastError.trim() : undefined,
  };
}

async function readAutomationFile(id: string): Promise<Automation | null> {
  const file = automationFile(id);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Automation;
    return normalizeAutomation(raw);
  } catch {
    return null;
  }
}

async function writeAutomation(automation: Automation): Promise<Automation> {
  automation.updatedAt = nowIso();
  ensureDir(DIR);
  await atomicWriteJson(automationFile(automation.id), automation);
  return automation;
}

export type AutomationInput = {
  name: string;
  prompt: string;
  enabled?: boolean;
  schedule?: string | null;
  expertId?: string | null;
  expertTeamId?: string | null;
  projectId?: string | null;
  runtime?: AgentRuntime;
};

function applyPins(
  target: Automation,
  input: {
    expertId?: string | null;
    expertTeamId?: string | null;
    projectId?: string | null;
  },
): void {
  if (input.expertId === null) delete target.expertId;
  else if (typeof input.expertId === "string") {
    const id = input.expertId.trim();
    if (id) target.expertId = id;
    else delete target.expertId;
  }
  if (input.expertTeamId === null) delete target.expertTeamId;
  else if (typeof input.expertTeamId === "string") {
    const id = input.expertTeamId.trim();
    if (id) target.expertTeamId = id;
    else delete target.expertTeamId;
  }
  if (input.projectId === null) delete target.projectId;
  else if (typeof input.projectId === "string") {
    const id = input.projectId.trim();
    if (id) target.projectId = id;
    else delete target.projectId;
  }
}

export async function createAutomation(input: AutomationInput): Promise<Automation> {
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt is required");
  const schedule = validateSchedule(input.schedule);
  const ts = nowIso();
  const automation: Automation = {
    id: newId("atm"),
    name,
    enabled: input.enabled ?? true,
    prompt,
    schedule,
    runtime: input.runtime && RUNTIMES.has(input.runtime) ? input.runtime : "pig",
    createdAt: ts,
    updatedAt: ts,
  };
  applyPins(automation, input);
  return writeAutomation(automation);
}

export async function listAutomations(): Promise<Automation[]> {
  ensureDir(DIR);
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
  const out: Automation[] = [];
  for (const file of files) {
    const automation = await readAutomationFile(file.replace(/\.json$/, ""));
    if (automation) out.push(automation);
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export async function getAutomation(id: string): Promise<Automation | null> {
  try {
    return await readAutomationFile(assertSafeAutomationId(id));
  } catch {
    return null;
  }
}

export async function updateAutomation(
  id: string,
  patch: Partial<AutomationInput> & {
    lastRunAt?: string | null;
    lastSessionId?: string | null;
    lastError?: string | null;
  },
): Promise<Automation | null> {
  const automation = await getAutomation(id);
  if (!automation) return null;
  if (typeof patch.name === "string" && patch.name.trim()) automation.name = patch.name.trim();
  if (typeof patch.prompt === "string") {
    const prompt = patch.prompt.trim();
    if (!prompt) throw new Error("prompt is required");
    automation.prompt = prompt;
  }
  if (typeof patch.enabled === "boolean") automation.enabled = patch.enabled;
  if (patch.schedule !== undefined) automation.schedule = validateSchedule(patch.schedule);
  if (patch.runtime && RUNTIMES.has(patch.runtime)) automation.runtime = patch.runtime;
  applyPins(automation, patch);
  if (patch.lastRunAt === null) delete automation.lastRunAt;
  else if (typeof patch.lastRunAt === "string" && patch.lastRunAt.trim()) {
    automation.lastRunAt = patch.lastRunAt.trim();
  }
  if (patch.lastSessionId === null) delete automation.lastSessionId;
  else if (typeof patch.lastSessionId === "string" && patch.lastSessionId.trim()) {
    automation.lastSessionId = patch.lastSessionId.trim();
  }
  if (patch.lastError === null) delete automation.lastError;
  else if (typeof patch.lastError === "string") {
    const err = patch.lastError.trim();
    if (err) automation.lastError = err;
    else delete automation.lastError;
  }
  return writeAutomation(automation);
}

export async function deleteAutomation(id: string): Promise<boolean> {
  const automation = await getAutomation(id);
  if (!automation) return false;
  await unlink(automationFile(automation.id));
  return true;
}

export function automationIsDue(automation: Automation, now: Date): boolean {
  if (!automation.enabled) return false;
  return isScheduleDue({
    schedule: automation.schedule,
    lastRunAt: automation.lastRunAt,
    createdAt: automation.createdAt,
    now,
  });
}

export async function recordAutomationRun(
  id: string,
  result: { sessionId: string; error?: string | null },
): Promise<Automation | null> {
  return updateAutomation(id, {
    lastRunAt: nowIso(),
    lastSessionId: result.sessionId,
    lastError: result.error ?? null,
  });
}
