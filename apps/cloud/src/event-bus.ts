import pg from "pg";

/**
 * In-process fan-out of Postgres NOTIFY messages on channel `pig_bus` (written by the triggers in
 * migration 0002). Payloads are keys such as `run:<id>`, `ev:<id>`, `conv:<id>`, `convrow:<id>`,
 * `approval:<id>`, `worker:<id>`, `queue` and `auth`.
 *
 * Notifications are only wake-ups: every consumer re-reads the database, which stays authoritative.
 * While the LISTEN connection is down, waits fall back to the caller's old polling cadence, and every
 * subscriber is woken after a reconnect because notifications may have been missed in the gap.
 */
export const BUS_CHANNEL = "pig_bus";

type Waker = { keys: string[]; fired: Set<string>; wake?: () => void };

export type WaitOptions = {
  /** Upper bound while the bus is live (e.g. time until the next heartbeat). */
  liveMs: number;
  /** Upper bound while the bus is down: the previous polling interval. */
  pollMs: number;
  signal?: AbortSignal;
};

export class Subscription {
  constructor(
    private readonly bus: EventBus,
    private readonly waker: Waker,
  ) {}
  /** Resolves with the keys that fired since the last wait (empty on timeout). */
  wait({ liveMs, pollMs, signal }: WaitOptions): Promise<Set<string>> {
    const take = () => {
      const fired = new Set(this.waker.fired);
      this.waker.fired.clear();
      return fired;
    };
    if (this.waker.fired.size || signal?.aborted) return Promise.resolve(take());
    const ms = Math.max(0, this.bus.live ? liveMs : Math.min(liveMs, pollMs));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.waker.wake = undefined;
        resolve(take());
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      this.waker.wake = done;
    });
  }
  close() {
    this.bus.unsubscribe(this.waker);
  }
}

export class EventBus {
  private readonly byKey = new Map<string, Set<Waker>>();
  private client?: pg.Client;
  private stopped = true;
  private retryMs = 1000;
  live = false;
  readonly stats = { notifications: 0, reconnects: 0 };

  constructor(private readonly connectionString = process.env.DATABASE_URL) {}

  subscribe(keys: string[]): Subscription {
    const waker: Waker = { keys, fired: new Set() };
    for (const key of keys) {
      let set = this.byKey.get(key);
      if (!set) this.byKey.set(key, (set = new Set()));
      set.add(waker);
    }
    return new Subscription(this, waker);
  }

  unsubscribe(waker: Waker) {
    waker.wake?.();
    for (const key of waker.keys) {
      const set = this.byKey.get(key);
      set?.delete(waker);
      if (set && !set.size) this.byKey.delete(key);
    }
  }

  /** Deliver a key to local subscribers (used by the LISTEN client and by tests). */
  dispatch(key: string) {
    this.stats.notifications++;
    for (const waker of this.byKey.get(key) ?? []) {
      waker.fired.add(key);
      waker.wake?.();
    }
  }

  private wakeAll(reason: string) {
    for (const set of this.byKey.values())
      for (const waker of set) {
        waker.fired.add(reason);
        waker.wake?.();
      }
  }

  get subscribers() {
    let n = 0;
    for (const set of this.byKey.values()) n += set.size;
    return n;
  }

  async start() {
    if (!this.stopped || !this.connectionString) return;
    this.stopped = false;
    await this.connect();
  }

  private async connect() {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString, keepAlive: true });
    this.client = client;
    const lost = () => {
      if (this.client !== client) return;
      this.client = undefined;
      const wasLive = this.live;
      this.live = false;
      client.removeAllListeners();
      client.end().catch(() => {});
      if (wasLive) console.error("Event bus disconnected; falling back to polling");
      this.wakeAll("resync");
      if (!this.stopped) {
        setTimeout(() => void this.connect(), this.retryMs).unref();
        this.retryMs = Math.min(this.retryMs * 2, 10_000);
      }
    };
    client.on("error", lost);
    client.on("end", lost);
    client.on("notification", (message) => {
      if (message.channel === BUS_CHANNEL && message.payload) this.dispatch(message.payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${BUS_CHANNEL}`);
      if (this.client !== client) return;
      if (this.stats.reconnects++) console.log("Event bus reconnected");
      this.live = true;
      this.retryMs = 1000;
      // Anything written while we were not listening must be re-read.
      this.wakeAll("resync");
    } catch {
      lost();
    }
  }

  async stop() {
    this.stopped = true;
    this.live = false;
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => {});
  }
}

export const bus = new EventBus();
