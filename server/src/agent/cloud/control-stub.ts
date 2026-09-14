import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../../util.ts";
import type { CloudInstallHints } from "./contract.ts";
import { hasInstallHints, loadInstallHints, parseInstallHints } from "./environment-json.ts";
import { extractWorkspaceSnapshot } from "./snapshot.ts";

export type CloudStubRun = {
  id: string;
  sessionId: string;
  status: "idle" | "running" | "aborted" | "expired";
  prompts: string[];
  files: string[];
  skipped: string[];
  repoUrl?: string;
  ref?: string;
  installHints?: CloudInstallHints;
};

export type CloudControlStub = {
  app: Hono;
  runs: Map<string, CloudStubRun>;
};

/**
 * In-repo control-plane stub: create-run (snapshot / repo hint) → SSE → follow-up / abort.
 * Keys must not appear in request bodies; the stub never stores provider secrets.
 */
export function createCloudControlApp(options: { runsRoot?: string } = {}): CloudControlStub {
  const runs = new Map<string, CloudStubRun>();
  const app = new Hono();

  app.post("/v1/runs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      prompt?: string;
      sessionId?: string;
      workspace?: {
        snapshot?: {
          encoding?: string;
          data?: string;
          files?: string[];
          skipped?: string[];
          byteSize?: number;
        };
        repoUrl?: string;
        ref?: string;
        installHints?: CloudInstallHints;
      };
    };
    const id = newId("run");
    const files: string[] = [];
    const skipped = Array.isArray(body.workspace?.snapshot?.skipped)
      ? body.workspace.snapshot.skipped
      : [];

    if (body.workspace?.snapshot?.data) {
      if (options.runsRoot) {
        const dest = join(options.runsRoot, id, "workspace");
        mkdirSync(dest, { recursive: true });
        try {
          files.push(
            ...extractWorkspaceSnapshot(
              {
                encoding: "tar.gz",
                data: body.workspace.snapshot.data,
                files: body.workspace.snapshot.files ?? [],
                skipped,
                byteSize: body.workspace.snapshot.byteSize ?? 0,
              },
              dest,
            ),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return c.json({ error: message }, 400);
        }
      } else {
        files.push(...(body.workspace.snapshot.files ?? []));
      }
    }

    const shipped = parseInstallHints(body.workspace?.installHints ?? {});
    const dest = options.runsRoot ? join(options.runsRoot, id, "workspace") : "";
    const fromSnapshot = dest
      ? loadInstallHints({ workspaceRoot: dest, projectRoot: dest }).hints
      : {};
    const installHints = hasInstallHints(shipped) ? shipped : fromSnapshot;

    const run: CloudStubRun = {
      id,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
      status: "idle",
      prompts: [typeof body.prompt === "string" ? body.prompt : ""],
      files,
      skipped,
      repoUrl: body.workspace?.repoUrl,
      ref: body.workspace?.ref,
      ...(hasInstallHints(installHints) ? { installHints } : {}),
    };
    runs.set(id, run);
    return c.json({ id, status: "running" });
  });

  app.get("/v1/runs/:id/events", (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run || run.status === "expired") {
      return c.json({ error: "run not found" }, 404);
    }
    const prompt = run.prompts[run.prompts.length - 1] ?? "";
    const followUp = run.prompts.length > 1;
    return streamSSE(c, async (stream) => {
      run.status = "running";
      await stream.writeSSE({
        event: "run.started",
        data: JSON.stringify({ type: "run.started" }),
      });
      const repoBit = run.repoUrl ? `; repo ${run.repoUrl}${run.ref ? `@${run.ref}` : ""}` : "";
      const installBit = run.installHints?.install
        ? `; install ${run.installHints.install}`
        : run.installHints
          ? `; install hints`
          : "";
      const content = followUp
        ? `[stub] follow-up: ${prompt}`
        : `[stub] accepted workspace (${run.files.length} files${repoBit}${installBit}): ${prompt}`;
      await stream.writeSSE({
        data: JSON.stringify({ type: "assistant.message", content }),
      });
      run.status = "idle";
      await stream.writeSSE({ data: JSON.stringify({ type: "run.idle" }) });
    });
  });

  app.post("/v1/runs/:id/follow-ups", async (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run || run.status === "expired") {
      return c.json({ error: "run expired" }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as { prompt?: string };
    run.prompts.push(typeof body.prompt === "string" ? body.prompt : "");
    run.status = "running";
    return c.json({ ok: true, id: run.id, status: "running" });
  });

  app.post("/v1/runs/:id/abort", async (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    run.status = "aborted";
    return c.json({ ok: true });
  });

  return { app, runs };
}

export async function startCloudControlStub(options: {
  port?: number;
  runsRoot?: string;
} = {}): Promise<{
  url: string;
  close: () => Promise<void>;
  runs: Map<string, CloudStubRun>;
}> {
  const { app, runs } = createCloudControlApp(options);
  return new Promise((resolve, reject) => {
    try {
      const server = serve(
        {
          fetch: app.fetch,
          hostname: "127.0.0.1",
          port: options.port ?? 0,
        },
        (info) => {
          resolve({
            url: `http://127.0.0.1:${info.port}`,
            runs,
            close: () =>
              new Promise((r) => {
                server.close(() => r());
              }),
          });
        },
      );
    } catch (err) {
      reject(err);
    }
  });
}
