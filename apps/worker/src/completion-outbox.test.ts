import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionOutbox } from "./completion-outbox.ts";
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pig-completion-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
const item = {
  runId: "run_test",
  body: {
    token: "private-attempt",
    submissionId: "fixed-id",
    ok: true,
    files: [{ path: "proof.txt", content: "SUCCESS" }],
  },
};
describe("durable completion delivery", () => {
  it("503 retries the identical successful payload and removes only after acknowledgement", async () => {
    const path = await directory();
    const send = vi
      .fn()
      .mockRejectedValueOnce(Error("Control 503"))
      .mockResolvedValue({ ok: true });
    const outbox = new CompletionOutbox(path, send, async () => {});
    await outbox.save(item);
    expect((await stat(join(path, "run_test.json"))).mode & 0o777).toBe(0o600);
    expect(await outbox.deliver(item)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every(
        (call) => JSON.stringify(call[1]) === JSON.stringify(item.body),
      ),
    ).toBe(true);
    expect(await readdir(path)).toEqual([]);
  });
  it("recovers original payload after process restart and lost acknowledgement", async () => {
    const path = await directory();
    const unavailable = vi.fn().mockRejectedValue(Error("response lost"));
    const first = new CompletionOutbox(path, unavailable, async () => {});
    await first.save(item);
    expect(await first.deliver(item)).toBe(false);
    expect(
      JSON.parse(await readFile(join(path, "run_test.json"), "utf8")),
    ).toEqual(item);
    const send = vi.fn().mockResolvedValue({ ok: true, replayed: true });
    await new CompletionOutbox(path, send, async () => {}).recover();
    expect(send).toHaveBeenCalledWith(
      "/internal/runs/run_test/finish",
      item.body,
    );
    expect(await readdir(path)).toEqual([]);
  });
  it("retains fenced results without retrying an invalid credential or altering the outcome", async () => {
    const path = await directory(),
      send = vi.fn().mockRejectedValue(Error("Control 409"));
    const outbox = new CompletionOutbox(path, send, async () => {});
    await outbox.save(item);
    expect(await outbox.deliver(item)).toBe(false);
    await outbox.recover();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await readFile(join(path, "run_test.json.rejected"), "utf8")),
    ).toEqual(item);
  });
  it("coalesces background recovery with an in-flight delivery", async () => {
    const path = await directory();
    let acknowledge!: () => void;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const outbox = new CompletionOutbox(path, send, async () => {});
    await outbox.save(item);
    const first = outbox.deliver(item),
      second = outbox.deliver(item);
    expect(first).toBe(second);
    acknowledge();
    expect(await first).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await readdir(path)).toEqual([]);
  });
  it("allows two process generations to acknowledge the same retained receipt", async () => {
    const path = await directory();
    const send = vi.fn().mockResolvedValue({ ok: true });
    const first = new CompletionOutbox(path, send, async () => {});
    const replacement = new CompletionOutbox(path, send, async () => {});
    await first.save(item);
    expect(
      await Promise.all([first.deliver(item), replacement.deliver(item)]),
    ).toEqual([true, true]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await readdir(path)).toEqual([]);
  });
});
