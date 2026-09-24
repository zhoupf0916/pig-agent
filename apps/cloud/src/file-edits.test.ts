import { describe, expect, it } from "vitest";
import { workspaceFileRevision } from "@pig-agent/contracts";
import { applyConversationFileEdit, newerFileOverrides, readConversationFile } from "./file-edits.ts";

function memoryClient() {
  const edits = new Map<string, { content: string; revision: string; author_id: string; updated_at: string }>();
  const versions: Array<{ content: string; revision: string; author_id: string }> = [];
  const artifacts = new Map<string, string>([["notes.txt", "原始成果"]]);
  let checkpoint: { run_id: string; created_at: string; files: string[]; contents: Map<string, string> } | null = null;
  let canWrite = true;
  let busy = 0;
  let tail = Promise.resolve();
  const releases: Array<() => void> = [];
  return {
    edits,
    versions,
    setBusy(value: number) { busy = value; },
    setCanWrite(value: boolean) { canWrite = value; },
    setCheckpoint(value: { run_id: string; created_at: string; files: string[]; contents: Map<string, string> } | null) { checkpoint = value; },
    unlock() { releases.shift()?.(); },
    async query(sql: string, args: unknown[] = []) {
      if (sql.includes("principals") && sql.includes("FOR UPDATE")) return { rows: [{ id: args[0] }] };
      if (sql.includes("FROM conversations") && sql.includes("FOR UPDATE")) {
        const previous = tail;
        tail = new Promise((resolve) => { releases.push(resolve); });
        await previous;
        return { rows: [{ id: args[0], can_write: canWrite }] };
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("count(*)") && sql.includes("runs")) return { rows: [{ count: busy }] };
      if (sql.includes("workspace_versions")) return { rows: checkpoint ? [checkpoint] : [] };
      if (sql.includes("FROM workspace_file_edits")) {
        const row = edits.get(String(args[1]));
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("WHERE run_id=$1 AND path=$2")) {
        const content = checkpoint && checkpoint.run_id === args[0] ? checkpoint.contents.get(String(args[1])) : artifacts.get(String(args[1]));
        return { rows: content === undefined ? [] : [{ content }] };
      }
      if (sql.includes("FROM runs WHERE")) return { rows: [] };
      if (sql.includes("FROM artifacts")) return { rows: artifacts.has(String(args[1])) ? [{ content: artifacts.get(String(args[1])), run_id: "run_old" }] : [] };
      if (sql.includes("INSERT INTO workspace_file_edits")) {
        edits.set(String(args[1]), { content: String(args[2]), revision: String(args[3]), author_id: String(args[4]), updated_at: new Date().toISOString() });
        return { rows: [] };
      }
      if (sql.includes("workspace_file_edit_versions")) {
        versions.push({ content: String(args[3]), revision: String(args[4]), author_id: String(args[5]) });
        return { rows: [] };
      }
      throw new Error(sql);
    },
    releaseLock(result: { release?: () => void }) { result.release?.(); },
  };
}

describe("conversation file edits", () => {
  it("uses the real artifact revision for the first save and conflicts a second stale save", async () => {
    const client = memoryClient();
    const original = workspaceFileRevision("原始成果");
    const empty = workspaceFileRevision("");
    const missed = await applyConversationFileEdit(client, {
      conversationId: "conv", actorId: "alice", path: "notes.txt", content: "改", baseRevision: empty,
    });
    client.unlock();
    expect(missed).toMatchObject({ status: 409 });
    expect(client.edits.size).toBe(0);
    const saved = await applyConversationFileEdit(client, {
      conversationId: "conv", actorId: "alice", path: "notes.txt", content: "用户编辑", baseRevision: original,
    });
    client.unlock();
    expect(saved).toMatchObject({ path: "notes.txt" });
    const again = await applyConversationFileEdit(client, {
      conversationId: "conv", actorId: "alice", path: "notes.txt", content: "再改", baseRevision: original,
    });
    client.unlock();
    expect(again).toMatchObject({ status: 409 });
    expect(client.edits.get("notes.txt")?.content).toBe("用户编辑");
    await expect(readConversationFile(client, "conv", "notes.txt")).resolves.toMatchObject({
      content: "用户编辑",
      source: "edit",
    });
  });

  it("lets only one of two overlapping saves win", async () => {
    const client = memoryClient();
    const original = workspaceFileRevision("原始成果");
    const run = async (content: string) => {
      const result = await applyConversationFileEdit(client, {
        conversationId: "conv", actorId: "alice", path: "notes.txt", content, baseRevision: original,
      });
      client.unlock();
      return result;
    };
    const results = await Promise.all([run("甲"), run("乙")]);
    const ok = results.filter((item) => !("error" in item));
    const conflict = results.filter((item) => "status" in item && item.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(1);
    expect(client.edits.size).toBe(1);
  });

  it("reads the newer checkpoint instead of an older edit, and does not restore a deleted path", async () => {
    const client = memoryClient();
    const original = workspaceFileRevision("原始成果");
    const saved = await applyConversationFileEdit(client, {
      conversationId: "conv", actorId: "alice", path: "notes.txt", content: "人工稿", baseRevision: original,
    });
    client.unlock();
    expect(saved).toMatchObject({ path: "notes.txt" });
    client.setCheckpoint({
      run_id: "run_new",
      created_at: "2099-01-01T00:00:00.000Z",
      files: ["notes.txt"],
      contents: new Map([["notes.txt", "Agent 新稿"]]),
    });
    await expect(readConversationFile(client, "conv", "notes.txt")).resolves.toMatchObject({
      content: "Agent 新稿",
      revision: workspaceFileRevision("Agent 新稿"),
      source: "artifact",
    });
    const stale = await applyConversationFileEdit(client, {
      conversationId: "conv", actorId: "alice", path: "notes.txt", content: "再盖回去", baseRevision: original,
    });
    client.unlock();
    expect(stale).toMatchObject({ status: 409 });
    expect(client.edits.get("notes.txt")?.content).toBe("人工稿");
    client.setCheckpoint({
      run_id: "run_new",
      created_at: "2099-01-01T00:00:00.000Z",
      files: [],
      contents: new Map(),
    });
    await expect(readConversationFile(client, "conv", "notes.txt")).resolves.toMatchObject({ status: 404 });
    const revived = await applyConversationFileEdit(client, {
      conversationId: "conv", actorId: "alice", path: "notes.txt", content: "复活", baseRevision: workspaceFileRevision("Agent 新稿"),
    });
    client.unlock();
    expect(revived).toMatchObject({ status: 404 });
    expect(client.edits.get("notes.txt")?.content).toBe("人工稿");
  });

  it("rejects a writer without permission before revealing whether the file exists, and keeps the previous author", async () => {
    const client = memoryClient();
    client.setCanWrite(false);
    const denied = await applyConversationFileEdit(client, {
      conversationId: "conv", actorId: "bob", path: "notes.txt", content: "偷看", baseRevision: "abc",
    });
    client.unlock();
    const missing = await applyConversationFileEdit(client, {
      conversationId: "conv", actorId: "bob", path: "missing.txt", content: "偷看", baseRevision: "abc",
    });
    client.unlock();
    expect(denied).toEqual({ error: "当前权限不能编辑该文件", status: 403 });
    expect(missing).toEqual(denied);
    expect(client.edits.size).toBe(0);
    client.setCanWrite(true);
    const original = workspaceFileRevision("原始成果");
    await applyConversationFileEdit(client, {
      conversationId: "conv", actorId: "alice", path: "notes.txt", content: "甲稿", baseRevision: original,
    });
    client.unlock();
    const next = workspaceFileRevision("甲稿");
    await applyConversationFileEdit(client, {
      conversationId: "conv", actorId: "bob", path: "notes.txt", content: "乙稿", baseRevision: next,
    });
    client.unlock();
    expect(client.versions[0]?.author_id).toBe("alice");
    expect(client.edits.get("notes.txt")?.author_id).toBe("bob");
  });

  it("does not replay an edit older than the checkpoint over a later agent change", () => {
    const applied = newerFileOverrides(
      [{ path: "notes.txt", content: "人工稿", updatedAt: "2026-09-24T00:00:00.000Z" }],
      "2026-09-24T01:00:00.000Z",
    );
    expect(applied).toEqual([]);
    expect(newerFileOverrides(
      [{ path: "notes.txt", content: "之后的编辑", updatedAt: "2026-09-24T02:00:00.000Z" }],
      "2026-09-24T01:00:00.000Z",
    )).toEqual([{ path: "notes.txt", content: "之后的编辑" }]);
  });
});
