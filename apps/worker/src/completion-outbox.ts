import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
export type Completion = { runId: string; body: Record<string, unknown> };
// Durable payload, not a retry of execution. Secrets are stored only in a private runner volume.
export class CompletionOutbox {
  private deliveries = new Map<string, Promise<boolean>>();
  constructor(
    private directory: string,
    private send: (path: string, body: unknown) => Promise<unknown>,
    private wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  private path(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error("Invalid run ID");
    return join(this.directory, id + ".json");
  }
  async save(item: Completion) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(item.runId),
      temp = path + ".tmp";
    const file = await open(temp, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(item));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  deliver(item: Completion): Promise<boolean> {
    const existing = this.deliveries.get(item.runId);
    if (existing) return existing;
    const delivery = this.attempt(item).finally(() => {
      this.deliveries.delete(item.runId);
    });
    this.deliveries.set(item.runId, delivery);
    return delivery;
  }
  private async attempt(item: Completion) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await this.send(`/internal/runs/${item.runId}/finish`, item.body);
        await unlink(this.path(item.runId)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          },
        );
        return true;
      } catch (error) {
        if (/Control 4\d\d/.test(String(error))) {
          // Fenced/expired results stay available for operator recovery, never overwrite a newer state.
          await rename(
            this.path(item.runId),
            this.path(item.runId) + ".rejected",
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          return false;
        }
        if (attempt < 5) await this.wait(Math.min(2000, 250 * 2 ** attempt));
      }
    }
    return false;
  }
  async recover() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.directory, name);
      let item: Completion;
      try {
        item = JSON.parse(await readFile(path, "utf8")) as Completion;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (!(error instanceof SyntaxError)) throw error;
        await rename(path, path + ".corrupt");
        console.error("Invalid completion retained for inspection", name);
        continue;
      }
      await this.deliver(item);
    }
  }
}
