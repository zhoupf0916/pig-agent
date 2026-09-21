import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { DATA_DIR } from "./config.ts";
import { atomicWriteJson } from "./util.ts";

describe("atomic JSON persistence", () => {
  it("uses separate temporary files for concurrent writes and owner-only permissions", async () => {
    const file = join(DATA_DIR, "concurrent.json");
    await Promise.all(Array.from({ length: 10 }, (_, value) => atomicWriteJson(file, { value })));
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.value).toBeGreaterThanOrEqual(0);
    expect(stored.value).toBeLessThan(10);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
