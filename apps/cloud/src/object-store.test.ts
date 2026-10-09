import { afterEach, describe, expect, it, vi } from "vitest";
import { S3Client, S3Error, s3Encode } from "./object-store.ts";

const client = () => new S3Client({ endpoint: "http://minio:9000", bucket: "pig-agent", accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" });
afterEach(() => vi.unstubAllGlobals());

describe("S3 client", () => {
  it("encodes keys per RFC 3986 and keeps path separators", () => {
    expect(s3Encode("a b(1)*!'~.-_")).toBe("a%20b%281%29%2A%21%27~.-_");
  });

  it("signs path-style requests deterministically with SigV4", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => (calls.push({ url: String(url), init }), new Response(null, { status: 200 })));
    const now = new Date("2026-10-10T00:00:00Z");
    await client().request("PUT", "attachments/u_1/att 1", { body: new TextEncoder().encode("hi"), now, headers: { "Content-Type": "text/plain" } });
    await client().request("PUT", "attachments/u_1/att 1", { body: new TextEncoder().encode("hi"), now, headers: { "Content-Type": "text/plain" } });
    expect(calls[0]!.url).toBe("http://minio:9000/pig-agent/attachments/u_1/att%201");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["x-amz-date"]).toBe("20261010T000000Z");
    expect(h["x-amz-content-sha256"]).toBe("8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4");
    expect(h.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261010\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(h.Authorization).toBe((calls[1]!.init.headers as Record<string, string>).Authorization);
    expect(h.Authorization).not.toContain("EXAMPLEKEY");
  });

  it("returns undefined for missing objects and surfaces S3 error codes", async () => {
    vi.stubGlobal("fetch", async () => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }));
    expect(await client().get("x")).toBeUndefined();
    expect(await client().head("x")).toBeUndefined();
    vi.stubGlobal("fetch", async () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
    await expect(client().put("x", new Uint8Array([1]))).rejects.toMatchObject({ status: 403, code: "AccessDenied" } satisfies Partial<S3Error>);
  });

  it("pages ListObjectsV2 results", async () => {
    const pages = [
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken><Contents><Key>a/1</Key><Size>3</Size><LastModified>2026-10-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>`,
      `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a/&lt;2&gt;</Key><Size>5</Size><LastModified>2026-10-02T00:00:00.000Z</LastModified></Contents></ListBucketResult>`,
    ];
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => (urls.push(String(url)), new Response(pages.shift())));
    const keys = [];
    for await (const o of client().list("a/")) keys.push([o.key, o.size]);
    expect(keys).toEqual([["a/1", 3], ["a/<2>", 5]]);
    expect(urls[1]).toContain("continuation-token=t%262");
  });
});

// Real round trip against MinIO when available (S3_TEST_ENDPOINT, e.g. a local container).
describe.skipIf(!process.env.S3_TEST_ENDPOINT)("S3 client against MinIO", () => {
  it("creates the bucket and round-trips objects", async () => {
    const c = new S3Client({ endpoint: process.env.S3_TEST_ENDPOINT!, bucket: "pig-test", accessKey: process.env.S3_TEST_ACCESS_KEY!, secretKey: process.env.S3_TEST_SECRET_KEY! });
    await c.ensureBucket();
    await c.ensureBucket();
    const body = new TextEncoder().encode("你好 object store");
    await c.put("workspaces/c 1/r+1.tar.gz", body);
    expect((await c.get("workspaces/c 1/r+1.tar.gz"))?.toString()).toBe("你好 object store");
    expect(await c.head("workspaces/c 1/r+1.tar.gz")).toEqual({ size: body.length });
    const listed = [];
    for await (const o of c.list("workspaces/")) listed.push(o.key);
    expect(listed).toContain("workspaces/c 1/r+1.tar.gz");
    await c.delete("workspaces/c 1/r+1.tar.gz");
    expect(await c.get("workspaces/c 1/r+1.tar.gz")).toBeUndefined();
  });
});
