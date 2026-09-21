import { lineDiff } from "../lib/diff";

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  if (lines.length === 0) {
    return <p className="text-xs text-ink-600">无差异。</p>;
  }
  return (
    <pre className="overflow-auto rounded-card border border-ink-300 bg-ink-100 font-mono text-[12px] leading-5">
      {lines.map((line, i) => (
        <div
          key={`${i}-${line.type}`}
          className={
            line.type === "add"
              ? "bg-success-soft text-success"
              : line.type === "del"
                ? "bg-danger-soft text-danger"
                : "text-ink-600"
          }
        >
          <span className="inline-block w-4 select-none text-center opacity-60">
            {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
          </span>
          {line.text || " "}
        </div>
      ))}
    </pre>
  );
}
