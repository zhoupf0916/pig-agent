import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { updateAutomation } from "./automations.ts";
import type { InboxItem } from "../types.ts";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type InboxSnapshot = { items: InboxItem[]; unread: number };

describe("inbox refs after session / project delete (Milestone AX)", () => {
  const app = createApp();

  it("clears inbox sessionId after deleting that session (title/body stay; other rows untouched)", async () => {
    const project = await json<{ id: string; name: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "AX 会话转交项目" }),
      }),
    );
    const session = await json<{ id: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      }),
    );
    const keep = await json<{ id: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      }),
    );
    const goneHandoff = await json<{ inboxItem: InboxItem }>(
      await app.request(`/api/projects/${project.id}/handoffs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, note: "请接手已删会话。" }),
      }),
    );
    const keepHandoff = await json<{ inboxItem: InboxItem }>(
      await app.request(`/api/projects/${project.id}/handoffs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: keep.id, note: "请接手保留会话。" }),
      }),
    );
    const automation = await json<{ id: string; runtime: string }>(
      await app.request("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "AX 上次会话", prompt: "整理工作区" }),
      }),
    );
    await updateAutomation(automation.id, { lastSessionId: session.id });
    expect(goneHandoff.inboxItem.sessionId).toBe(session.id);
    expect(goneHandoff.inboxItem.kind).toBe("handoff");

    const deleted = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const inbox = await json<InboxSnapshot>(await app.request("/api/inbox"));
    const after = inbox.items.find((item) => item.id === goneHandoff.inboxItem.id);
    expect(after).toBeTruthy();
    expect(after?.sessionId).toBeUndefined();
    expect(after?.projectId).toBe(project.id);
    expect(after?.title).toBe(goneHandoff.inboxItem.title);
    expect(after?.body).toBe(goneHandoff.inboxItem.body);
    expect(after?.kind).toBe("handoff");
    expect(after?.read).toBe(false);
    expect(inbox.items.find((item) => item.id === keepHandoff.inboxItem.id)?.sessionId).toBe(keep.id);

    const still = await json<{ lastSessionId?: string; runtime: string }>(
      await app.request(`/api/automations/${automation.id}`),
    );
    expect(still.lastSessionId).toBeUndefined();
    expect(still.runtime).toBe("pig");
    expect(JSON.stringify(after)).not.toMatch(/sk-|Bearer |DEEPSEEK_API_KEY/);
  });

  it("removes inbox items for a deleted project (other projects + accept/ignore stay)", async () => {
    const gone = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "AX 已删项目" }),
      }),
    );
    const keep = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "AX 保留项目" }),
      }),
    );
    const session = await json<{ id: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: gone.id }),
      }),
    );
    const goneInvite = await json<{ inboxItem: InboxItem }>(
      await app.request(`/api/projects/${gone.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "小陈", note: "帮忙看 brief" }),
      }),
    );
    const goneHandoff = await json<{ inboxItem: InboxItem }>(
      await app.request(`/api/projects/${gone.id}/handoffs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, note: "请接手已删项目。" }),
      }),
    );
    const keepInvite = await json<{ inboxItem: InboxItem }>(
      await app.request(`/api/projects/${keep.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "小周", note: "继续协作" }),
      }),
    );
    expect(goneInvite.inboxItem.projectId).toBe(gone.id);
    expect(goneHandoff.inboxItem.projectId).toBe(gone.id);

    const deleted = await app.request(`/api/projects/${gone.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const inbox = await json<InboxSnapshot>(await app.request("/api/inbox"));
    expect(inbox.items.find((item) => item.id === goneInvite.inboxItem.id)).toBeUndefined();
    expect(inbox.items.find((item) => item.id === goneHandoff.inboxItem.id)).toBeUndefined();
    expect(inbox.items.some((item) => item.projectId === gone.id)).toBe(false);

    const remaining = inbox.items.find((item) => item.id === keepInvite.inboxItem.id);
    expect(remaining?.projectId).toBe(keep.id);
    expect(remaining?.inviteStatus).toBe("pending");
    expect(remaining?.kind).toBe("invite");

    const accepted = await app.request(`/api/inbox/${keepInvite.inboxItem.id}/accept`, { method: "POST" });
    expect(accepted.status).toBe(200);
    const afterAccept = await json<InboxSnapshot>(await app.request("/api/inbox"));
    expect(afterAccept.items.find((item) => item.id === keepInvite.inboxItem.id)?.inviteStatus).toBe(
      "accepted",
    );
    expect(JSON.stringify(inbox)).not.toMatch(/sk-|Bearer |DEEPSEEK_API_KEY/);
  });
});
