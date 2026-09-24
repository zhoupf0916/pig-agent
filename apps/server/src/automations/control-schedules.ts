import type { SkillSnapshot } from "@pig-agent/contracts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runSessionTurn } from "../agent/turn.ts";
import { DATA_DIR } from "../config.ts";
import { planeJson } from "../control-plane/client.ts";
import { createSession, saveSession } from "../store/sessions.ts";
import { newId, nowIso } from "../util.ts";

export type LocalScheduleDelivery = {
  scheduleId: string;
  prompt: string;
  scheduledAt: string;
  skillSnapshots?: SkillSnapshot[];
};

export async function deviceId(): Promise<string> {
  const file = join(DATA_DIR, "device-id");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch { /* first launch */ }
  const id = `dev_${randomUUID()}`;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, id);
  return id;
}

async function runLocalDelivery(item: LocalScheduleDelivery): Promise<void> {
  const session = await createSession();
  session.executionTarget = "local";
  session.engine = "pig";
  session.title = item.prompt.slice(0, 40);
  if (item.skillSnapshots?.length) {
    session.skillSnapshots = item.skillSnapshots;
    session.skillIds = item.skillSnapshots.map((skill) => skill.id);
  }
  session.messages.push({ id: newId("msg"), role: "user", content: item.prompt, createdAt: nowIso() });
  await saveSession(session);
  await runSessionTurn(session, { runtime: "pig" });
}

/** Control plane decides which device runs a local schedule. A lost claim is left for another device. */
export async function pullLocalSchedules(
  run: (item: LocalScheduleDelivery) => Promise<void> = runLocalDelivery,
): Promise<number> {
  let deliveries: LocalScheduleDelivery[] = [];
  try {
    deliveries = (await planeJson<{ deliveries: LocalScheduleDelivery[] }>("/v1/schedule-deliveries")).deliveries || [];
  } catch {
    return 0;
  }
  const device = await deviceId();
  let ran = 0;
  for (const item of deliveries) {
    const scheduledAt = new Date(item.scheduledAt).toISOString();
    try {
      await planeJson(`/v1/schedules/${item.scheduleId}/claim-device`, {
        method: "POST",
        body: JSON.stringify({ deviceId: device, scheduledAt }),
      });
    } catch {
      continue;
    }
    try {
      await run(item);
      await planeJson(`/v1/schedules/${item.scheduleId}/device-result`, {
        method: "POST",
        body: JSON.stringify({ deviceId: device, scheduledAt, ok: true }),
      });
      ran += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行失败";
      await planeJson(`/v1/schedules/${item.scheduleId}/device-result`, {
        method: "POST",
        body: JSON.stringify({ deviceId: device, scheduledAt, ok: false, error: message.slice(0, 500) }),
      }).catch(() => {});
    }
  }
  return ran;
}
