import type { Hono } from "hono";
import {
  ArtifactSaveError,
  saveAllSessionArtifactsToProject,
  saveSessionArtifactToProject,
} from "../store/artifacts-to-project.ts";
import { getSession } from "../store/sessions.ts";

function fail(err: unknown): { error: string; status: 400 | 404 | 409 } {
  if (err instanceof ArtifactSaveError) {
    return { error: err.message, status: err.status };
  }
  return { error: err instanceof Error ? err.message : String(err), status: 400 };
}

async function loadBoundSession(id: string) {
  const session = await getSession(id);
  if (!session) return { error: "Session not found" as const, status: 404 as const };
  return { session };
}

export function registerArtifactRoutes(app: Hono): void {
  app.post("/api/sessions/:id/artifacts/save-all-to-project", async (c) => {
    const loaded = await loadBoundSession(c.req.param("id"));
    if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
    const body = (await c.req.json().catch(() => ({}))) as { paths?: unknown };
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : undefined;
    try {
      const result = await saveAllSessionArtifactsToProject(loaded.session, { paths });
      return c.json(result);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.post("/api/sessions/:id/artifacts/save-to-project", async (c) => {
    const loaded = await loadBoundSession(c.req.param("id"));
    if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; name?: unknown };
    const name =
      (typeof body.path === "string" && body.path.trim()) ||
      (typeof body.name === "string" && body.name.trim()) ||
      "";
    if (!name) return c.json({ error: "artifact path is required" }, 400);
    try {
      const result = await saveSessionArtifactToProject(loaded.session, name);
      return c.json(result);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.post("/api/sessions/:id/artifacts/:name/save-to-project", async (c) => {
    const loaded = await loadBoundSession(c.req.param("id"));
    if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown };
    const name =
      (typeof body.path === "string" && body.path.trim()) || c.req.param("name");
    try {
      const result = await saveSessionArtifactToProject(loaded.session, name);
      return c.json(result);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });
}
