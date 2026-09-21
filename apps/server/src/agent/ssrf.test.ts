import { describe, expect, it } from "vitest";
import {
  hostAllowed,
  isPrivateIp,
  parseHttpUrl,
  resolvePublicIps,
  safeHttpFetch,
  SsrfError,
} from "./ssrf.ts";

describe("SSRF guards", () => {
  it("classifies loopback and RFC1918 as private", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.0.0.8")).toBe(true);
    expect(isPrivateIp("192.168.1.9")).toBe(true);
    expect(isPrivateIp("172.16.0.2")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
  });

  it("rejects file, localhost, credentials, and literal private URLs", () => {
    expect(() => parseHttpUrl("file:///etc/passwd")).toThrow(SsrfError);
    expect(() => parseHttpUrl("http://localhost/secret")).toThrow(SsrfError);
    expect(() => parseHttpUrl("http://127.0.0.1/")).toThrow(SsrfError);
    expect(() => parseHttpUrl("http://192.168.0.5/x")).toThrow(SsrfError);
    expect(() => parseHttpUrl("https://user:pass@example.com")).toThrow(SsrfError);
    expect(parseHttpUrl("https://example.com/a").hostname).toBe("example.com");
  });

  it("blocks DNS that resolves to a private IP", async () => {
    await expect(
      resolvePublicIps("evil.example", async () => ["127.0.0.1"]),
    ).rejects.toThrow(/private or loopback/i);
    await expect(resolvePublicIps("ok.example", async () => ["1.1.1.1"])).resolves.toEqual([
      "1.1.1.1",
    ]);
  });

  it("honors an allowlist of host suffixes", () => {
    expect(hostAllowed("en.wikipedia.org", ["wikipedia.org"])).toBe(true);
    expect(hostAllowed("evil.com", ["wikipedia.org"])).toBe(false);
    expect(hostAllowed("evil.com", [])).toBe(true);
  });

  it("fetches only after public DNS and refuses redirects", async () => {
    const result = await safeHttpFetch(
      "https://example.com/report",
      { allowlist: ["example.com"] },
      {
        lookup: async () => ["1.1.1.1"],
        fetch: async () =>
          new Response("# hello\n", {
            status: 200,
            headers: { "content-type": "text/markdown" },
          }),
      },
    );
    expect(result.status).toBe(200);
    expect(result.body).toContain("hello");

    await expect(
      safeHttpFetch(
        "https://example.com/r",
        {},
        {
          lookup: async () => ["1.1.1.1"],
          fetch: async () =>
            new Response("", { status: 302, headers: { Location: "http://127.0.0.1/" } }),
        },
      ),
    ).rejects.toThrow(/redirect/i);
  });

  it("blocks allowlisted-but-private resolution", async () => {
    await expect(
      safeHttpFetch(
        "https://example.com/",
        { allowlist: ["example.com"] },
        { lookup: async () => ["10.0.0.1"] },
      ),
    ).rejects.toThrow(SsrfError);
  });
});
