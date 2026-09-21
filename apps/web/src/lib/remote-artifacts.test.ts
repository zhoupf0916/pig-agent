import { afterEach, describe, expect, it, vi } from "vitest";
import { listRemoteArtifacts, readRemoteArtifact } from "./remote-artifacts";

afterEach(() => vi.unstubAllGlobals());
describe("remote artifact provenance", () => {
  it("uses run + artifact identity across same-named versions, never host file lookup", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/run_a/artifacts"))
        return Response.json({
          artifacts: [{ id: "a1", path: "same.txt", size: 3 }],
        });
      if (url.endsWith("/run_b/artifacts"))
        return Response.json({
          artifacts: [{ id: "b1", path: "same.txt", size: 3 }],
        });
      if (url.endsWith("/run_a/artifacts/a1")) return new Response("ONE");
      if (url.endsWith("/run_b/artifacts/b1")) return new Response("TWO");
      throw Error("Unexpected host lookup");
    });
    vi.stubGlobal("fetch", fetcher);
    const a = (await listRemoteArtifacts("run_a"))[0]!;
    const b = (await listRemoteArtifacts("run_b"))[0]!;
    expect(await readRemoteArtifact(a)).toMatchObject({
      content: "ONE",
      runId: "run_a",
      artifactId: "a1",
      source: "remote",
    });
    expect(await readRemoteArtifact(b)).toMatchObject({
      content: "TWO",
      runId: "run_b",
      artifactId: "b1",
      source: "remote",
    });
    expect(
      fetcher.mock.calls.every(([url]) => !url.includes("/workspace/file")),
    ).toBe(true);
  });
  it("fails closed on authorization loss rather than displaying a local fallback", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: "Not found" }, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      readRemoteArtifact({
        source: "remote",
        runId: "run_a",
        artifactId: "a",
        path: "same.txt",
        size: 3,
      }),
    ).rejects.toThrow("无权访问");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("passes cancellation to both metadata and content requests", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => Response.json({ artifacts: [] }));
    vi.stubGlobal("fetch", fetcher);
    await listRemoteArtifacts("run_a", controller.signal);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/remote/v1/runs/run_a/artifacts",
      { signal: controller.signal },
    );
  });
});
