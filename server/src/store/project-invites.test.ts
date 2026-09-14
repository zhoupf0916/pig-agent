import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { formatInviteInboxBody } from "./projects.ts";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type InviteInbox = {
  id: string;
  kind: string;
  read: boolean;
  projectId: string;
  projectName?: string;
  inviterName?: string;
  inviteeName?: string;
  inviteNote?: string;
  inviteId?: string;
  inviteToken?: string;
  inviteStatus?: string;
};

type ProjectBody = {
  id: string;
  members: Array<{ id: string; displayName: string; role: string }>;
  invites: Array<{
    id: string;
    token: string;
    displayName: string;
    note?: string;
    status: string;
  }>;
};

describe("project invites (Milestone J3)", () => {
  const app = createApp();

  it("formats inbox body with inviter, note, and token", () => {
    expect(
      formatInviteInboxBody({
        inviterName: "本机用户",
        inviteeName: "小陈",
        projectName: "调研组",
        note: "帮忙看 brief",
        token: "inv_abc",
      }),
    ).toBe("本机用户 邀请 小陈 加入「调研组」\n帮忙看 brief\n令牌：inv_abc");
  });

  it("creates a pending invite, accepts/declines, redeems, and protects the owner", async () => {
    const created = await json<ProjectBody>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "J3 邀请组" }),
      }),
    );
    expect(created.members).toHaveLength(1);
    expect(created.members[0]?.role).toBe("owner");
    expect(created.invites ?? []).toHaveLength(0);

    const inviteRes = await app.request(`/api/projects/${created.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "小陈", note: "帮忙看 brief" }),
    });
    expect(inviteRes.status).toBe(201);
    const invited = await json<{
      inviteToken: string;
      invite: { id: string; status: string; displayName: string };
      inboxItem: InviteInbox;
    }>(inviteRes);
    expect(invited.inviteToken.startsWith("inv_")).toBe(true);
    expect(invited.invite.status).toBe("pending");
    expect(invited.inboxItem.kind).toBe("invite");
    expect(invited.inboxItem.read).toBe(false);
    expect(invited.inboxItem.projectId).toBe(created.id);
    expect(invited.inboxItem.projectName).toBe("J3 邀请组");
    expect(invited.inboxItem.inviterName).toBe("本机用户");
    expect(invited.inboxItem.inviteeName).toBe("小陈");
    expect(invited.inboxItem.inviteNote).toBe("帮忙看 brief");
    expect(invited.inboxItem.inviteId).toBe(invited.invite.id);
    expect(invited.inboxItem.inviteToken).toBe(invited.inviteToken);

    const listed = await json<{
      members: unknown[];
      pendingInvites: Array<{ displayName: string }>;
    }>(await app.request(`/api/projects/${created.id}/members`));
    expect(listed.pendingInvites.some((i) => i.displayName === "小陈")).toBe(true);

    const inbox = await json<{ items: InviteInbox[]; unread: number }>(await app.request("/api/inbox"));
    const inboxInvite = inbox.items.find((i) => i.inviteId === invited.invite.id);
    expect(inboxInvite).toBeTruthy();
    expect(inbox.unread).toBeGreaterThan(0);

    const accepted = await app.request(`/api/inbox/${inboxInvite!.id}/accept`, { method: "POST" });
    expect(accepted.status).toBe(200);
    const acceptedBody = await json<{
      member: { displayName: string; role: string };
      invite: { status: string };
      item: { inviteStatus?: string; read: boolean };
    }>(accepted);
    expect(acceptedBody.member.displayName).toBe("小陈");
    expect(acceptedBody.member.role).toBe("member");
    expect(acceptedBody.invite.status).toBe("accepted");
    expect(acceptedBody.item.inviteStatus).toBe("accepted");
    expect(acceptedBody.item.read).toBe(true);

    const again = await app.request(`/api/inbox/${inboxInvite!.id}/accept`, { method: "POST" });
    expect(again.status).toBe(200);
    const afterAccept = await json<ProjectBody>(await app.request(`/api/projects/${created.id}`));
    expect(afterAccept.members.filter((m) => m.displayName === "小陈")).toHaveLength(1);
    expect(afterAccept.invites.find((i) => i.id === invited.invite.id)?.status).toBe("accepted");

    const second = await json<{ inviteToken: string; inboxItem: InviteInbox; invite: { id: string } }>(
      await app.request(`/api/projects/${created.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "小周", note: "先看看待办" }),
      }),
    );
    const declined = await app.request(`/api/inbox/${second.inboxItem.id}/decline`, { method: "POST" });
    expect(declined.status).toBe(200);
    const afterDecline = await json<ProjectBody>(await app.request(`/api/projects/${created.id}`));
    expect(afterDecline.members.some((m) => m.displayName === "小周")).toBe(false);
    expect(afterDecline.invites.find((i) => i.id === second.invite.id)?.status).toBe("declined");

    const third = await json<{ inviteToken: string; invite: { id: string } }>(
      await app.request(`/api/projects/${created.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "兑换同学" }),
      }),
    );
    const redeem = await app.request(`/api/projects/${created.id}/invites/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: third.inviteToken }),
    });
    expect(redeem.status).toBe(200);
    const redeemAgain = await app.request(`/api/projects/${created.id}/invites/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: third.inviteToken }),
    });
    expect(redeemAgain.status).toBe(200);
    const afterRedeem = await json<ProjectBody>(await app.request(`/api/projects/${created.id}`));
    expect(afterRedeem.members.filter((m) => m.displayName === "兑换同学")).toHaveLength(1);

    const fourth = await json<{ invite: { id: string } }>(
      await app.request(`/api/projects/${created.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "待撤销" }),
      }),
    );
    const revoked = await app.request(`/api/projects/${created.id}/invites/${fourth.invite.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    const afterRevoke = await json<ProjectBody>(await app.request(`/api/projects/${created.id}`));
    expect(afterRevoke.invites.find((i) => i.id === fourth.invite.id)?.status).toBe("revoked");
    expect(afterRevoke.members.some((m) => m.displayName === "待撤销")).toBe(false);

    const owner = created.members[0]!;
    const removeOwner = await app.request(`/api/projects/${created.id}/members/${owner.id}`, {
      method: "DELETE",
    });
    expect(removeOwner.status).toBe(400);
    const still = await json<ProjectBody>(await app.request(`/api/projects/${created.id}`));
    expect(still.members.some((m) => m.role === "owner")).toBe(true);

    const missing = await app.request(`/api/projects/${created.id}/invites/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "inv_nope" }),
    });
    expect(missing.status).toBe(404);
    expect((await json<{ error: string }>(missing)).error).toContain("无效或已失效");

    const expired = await app.request(`/api/projects/${created.id}/invites/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: second.inviteToken }),
    });
    expect(expired.status).toBe(400);
    expect((await json<{ error: string }>(expired)).error).toContain("已失效");
  });

  it("keeps handoff inbox items working and rejects accept on them", async () => {
    const created = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "J3 转交共存" }),
      }),
    );
    const session = await json<{ id: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: created.id }),
      }),
    );
    const handoff = await app.request(`/api/projects/${created.id}/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, note: "请接手 J3。" }),
    });
    expect(handoff.status).toBe(201);
    const body = await json<{
      inboxItem: { id: string; kind: string; body: string; sessionId?: string; projectName?: string };
    }>(handoff);
    expect(body.inboxItem.kind).toBe("handoff");
    expect(body.inboxItem.sessionId).toBe(session.id);
    expect(body.inboxItem.body).toContain("请接手 J3。");
    expect(body.inboxItem.projectName).toBe("J3 转交共存");

    const acceptHandoff = await app.request(`/api/inbox/${body.inboxItem.id}/accept`, { method: "POST" });
    expect(acceptHandoff.status).toBe(400);

    const read = await app.request(`/api/inbox/${body.inboxItem.id}/read`, { method: "POST" });
    expect(read.status).toBe(200);
  });
});
