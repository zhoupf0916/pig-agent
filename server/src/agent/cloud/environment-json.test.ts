import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../config.ts";
import { parseAgentRuntime } from "../../store/settings.ts";
import { createCloudControlApp } from "./control-stub.ts";
import {
  hasInstallHints,
  loadInstallHints,
  parseInstallHints,
} from "./environment-json.ts";
import { buildCreateRunRequest, buildRemoteWorkspaceHandoff } from "./request.ts";
import { packWorkspaceSnapshot } from "./snapshot.ts";
import type { Session, Settings } from "../../types.ts";

function settingsFor(workspaceRoot: string): Settings {
  return {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "sk-host-control-path-secret",
    llmModel: "deepseek-chat",
    workspaceRoot,
    runtime: "cloud",
    codexBinaryPath: "",
    codexModel: "deepseek-flash",
    codexNetworkAccess: false,
    cloudBaseUrl: "",
    cloudToken: "cp-token-must-not-leak",
    cloudMode: "remote",
  };
}

function emptySession(): Session {
  return {
    id: "ses_env",
    title: "env",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [
      {
        id: "u1",
        role: "user",
        content: "整理工作区",
        createdAt: new Date().toISOString(),
      },
    ],
    steps: [],
    artifacts: [],
  };
}

describe("parseInstallHints", () => {
  it("reads Cursor-style install / deps / tools / setup and drops secrets", () => {
    expect(
      parseInstallHints({
        install: "pnpm install",
        deps: ["node>=20", "pnpm"],
        tools: ["git"],
        setup: ["pnpm install"],
        env: { DEEPSEEK_API_KEY: "sk-must-not-load" },
        token: "must-not-load",
        apiKey: "sk-must-not-load",
      }),
    ).toEqual({
      install: "pnpm install",
      deps: ["node>=20", "pnpm"],
      tools: ["git"],
      setup: ["pnpm install"],
    });
  });

  it("drops install/setup strings that look like provider keys", () => {
    expect(
      parseInstallHints({
        install: "export DEEPSEEK_API_KEY=sk-abcdefghijklmnop && pnpm install",
        setup: ["echo sk-abcdefghijklmnop"],
        deps: ["node>=20", "sk-abcdefghijklmnop"],
      }),
    ).toEqual({ deps: ["node>=20"] });
  });

  it("accepts a nested environment object", () => {
    expect(
      parseInstallHints({
        environment: { install: "pnpm install", tools: ["git"] },
      }),
    ).toEqual({ install: "pnpm install", tools: ["git"] });
  });
});

describe("load + ship install hints", () => {
  it("loads workspace environment.json and attaches it to create-run without secrets", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pig-env-install-"));
    writeFileSync(join(workspace, "ok.md"), "visible");
    writeFileSync(join(workspace, ".env"), "DEEPSEEK_API_KEY=sk-should-not-pack\n");
    writeFileSync(
      join(workspace, "environment.json"),
      JSON.stringify({
        install: "pnpm install",
        deps: ["node>=20"],
        tools: ["git"],
        setup: ["pnpm install"],
        PIG_CLOUD_TOKEN: "must-not-ship",
      }),
    );
    const loaded = loadInstallHints({ workspaceRoot: workspace, projectRoot: workspace });
    expect(loaded.found).toBe(true);
    expect(loaded.file).toBe("environment.json");
    expect(loaded.hints).toEqual({
      install: "pnpm install",
      deps: ["node>=20"],
      tools: ["git"],
      setup: ["pnpm install"],
    });

    const settings = settingsFor(workspace);
    const body = buildCreateRunRequest(
      emptySession(),
      settings,
      buildRemoteWorkspaceHandoff(settings),
    );
    expect(body.workspace?.installHints).toEqual(loaded.hints);
    expect(body.workspace?.snapshot?.files).toContain("environment.json");
    expect(body.workspace?.snapshot?.files?.some((f) => f.includes(".env"))).toBe(false);
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain("sk-host-control-path-secret");
    expect(dumped).not.toContain("cp-token-must-not-leak");
    expect(dumped).not.toContain("sk-should-not-pack");
    expect(dumped).not.toContain("must-not-ship");
  });

  it("does not change the default pig runtime", () => {
    expect(parseAgentRuntime(undefined)).toBe("pig");
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
    expect(hasInstallHints({})).toBe(false);
  });
});

describe("control plane reads install hints", () => {
  it("prefers shipped installHints and can also read environment.json from the snapshot", async () => {
    const source = mkdtempSync(join(tmpdir(), "pig-install-src-"));
    writeFileSync(join(source, "readme.md"), "hello");
    writeFileSync(
      join(source, "environment.json"),
      JSON.stringify({ install: "pnpm install", deps: ["pnpm"] }),
    );
    const snapshot = packWorkspaceSnapshot(source);
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-install-runs-"));
    const { app, runs } = createCloudControlApp({ runsRoot });

    const shipped = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "整理工作区",
        sessionId: "ses_1",
        workspace: {
          snapshot,
          installHints: { install: "pnpm typecheck", tools: ["git"] },
        },
      }),
    });
    expect(shipped.status).toBe(200);
    const shippedId = ((await shipped.json()) as { id: string }).id;
    expect(runs.get(shippedId)?.installHints).toEqual({
      install: "pnpm typecheck",
      tools: ["git"],
    });
    const shippedEvents = await (await app.request(`/v1/runs/${shippedId}/events`)).text();
    expect(shippedEvents).toContain("install pnpm typecheck");
    expect(shippedEvents).not.toContain("sk-");

    const readOnly = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "再来一轮",
        sessionId: "ses_2",
        workspace: { snapshot },
      }),
    });
    const readId = ((await readOnly.json()) as { id: string }).id;
    expect(runs.get(readId)?.installHints).toEqual({
      install: "pnpm install",
      deps: ["pnpm"],
    });
    expect(runs.get(readId)?.files).toContain("environment.json");
  });

  it("never materializes provider keys into a worker env file", async () => {
    const source = mkdtempSync(join(tmpdir(), "pig-install-nokey-"));
    mkdirSync(join(source, "notes"));
    writeFileSync(join(source, "environment.json"), JSON.stringify({ install: "pnpm install" }));
    writeFileSync(join(source, ".env"), "DEEPSEEK_API_KEY=sk-should-not-copy\n");
    const snapshot = packWorkspaceSnapshot(source);
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-install-runs-nokey-"));
    const { app, runs } = createCloudControlApp({ runsRoot });
    const created = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "go",
        workspace: { snapshot, installHints: { install: "pnpm install" } },
      }),
    });
    const id = ((await created.json()) as { id: string }).id;
    const run = runs.get(id);
    expect(run?.files.some((f) => f.includes(".env"))).toBe(false);
    expect(run?.installHints).toEqual({ install: "pnpm install" });
    expect(JSON.stringify(run)).not.toContain("sk-should-not-copy");
  });
});
