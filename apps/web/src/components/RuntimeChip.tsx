import type { ExecutionSurface } from "../types";

const KIND_CLASS: Record<ExecutionSurface["kind"], string> = {
  pig: "border-ink-300 bg-ink-100 text-ink-800",
  codex: "border-accent bg-accent-soft text-ink-800",
  "cloud-stub": "border-accent bg-accent-soft text-ink-800",
  "cloud-remote": "border-warning bg-warning-soft text-warning",
};

export function RuntimeChip({
  surface,
  onClick,
}: {
  surface: ExecutionSurface;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={surface.summary}
      aria-label={`当前执行面：${surface.summary}`}
      data-runtime={surface.runtime}
      data-runtime-kind={surface.kind}
      className={`inline-flex max-w-[240px] items-center gap-1.5 rounded-btn border px-2.5 py-1.5 text-left text-xs ${KIND_CLASS[surface.kind]}`}
    >
      <span className="shrink-0 font-medium">{surface.label}</span>
      {surface.detail && (
        <span className="hidden min-w-0 truncate sm:inline">{surface.detail}</span>
      )}
    </button>
  );
}
