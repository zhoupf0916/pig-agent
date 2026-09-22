import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SlotPool } from "./slot-pool.ts";

describe("runner execution slots", () => {
  it("reuses a wiped slot instead of creating a new container for every job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pig-slots-"));
    try {
      const pool = new SlotPool(dir, 2);
      await pool.open();
      const first = pool.acquire();
      const second = pool.acquire();
      expect(first && second && first.id !== second.id).toBe(true);
      expect(pool.acquire()).toBeUndefined();
      await writeFile(join(first!.workspace, "secret.txt"), "job");
      await pool.release(first!);
      expect(pool.idleCount).toBe(1);
      const reused = pool.acquire();
      expect(reused?.id).toBe(first!.id);
      await expect(readFile(join(reused!.workspace, "secret.txt"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
