import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { skillMaterialPrefix, type SkillSnapshot } from "@pig-agent/contracts";
import { createSession, getSession } from "../store/sessions.ts";
import { saveSettings } from "../store/settings.ts";
import { isTurnActive, prepareUserMessage, runSessionTurn } from "./turn.ts";

const snapshot: SkillSnapshot = {
  id: "audit-pack",
  name: "audit-pack",
  description: "验证",
  body: "只读资料",
  files: [],
};

describe("skill staging failure ends the turn", () => {
  it("does not leave the session running when materializing a skill symlink fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pig-turn-stage-"));
    const prefix = skillMaterialPrefix(snapshot);
    await mkdir(join(root, prefix), { recursive: true });
    await writeFile(join(root, "important.txt"), "original");
    await symlink(join(root, "important.txt"), join(root, prefix, "SKILL.md"));
    await saveSettings({ workspaceRoot: root, runtime: "pig" });
    const session = await createSession();
    session.executionTarget = "local";
    session.engine = "pig";
    session.skillIds = [snapshot.id];
    session.skillSnapshots = [snapshot];
    prepareUserMessage(session, "运行技能");
    const { saveSession } = await import("../store/sessions.ts");
    await saveSession(session);
    const finished = await runSessionTurn(session, { runtime: "pig" });
    expect(finished.status).not.toBe("running");
    expect(finished.lastError).toMatch(/符号链接/);
    expect(isTurnActive(session.id)).toBe(false);
    const stored = await getSession(session.id);
    expect(stored?.status).not.toBe("running");
    expect(stored?.lastError).toMatch(/符号链接/);
  });
});
