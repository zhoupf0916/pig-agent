import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export type ExecutionSlot = { id: number; root: string; workspace: string };

/** Fixed execution slots. The control plane fills idle slots; a finished slot is wiped and reused. */
export class SlotPool {
  private idle: ExecutionSlot[] = [];
  private readonly busy = new Set<number>();
  constructor(private readonly dir: string, readonly size: number) {
    if (!Number.isInteger(size) || size < 1 || size > 16) throw new Error("执行槽位必须是 1 到 16");
  }
  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.idle = [];
    for (let id = 0; id < this.size; id += 1) {
      const root = join(this.dir, `slot-${id}`);
      const workspace = join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      this.idle.push({ id, root, workspace });
    }
  }
  get idleCount(): number {
    return this.idle.length;
  }
  acquire(): ExecutionSlot | undefined {
    const slot = this.idle.pop();
    if (slot) this.busy.add(slot.id);
    return slot;
  }
  async release(slot: ExecutionSlot): Promise<void> {
    try {
      await rm(slot.workspace, { recursive: true, force: true });
      await mkdir(slot.workspace, { recursive: true });
    } finally {
      this.busy.delete(slot.id);
      if (!this.idle.some((item) => item.id === slot.id)) this.idle.push(slot);
    }
  }
}
