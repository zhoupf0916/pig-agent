import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Hono } from "hono";
import type { CloudEnv } from "./types.ts";
import { db, hash } from "./db.ts";
const id = (prefix: string) => prefix + "_" + randomUUID().replaceAll("-", "");
const role = z.enum(["viewer", "editor", "admin"]);
export function registerCollaborationRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/shared-projects/:id/runs", async (c) => {
    if (
      !(
        await db.query("SELECT project_access($1,$2,false) AS allowed", [
          c.req.param("id"),
          c.get("principal").id,
        ])
      ).rows[0].allowed
    )
      return c.json({ error: "共享项目不存在" }, 404);
    return c.json({
      runs: (
        await db.query(
          "SELECT id,project_id,state,error,created_at,owner_id,model_calls,input->>'prompt' AS prompt FROM runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100",
          [c.req.param("id")],
        )
      ).rows,
    });
  });
  app.get("/v1/spaces", async (c) =>
    c.json({
      spaces: (
        await db.query(
          "SELECT s.*,m.role FROM spaces s JOIN space_members m ON m.space_id=s.id WHERE m.principal_id=$1 ORDER BY s.created_at",
          [c.get("principal").id],
        )
      ).rows,
    }),
  );
  app.post("/v1/spaces", async (c) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "组织名称无效" }, 400);
    const client = await db.connect(),
      spaceId = id("space"),
      actor = c.get("principal").id;
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        actor,
      ]);
      if (
        Number(
          (
            await client.query(
              "SELECT count(*) FROM spaces WHERE owner_id=$1",
              [actor],
            )
          ).rows[0].count,
        ) >= 20
      ) {
        await client.query("ROLLBACK");
        return c.json({ error: "最多创建 20 个组织" }, 429);
      }
      await client.query(
        "INSERT INTO spaces(id,name,owner_id) VALUES($1,$2,$3)",
        [spaceId, body.data.name, actor],
      );
      await client.query("INSERT INTO space_members VALUES($1,$2,'admin')", [
        spaceId,
        actor,
      ]);
      await client.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
        actor,
        "space:create:" + spaceId,
      ]);
      await client.query("COMMIT");
      return c.json({ id: spaceId }, 201);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.post("/v1/spaces/join", async (c) => {
    const body = z
      .object({ invite: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "组织邀请码无效" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const invite = (
        await client.query(
          "DELETE FROM space_invitations WHERE token_hash=$1 AND expires_at>now() RETURNING *",
          [hash(body.data.invite)],
        )
      ).rows[0];
      if (!invite) {
        await client.query("ROLLBACK");
        return c.json({ error: "组织邀请已失效或已使用" }, 404);
      }
      await client.query("SELECT id FROM spaces WHERE id=$1 FOR UPDATE", [
        invite.space_id,
      ]);
      // Revoked administrators cannot leave usable outstanding invitations.
      const issuer = (
        await client.query(
          "SELECT m.role FROM space_members m JOIN principals p ON p.id=m.principal_id WHERE m.space_id=$1 AND m.principal_id=$2 AND p.enabled",
          [invite.space_id, invite.created_by],
        )
      ).rows[0];
      if (issuer?.role !== "admin") {
        await client.query("ROLLBACK");
        return c.json({ error: "邀请者权限已撤销" }, 403);
      }
      await client.query(
        "INSERT INTO space_members VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [invite.space_id, c.get("principal").id, invite.role],
      );
      await client.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
        c.get("principal").id,
        "space:join:" + invite.space_id,
      ]);
      await client.query("COMMIT");
      return c.json({ id: invite.space_id });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.get("/v1/spaces/:id/members", async (c) => {
    if (
      !(
        await db.query(
          "SELECT 1 FROM space_members WHERE space_id=$1 AND principal_id=$2",
          [c.req.param("id"), c.get("principal").id],
        )
      ).rowCount
    )
      return c.json({ error: "组织不存在" }, 404);
    return c.json({
      members: (
        await db.query(
          "SELECT p.id,p.name,p.enabled,m.role FROM space_members m JOIN principals p ON p.id=m.principal_id WHERE m.space_id=$1 ORDER BY p.name",
          [c.req.param("id")],
        )
      ).rows,
    });
  });
  app.post("/v1/spaces/:id/invitations", async (c) => {
    const body = z
      .object({ role })
      .strict()
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "成员角色无效" }, 400);
    const actor = c.get("principal").id;
    if (
      !(
        await db.query(
          "SELECT 1 FROM space_members WHERE space_id=$1 AND principal_id=$2 AND role='admin'",
          [c.req.param("id"), actor],
        )
      ).rowCount
    )
      return c.json({ error: "需要组织管理员权限" }, 403);
    const invite = randomBytes(32).toString("hex");
    await db.query(
      "INSERT INTO space_invitations VALUES($1,$2,$3,$4,now()+interval '24 hours')",
      [hash(invite), c.req.param("id"), body.data.role, actor],
    );
    await db.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
      actor,
      "space:invite:" + c.req.param("id"),
    ]);
    c.header("Cache-Control", "no-store");
    return c.json({ invite, expiresInHours: 24 }, 201);
  });
  app.on(["PATCH", "DELETE"], "/v1/spaces/:id/members/:member", async (c) => {
    const body =
      c.req.method === "PATCH"
        ? z
            .object({ role })
            .strict()
            .safeParse(await c.req.json())
        : null;
    if (body && !body.success) return c.json({ error: "成员角色无效" }, 400);
    const client = await db.connect(),
      spaceId = c.req.param("id"),
      actor = c.get("principal").id;
    try {
      await client.query("BEGIN");
      const space = (
        await client.query("SELECT * FROM spaces WHERE id=$1 FOR UPDATE", [
          spaceId,
        ])
      ).rows[0];
      if (
        !space ||
        !(
          await client.query(
            "SELECT 1 FROM space_members WHERE space_id=$1 AND principal_id=$2 AND role='admin'",
            [spaceId, actor],
          )
        ).rowCount
      ) {
        await client.query("ROLLBACK");
        return c.json({ error: "需要组织管理员权限" }, 403);
      }
      if (space.owner_id === c.req.param("member")) {
        await client.query("ROLLBACK");
        return c.json({ error: "不能移除或降级组织创建者" }, 409);
      }
      if (body?.success)
        await client.query(
          "UPDATE space_members SET role=$3 WHERE space_id=$1 AND principal_id=$2",
          [spaceId, c.req.param("member"), body.data.role],
        );
      else
        await client.query(
          "DELETE FROM space_members WHERE space_id=$1 AND principal_id=$2",
          [spaceId, c.req.param("member")],
        );
      await client.query(
        "DELETE FROM space_invitations WHERE space_id=$1 AND created_by=$2",
        [spaceId, c.req.param("member")],
      );
      await client.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
        actor,
        "space:membership:" + spaceId + ":" + c.req.param("member"),
      ]);
      await client.query("COMMIT");
      return c.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.get("/v1/shared-projects", async (c) =>
    c.json({
      projects: (
        await db.query(
          "SELECT p.*,s.name AS space_name,m.role FROM shared_projects p JOIN spaces s ON s.id=p.space_id JOIN space_members m ON m.space_id=s.id WHERE m.principal_id=$1 ORDER BY p.created_at DESC",
          [c.get("principal").id],
        )
      ).rows,
    }),
  );
  app.post("/v1/shared-projects", async (c) => {
    const body = z
      .object({
        spaceId: z.string().max(100),
        name: z.string().trim().min(1).max(100),
        description: z.string().max(4000).default(""),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "项目参数无效" }, 400);
    if (
      !(
        await db.query(
          "SELECT 1 FROM space_members WHERE space_id=$1 AND principal_id=$2 AND role IN ('editor','admin')",
          [body.data.spaceId, c.get("principal").id],
        )
      ).rowCount
    )
      return c.json({ error: "需要组织编辑权限" }, 403);
    const projectId = id("project");
    await db.query(
      "INSERT INTO shared_projects(id,space_id,name,description) VALUES($1,$2,$3,$4)",
      [projectId, body.data.spaceId, body.data.name, body.data.description],
    );
    await db.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
      c.get("principal").id,
      "project:create:" + projectId,
    ]);
    return c.json({ id: projectId }, 201);
  });
}
