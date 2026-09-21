import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../config.ts";
import { parseAgentRuntime } from "../../store/settings.ts";
import {
  ENV_JSON_FILENAME,
  firstNonEmpty,
  loadCloudEnvJson,
  parseCloudEnvJson,
  resolveCloudRepoHint,
  resolveCloudRepoHintDetailed,
  resolveEffectiveCloudBaseUrl,
} from "./env-json.ts";
import { shouldSkipCloudHandoffName } from "./snapshot.ts";
import { inspectCloudStatus } from "./validate.ts";

function writeEnvJson(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pig-env-json-"));
  const path = join(dir, ENV_JSON_FILENAME);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe("parseCloudEnvJson", () => {
  it("reads the documented cloud object and ignores secrets", () => {
    expect(
      parseCloudEnvJson({
        cloud: {
          baseUrl: "http://127.0.0.1:8080",
          repoUrl: "https://github.com/acme/app.git",
          repoRef: "main",
          token: "must-not-load",
          cloudToken: "must-not-load",
        },
        PIG_CLOUD_TOKEN: "must-not-load",
        DEEPSEEK_API_KEY: "sk-must-not-load",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:8080",
      repoUrl: "https://github.com/acme/app.git",
      repoRef: "main",
    });
  });

  it("accepts top-level PIG_CLOUD_* aliases", () => {
    expect(
      parseCloudEnvJson({
        PIG_CLOUD_BASE_URL: "https://cp.example.com",
        PIG_CLOUD_REPO_URL: "https://example.com/app.git",
        PIG_CLOUD_REPO_REF: "dev",
        PIG_CLOUD_TOKEN: "ignore-me",
      }),
    ).toEqual({
      baseUrl: "https://cp.example.com",
      repoUrl: "https://example.com/app.git",
      repoRef: "dev",
    });
  });

  it("returns empty hints for invalid shapes", () => {
    expect(parseCloudEnvJson(null)).toEqual({});
    expect(parseCloudEnvJson("nope")).toEqual({});
    expect(parseCloudEnvJson([])).toEqual({});
  });
});

describe("loadCloudEnvJson", () => {
  it("loads a temp env.json and treats a missing file as not found", () => {
    const path = writeEnvJson({
      cloud: { repoUrl: "https://github.com/acme/app.git", repoRef: "main" },
    });
    expect(loadCloudEnvJson(path)).toMatchObject({
      found: true,
      path,
      hints: { repoUrl: "https://github.com/acme/app.git", repoRef: "main" },
    });
    expect(loadCloudEnvJson(join(path, "missing.json"))).toMatchObject({
      found: false,
      hints: {},
    });
  });

  it("swallows invalid JSON without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pig-env-json-bad-"));
    const path = join(dir, ENV_JSON_FILENAME);
    writeFileSync(path, "{not-json");
    expect(loadCloudEnvJson(path)).toEqual({ found: true, path, hints: {} });
  });
});

describe("cloud hint precedence", () => {
  it("uses Settings/UI over env.json over process env (per field)", () => {
    const settings = {
      cloudBaseUrl: "https://from-settings.example",
      cloudRepoUrl: "https://settings.example/app.git",
      cloudRepoRef: "",
    };
    const envJson = {
      baseUrl: "https://from-env-json.example",
      repoUrl: "https://envjson.example/app.git",
      repoRef: "from-json",
    };
    const env = {
      PIG_CLOUD_BASE_URL: "https://from-env.example",
      PIG_CLOUD_REPO_URL: "https://env.example/app.git",
      PIG_CLOUD_REPO_REF: "from-env",
    } as NodeJS.ProcessEnv;

    expect(resolveEffectiveCloudBaseUrl(settings, { envJson, env })).toBe(
      "https://from-settings.example",
    );
    expect(resolveCloudRepoHintDetailed({ settings, envJson, env })).toEqual({
      repoUrl: "https://settings.example/app.git",
      repoUrlSource: "settings",
      ref: "from-json",
      refSource: "env.json",
    });

    expect(
      resolveEffectiveCloudBaseUrl({ cloudBaseUrl: "" }, { envJson, env }),
    ).toBe("https://from-env-json.example");
    expect(
      resolveCloudRepoHint({
        settings: { cloudRepoUrl: "", cloudRepoRef: "" },
        envJson: {},
        env,
      }),
    ).toEqual({
      repoUrl: "https://env.example/app.git",
      ref: "from-env",
    });

    expect(
      resolveEffectiveCloudBaseUrl({ cloudBaseUrl: "  " }, { envJson: {}, env: {} }),
    ).toBe("");
  });

  it("does not let env.json change the default runtime", () => {
    expect(parseAgentRuntime(undefined)).toBe("pig");
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
    expect(firstNonEmpty("", undefined, "")).toBe("");
  });

  it("surfaces env.json hints on cloudStatus without requiring Settings fields", () => {
    const status = inspectCloudStatus(
      {
        ...DEFAULT_SETTINGS,
        runtime: "cloud",
        cloudMode: "remote",
        cloudBaseUrl: "",
        cloudToken: "",
      },
      {
        envJson: {
          baseUrl: "http://127.0.0.1:8080",
          repoUrl: "https://github.com/acme/app.git",
          repoRef: "main",
        },
        env: {},
      },
    );
    expect(status.envJson).toEqual({
      found: true,
      file: "env.json",
      baseUrl: "http://127.0.0.1:8080",
      repoUrl: "https://github.com/acme/app.git",
      repoRef: "main",
    });
    expect(status.effectiveBaseUrl).toBe("http://127.0.0.1:8080");
    expect(status.remoteUrlConfigured).toBe(true);
    expect(status.repoHint).toEqual({
      repoUrl: "https://github.com/acme/app.git",
      repoUrlSource: "env.json",
      ref: "main",
      refSource: "env.json",
    });
  });
});

describe("handoff skip rules stay secret-focused", () => {
  it("still skips .env* / keys and does not treat env.json as a secret name", () => {
    expect(shouldSkipCloudHandoffName(".env")).toBe(true);
    expect(shouldSkipCloudHandoffName(".env.local")).toBe(true);
    expect(shouldSkipCloudHandoffName("id_rsa")).toBe(true);
    expect(shouldSkipCloudHandoffName(ENV_JSON_FILENAME)).toBe(false);
    const workspace = mkdtempSync(join(tmpdir(), "pig-env-json-ws-"));
    mkdirSync(join(workspace, "notes"));
    writeFileSync(join(workspace, ".env"), "DEEPSEEK_API_KEY=sk-should-not-pack\n");
    writeFileSync(
      join(workspace, ENV_JSON_FILENAME),
      JSON.stringify({ cloud: { repoUrl: "https://github.com/acme/app.git" } }),
    );
    expect(shouldSkipCloudHandoffName(".env")).toBe(true);
    expect(shouldSkipCloudHandoffName(ENV_JSON_FILENAME)).toBe(false);
  });
});
