import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { SsrfError } from "./ssrf.ts";
import { MCP_RESPONSE_BYTE_LIMIT, connectPinnedMcp, createPinnedMcpFetch, pinMcpTarget } from "./mcp-egress.ts";

describe("MCP egress", () => {
  it("rejects mapped metadata from DNS and does not connect", async () => {
    await expect(pinMcpTarget("https://meta.example/mcp", {
      lookup: async () => ["::ffff:a9fe:a9fe"],
    })).rejects.toThrow(SsrfError);
    await expect(pinMcpTarget("https://loop.example/mcp", {
      lookup: async () => ["::ffff:7f00:1"],
    })).rejects.toThrow(SsrfError);
    await expect(pinMcpTarget("https://link.example/mcp", {
      lookup: async () => ["fe90::1"],
    })).rejects.toThrow(SsrfError);
  });

  it("reuses the first checked addresses and does not look up again", async () => {
    let lookups = 0;
    const seen: string[][] = [];
    const fetch = createPinnedMcpFetch({
      lookup: async () => {
        lookups += 1;
        return lookups === 1 ? ["203.0.113.10"] : ["::ffff:a9fe:a9fe"];
      },
      connect: async (_url, ips) => {
        seen.push(ips);
        return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect((await fetch("https://mcp.example/mcp", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await fetch("https://mcp.example/mcp", { method: "POST", body: "{}" })).status).toBe(200);
    expect(lookups).toBe(1);
    expect(seen).toEqual([["203.0.113.10"], ["203.0.113.10"]]);
  });

  it("refuses redirects from the pinned connection", async () => {
    const fetch = createPinnedMcpFetch({
      lookup: async () => ["203.0.113.10"],
      connect: async () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    await expect(fetch("https://mcp.example/mcp")).rejects.toThrow(/重定向/);
  });

  it("returns a streaming body before the server ends and rejects an oversized stream", async () => {
    let closed = false;
    const server = createServer((req, res) => {
      req.on("close", () => { closed = true; });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    try {
      const response = await connectPinnedMcp(url, ["127.0.0.1"], { method: "GET" });
      const reader = response.body?.getReader();
      const first = await reader?.read();
      expect(new TextDecoder().decode(first?.value)).toContain("hello");
      expect(closed).toBe(false);
      await reader?.cancel();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const flood = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("x".repeat(MCP_RESPONSE_BYTE_LIMIT + 100));
    });
    await new Promise<void>((resolve) => flood.listen(0, "127.0.0.1", () => resolve()));
    const floodAddress = flood.address();
    if (!floodAddress || typeof floodAddress === "string") throw new Error("no port");
    try {
      const response = await connectPinnedMcp(new URL(`http://127.0.0.1:${floodAddress.port}/mcp`), ["127.0.0.1"], { method: "GET" });
      const reader = response.body?.getReader();
      await expect(async () => {
        while (true) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) break;
        }
      }).rejects.toThrow(/体积/);
    } finally {
      flood.closeAllConnections();
      await new Promise<void>((resolve) => flood.close(() => resolve()));
    }
  });

  it("accepts 204 without a body and destroys the upstream request when cancelled", async () => {
    const empty = createServer((_req, res) => { res.writeHead(204); res.end(); });
    await new Promise<void>((resolve) => empty.listen(0, "127.0.0.1", () => resolve()));
    const emptyAddress = empty.address();
    if (!emptyAddress || typeof emptyAddress === "string") throw new Error("no port");
    try {
      const response = await connectPinnedMcp(new URL(`http://127.0.0.1:${emptyAddress.port}/mcp`), ["127.0.0.1"], { method: "DELETE" });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    } finally {
      await new Promise<void>((resolve) => empty.close(() => resolve()));
    }
    let destroyed = false;
    const hanging = createServer((req, res) => {
      req.on("close", () => { destroyed = true; });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: wait\n\n");
    });
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", () => resolve()));
    const hangingAddress = hanging.address();
    if (!hangingAddress || typeof hangingAddress === "string") throw new Error("no port");
    const controller = new AbortController();
    try {
      const response = await connectPinnedMcp(new URL(`http://127.0.0.1:${hangingAddress.port}/mcp`), ["127.0.0.1"], { method: "GET", signal: controller.signal });
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(destroyed).toBe(true);
      await response.body?.cancel();
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("allows an explicit desktop loopback and still blocks metadata", async () => {
    await expect(pinMcpTarget("http://127.0.0.1:9/mcp", { allowLoopback: true })).resolves.toMatchObject({ ips: ["127.0.0.1"] });
    await expect(pinMcpTarget("http://169.254.169.254/mcp", { allowLoopback: true })).rejects.toThrow(SsrfError);
  });
});
