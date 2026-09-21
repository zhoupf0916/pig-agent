import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArtifactBytes } from "./artifacts-to-project.ts";
import { loadSettings, normalizeSettings } from "./settings.ts";
vi.mock("./settings.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings.ts")>()),
  loadSettings: vi.fn(),
}));
const base = "http://127.0.0.1:18881";
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetcher);
  vi.mocked(loadSettings).mockResolvedValue(
    normalizeSettings({ cloudBaseUrl: base, cloudToken: "account-a" }),
  );
});
afterEach(() => vi.unstubAllGlobals());
describe("remote artifact project copy", () => {
  it("copies authorized remote bytes even when a different local file has the same name", async () => {
    const root = await mkdtemp(join(tmpdir(), "pig-artifact-source-"));
    try {
      await writeFile(join(root, "same.txt"), "LOCAL_SENTINEL");
      fetcher
        .mockResolvedValueOnce(
          Response.json({
            artifacts: [{ id: "version-a", path: "same.txt", size: 6 }],
          }),
        )
        .mockResolvedValueOnce(new Response("REMOTE"));
      const bytes = await readArtifactBytes(root, {
        path: "same.txt",
        action: "created",
        updatedAt: "",
        source: { kind: "remote", runId: "run_a", artifactId: "version-a" },
      });
      expect(bytes.toString()).toBe("REMOTE");
      expect(await readFile(join(root, "same.txt"), "utf8")).toBe(
        "LOCAL_SENTINEL",
      );
      expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
        base + "/v1/runs/run_a/artifacts",
        base + "/v1/runs/run_a/artifacts/version-a",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("works with no host file and preserves explicit historical run", async () => {
    fetcher
      .mockResolvedValueOnce(
        Response.json({
          artifacts: [{ id: "older", path: "absent.txt", size: 3 }],
        }),
      )
      .mockResolvedValueOnce(new Response("OLD"));
    const bytes = await readArtifactBytes("/no-such-host-folder", {
      path: "absent.txt",
      action: "created",
      updatedAt: "",
      source: { kind: "remote", runId: "run_old", artifactId: "older" },
    });
    expect(bytes.toString()).toBe("OLD");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      base + "/v1/runs/run_old/artifacts",
    );
  });
  it("does not substitute another version when an artifact ID is absent", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({ artifacts: [{ id: "new", path: "same.txt", size: 3 }] }),
    );
    await expect(
      readArtifactBytes("/", {
        path: "same.txt",
        action: "created",
        updatedAt: "",
        source: { kind: "remote", runId: "run_a", artifactId: "old" },
      }),
    ).rejects.toThrow("local files were not used");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not read local bytes when remote authorization fails", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({ error: "Not found" }, { status: 404 }),
    );
    await expect(
      readArtifactBytes("/", {
        path: "same.txt",
        action: "created",
        updatedAt: "",
        source: { kind: "remote", runId: "run_a" },
      }),
    ).rejects.toThrow("Not found");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("pins endpoint and credentials while settings change between metadata and file reads", async () => {
    const settings = normalizeSettings({
      cloudBaseUrl: base,
      cloudToken: "account-a",
    });
    vi.mocked(loadSettings).mockImplementation(async () => settings);
    fetcher
      .mockImplementationOnce(async () => {
        // Simulate a settings save while the first network request is in flight.
        settings.cloudBaseUrl = "http://127.0.0.1:18882";
        settings.cloudToken = "account-b";
        return Response.json({
          artifacts: [{ id: "same-id", path: "same.txt", size: 8 }],
        });
      })
      .mockImplementationOnce(async (url, init) => {
        return new Response(
          String(url).startsWith(base) &&
            new Headers(init?.headers).get("Authorization") ===
              "Bearer account-a"
            ? "SOURCE_A"
            : "WRONG_SOURCE_B",
        );
      });
    const bytes = await readArtifactBytes("/no-host-file", {
      path: "same.txt",
      action: "created",
      updatedAt: "",
      source: { kind: "remote", runId: "run_a", artifactId: "same-id" },
    });
    expect(bytes.toString()).toBe("SOURCE_A");
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      base + "/v1/runs/run_a/artifacts",
      base + "/v1/runs/run_a/artifacts/same-id",
    ]);
    expect(
      fetcher.mock.calls.every(
        (call) =>
          new Headers(call[1]?.headers).get("Authorization") ===
          "Bearer account-a",
      ),
    ).toBe(true);
  });
});
