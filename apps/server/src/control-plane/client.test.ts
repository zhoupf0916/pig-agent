import { afterEach, expect, it, vi } from "vitest";
import { normalizeSettings } from "../store/settings.ts";
import { createPlaneClient } from "./client.ts";
afterEach(() => vi.unstubAllGlobals());
it("pins endpoint and credentials for one multi-request artifact import despite settings changes", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response('{"ok":true}', {
          headers: {
            "content-type": "application/json",
            "set-cookie": "not-for-renderer",
          },
        }),
    );
  vi.stubGlobal("fetch", fetch);
  const settings = normalizeSettings({
    cloudBaseUrl: "http://127.0.0.1:18881",
    cloudToken: "account-a",
  });
  const client = createPlaneClient(settings);
  await client.json("/v1/runs/run_fixture");
  settings.cloudBaseUrl = "http://127.0.0.1:18882";
  settings.cloudToken = "account-b";
  const response = await client.fetch(
    "/v1/runs/run_fixture/artifacts/artifact_fixture",
  );
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    "http://127.0.0.1:18881/v1/runs/run_fixture",
    "http://127.0.0.1:18881/v1/runs/run_fixture/artifacts/artifact_fixture",
  ]);
  expect(
    fetch.mock.calls.every(
      (call) => call[1].headers.Authorization === "Bearer account-a",
    ),
  ).toBe(true);
  expect(response.headers.has("set-cookie")).toBe(false);
});
it("does not turn unauthorized artifact access into content", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":"Not found"}', { status: 404 }),
      ),
  );
  const client = createPlaneClient(
    normalizeSettings({
      cloudBaseUrl: "http://127.0.0.1:18881",
      cloudToken: "account-a",
    }),
  );
  await expect(client.json("/v1/runs/private")).rejects.toThrow("Not found");
});
