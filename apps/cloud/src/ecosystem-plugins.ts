import {
  ECOSYSTEM_CATALOG,
  catalogPlugin,
  type InstalledPlugin,
  type PluginManifest,
} from "@pig-agent/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { CloudEnv } from "./types.ts";
import { db } from "./db.ts";

export const ecosystemPluginSchema = `CREATE TABLE IF NOT EXISTS cloud_plugins (
 owner_id text NOT NULL REFERENCES principals(id),
 plugin_id text NOT NULL,
 manifest jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 installed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,plugin_id)
);`;
type Client = Pick<typeof db, "query">;
export async function listCloudPlugins(
  owner: string,
  client: Client = db,
): Promise<InstalledPlugin[]> {
  const { rows } = await client.query(
    "SELECT manifest,enabled,installed_at FROM cloud_plugins WHERE owner_id=$1 ORDER BY installed_at,plugin_id",
    [owner],
  );
  return rows.map((row) => ({
    manifest: row.manifest as PluginManifest,
    enabled: row.enabled,
    installedAt: new Date(row.installed_at).toISOString(),
  }));
}
export async function pluginCapabilities(
  owner: string,
  kind: "expert" | "skill",
  client: Client = db,
) {
  const installed = (await listCloudPlugins(owner, client)).filter(
    (item) => item.enabled,
  );
  if (kind === "expert")
    return installed.flatMap(({ manifest, installedAt }) => {
      const prefix = `plugin_${manifest.id}_`;
      return manifest.experts.map((expert) => ({
        ...expert,
        id: prefix + expert.id,
        skillIds: expert.skillIds.map((id) => prefix + id),
        description: `${manifest.name} · ${expert.description}`,
        kind: "custom",
        bundled: true,
        createdAt: installedAt,
        updatedAt: installedAt,
      }));
    });
  return installed.flatMap(({ manifest, installedAt }) =>
    manifest.skills.map((skill) => ({
      ...skill,
      id: `plugin_${manifest.id}_${skill.id}`,
      machineName: skill.id,
      displayName: skill.name,
      description: `${manifest.name} · ${skill.description}`,
      bundled: true,
      createdAt: installedAt,
      updatedAt: installedAt,
    })),
  );
}
export function registerEcosystemPluginRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/plugins/catalog", (c) => c.json({ catalog: ECOSYSTEM_CATALOG }));
  app.get("/v1/plugins", async (c) =>
    c.json({ plugins: await listCloudPlugins(c.get("principal").id) }),
  );
  app.post("/v1/plugins/catalog/:id", async (c) => {
    const pack = catalogPlugin(c.req.param("id"));
    if (!pack) return c.json({ error: "内置插件不存在" }, 404);
    const { purpose: _purpose, ...content } = pack;
    const manifest: PluginManifest = { format: "pig-plugin-v1", ...content };
    const owner = c.get("principal").id;
    const inserted = await db.query(
      "INSERT INTO cloud_plugins(owner_id,plugin_id,manifest) VALUES($1,$2,$3) ON CONFLICT(owner_id,plugin_id) DO NOTHING RETURNING plugin_id",
      [owner, pack.id, manifest],
    );
    if (!inserted.rows.length)
      return c.json({ error: "插件已安装，现有内容未被覆盖" }, 409);
    return c.json({ plugins: await listCloudPlugins(owner) }, 201);
  });
  app.patch("/v1/plugins/:id", async (c) => {
    const input = z
      .object({ enabled: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "请提供有效的启用状态" }, 400);
    const owner = c.get("principal").id;
    const updated = await db.query(
      "UPDATE cloud_plugins SET enabled=$3 WHERE owner_id=$1 AND plugin_id=$2 RETURNING plugin_id",
      [owner, c.req.param("id"), input.data.enabled],
    );
    if (!updated.rows.length) return c.json({ error: "插件不存在" }, 404);
    return c.json({ plugins: await listCloudPlugins(owner) });
  });
  app.delete("/v1/plugins/:id", async (c) => {
    const owner = c.get("principal").id,
      id = c.req.param("id");
    const removed = await db.query(
      "DELETE FROM cloud_plugins WHERE owner_id=$1 AND plugin_id=$2 AND enabled=false RETURNING plugin_id",
      [owner, id],
    );
    if (!removed.rows.length) {
      const exists = (await listCloudPlugins(owner)).some(
        (item) => item.manifest.id === id,
      );
      return c.json(
        { error: exists ? "请先停用插件再移除" : "插件不存在" },
        exists ? 409 : 404,
      );
    }
    return c.json({ plugins: await listCloudPlugins(owner) });
  });
}
