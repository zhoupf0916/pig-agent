type Event = { type: string; text?: unknown; [key: string]: unknown };

/** Bound token delivery frequency without delaying the first text or terminal events. */
export class EventBatcher {
  private pending = "";
  private timer?: ReturnType<typeof setTimeout>;
  private first = true;
  constructor(
    private send: (event: Event) => void,
    private interval = 60,
  ) {}
  push(event: Event) {
    if (event.type !== "token") {
      this.flush();
      this.send(event);
      this.first = true;
      return;
    }
    if (typeof event.text !== "string" || !event.text) return;
    if (this.first) {
      this.first = false;
      this.send(event);
      return;
    }
    this.pending += event.text;
    if (this.pending.length >= 2048) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.interval);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending) return;
    const text = this.pending;
    this.pending = "";
    this.send({ type: "token", text });
  }
}
