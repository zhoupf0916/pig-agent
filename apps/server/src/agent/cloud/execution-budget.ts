/** Execution time pauses for one bounded human approval; cancellation remains live. */
export class ExecutionBudget {
  private controller = new AbortController();
  private remaining: number;
  private started = Date.now();
  private timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  constructor(milliseconds: number, cancel: AbortSignal) {
    this.remaining = milliseconds;
    this.signal = AbortSignal.any([cancel, this.controller.signal]);
    this.timer = setTimeout(
      () => this.controller.abort(new Error("执行超时")),
      milliseconds,
    );
    this.timer.unref();
  }
  pauseForApproval(waitMs = 30 * 60 * 1000) {
    clearTimeout(this.timer);
    this.remaining -= Date.now() - this.started;
    this.timer = setTimeout(
      () => this.controller.abort(new Error("审批等待超时")),
      waitMs,
    );
    this.timer.unref();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      clearTimeout(this.timer);
      this.started = Date.now();
      this.timer = setTimeout(
        () => this.controller.abort(new Error("执行超时")),
        Math.max(1, this.remaining),
      );
      this.timer.unref();
    };
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
