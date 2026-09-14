import { lineDiff } from "../lib/diff";

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  if (lines.length === 0) {
    return <p className="text-xs text-ink-500">无差异。</p>;
  }
  return (
    <pre className="overflow-auto rounded-lg border border-ink-200 bg-ink-50 font-mono text-[11px] leading-5">
      {lines.map((line, i) => (
        <div
          key={`${i}-${line.type}`}
          className={
            line.type === "add"
              ? "bg-emerald-50 text-emerald-900"
              : line.type === "del"
                ? "bg-red-50 text-red-900"
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
