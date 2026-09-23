/** Coalesce token deltas into one UI update per frame. */
export function createTokenBatch(
  flush: (text: string) => void,
  schedule: (run: () => void) => number = (run) => requestAnimationFrame(run),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
) {
  let pending = "";
  let frame = 0;
  const emit = () => {
    frame = 0;
    const text = pending;
    pending = "";
    if (text) flush(text);
  };
  return {
    push(text: string) {
      if (!text) return;
      pending += text;
      if (frame) return;
      frame = schedule(emit);
    },
    flushNow() {
      if (frame) cancel(frame);
      emit();
    },
  };
}
