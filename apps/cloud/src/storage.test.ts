import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("./db.ts", () => ({ db: { query: (...a: unknown[]) => query(...a) }, POOL_MAX: 10 }));
const { collectGarbage, hydrateSnapshot, prepareWorkspaceVersion, putVerified, readBlob, setStorageClient, sha256, storageFallbacks, storageMode } = await import("./storage.ts");
import type { S3Client } from "./object-store.ts";

class FakeS3 {
  objects = new Map<string, { body: Buffer; at: Date }>();
  corrupt = false;
  down = false;
  bucket = "pig-agent";
  async ensureBucket() {
    if (this.down) throw Error("ECONNREFUSED");
  }
  async put(key: string, body: Uint8Array) {
    if (this.down) throw Error("ECONNREFUSED");
    this.objects.set(key, { body: Buffer.from(this.corrupt ? Buffer.concat([Buffer.from(body), Buffer.from("x")]) : body), at: new Date() });
  }
  async get(key: string) {
    if (this.down) throw Error("ECONNREFUSED");
    return this.objects.get(key)?.body;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async *list(prefix: string) {
    for (const [key, o] of this.objects) if (key.startsWith(prefix)) yield { key, size: o.body.length, lastModified: o.at };
  }
}
let fake: FakeS3;
const env = { ...process.env };
beforeEach(() => {
  fake = new FakeS3();
  Object.assign(process.env, { S3_ENDPOINT: "http://minio:9000", S3_ACCESS_KEY: "a", S3_SECRET_KEY: "b", STORAGE_MODE: "dual" });
  setStorageClient(fake as unknown as S3Client);
  query.mockReset();
});
afterEach(() => {
  process.env = { ...env };
  setStorageClient(undefined);
});

describe("storage mode", () => {
  it("is pg without an endpoint and dual by default", () => {
    delete process.env.S3_ENDPOINT;
    expect(storageMode()).toBe("pg");
    process.env.S3_ENDPOINT = "http://minio:9000";
    delete process.env.STORAGE_MODE;
    expect(storageMode()).toBe("dual");
    process.env.STORAGE_MODE = "object";
    expect(storageMode()).toBe("object");
  });
});

describe("copy-then-verify", () => {
  it("records only verified copies", async () => {
    const bytes = Buffer.from("hello");
    expect(await putVerified("attachments/u/a", bytes)).toBe(sha256(bytes));
    fake.corrupt = true;
    await expect(putVerified("attachments/u/b", bytes)).rejects.toThrow(/verification/);
  });
});

describe("reads", () => {
  const bytes = Buffer.from("payload");
  it("serves the verified object and falls back to Postgres when missing, corrupt or down", async () => {
    await fake.put("k", bytes);
    const row = { blob_key: "k", blob_sha256: sha256(bytes) };
    const pg = vi.fn(() => Buffer.from("pg copy"));
    expect((await readBlob(row, pg, "attachment")).toString()).toBe("payload");
    expect(pg).not.toHaveBeenCalled();
    const before = storageFallbacks.get({ kind: "attachment" });
    await fake.put("k", Buffer.from("tampered"));
    expect((await readBlob(row, pg, "attachment")).toString()).toBe("pg copy");
    fake.down = true;
    expect((await readBlob(row, pg, "attachment")).toString()).toBe("pg copy");
    expect(storageFallbacks.get({ kind: "attachment" })).toBe(before + 2);
  });
  it("fails clearly when neither copy is available", async () => {
    fake.down = true;
    await expect(readBlob({ blob_key: "k", blob_sha256: "x" }, () => undefined, "attachment")).rejects.toThrow(/对象存储不可用/);
  });
  it("uses Postgres directly for rows that were never offloaded", async () => {
    expect((await readBlob({ blob_key: null }, () => bytes, "attachment")).toString()).toBe("payload");
  });
});

describe("workspace snapshots", () => {
  const tar = Buffer.from("tar.gz bytes");
  it("keeps the tarball in Postgres in dual mode", async () => {
    const snap = { data: tar.toString("base64"), files: [] };
    expect(await prepareWorkspaceVersion("conv_1", "run_1", snap)).toEqual({ snapshot: snap });
    expect(await hydrateSnapshot({ snapshot: snap })).toBe(snap);
  });
  it("moves the tarball to the object store in object mode and hydrates it back", async () => {
    process.env.STORAGE_MODE = "object";
    const prepared = await prepareWorkspaceVersion("conv_1", "run_1", { data: tar.toString("base64"), files: ["a"] });
    expect(prepared.snapshot).toEqual({ files: ["a"] });
    expect(prepared.blob).toMatchObject({ key: "workspaces/conv_1/run_1.tar.gz", sha: sha256(tar), size: tar.length });
    const hydrated = await hydrateSnapshot({ snapshot: prepared.snapshot, blob_key: prepared.blob!.key, blob_sha256: prepared.blob!.sha });
    expect(Buffer.from(hydrated.data, "base64").toString()).toBe("tar.gz bytes");
  });
  it("keeps the tarball in Postgres when the store is down in object mode", async () => {
    process.env.STORAGE_MODE = "object";
    fake.down = true;
    const snap = { data: tar.toString("base64") };
    expect(await prepareWorkspaceVersion("conv_1", "run_1", snap)).toEqual({ snapshot: snap });
  });
});

describe("orphan GC", () => {
  it("deletes only old objects without a row", async () => {
    await fake.put("attachments/u/keep", Buffer.from("1"));
    await fake.put("attachments/u/orphan", Buffer.from("2"));
    await fake.put("workspaces/c/young.tar.gz", Buffer.from("3"));
    query.mockImplementation(async (_sql: string, [keys]: [string[]]) => ({ rows: keys.filter((k) => k.endsWith("keep")).map((k) => ({ k })) }));
    const now = Date.now() + 2 * 3600_000;
    fake.objects.get("workspaces/c/young.tar.gz")!.at = new Date(now - 60_000);
    const result = await collectGarbage(3600_000, now);
    expect(result).toEqual({ scanned: 3, deleted: 1 });
    expect([...fake.objects.keys()].sort()).toEqual(["attachments/u/keep", "workspaces/c/young.tar.gz"].sort());
  });
});
