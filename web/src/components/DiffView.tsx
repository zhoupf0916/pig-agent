import { lineDiff } from "../lib/diff";

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  if (lines.length === 0) {
    return <p className="text-xs text-ink-500">无差异。</p>;
  }
  return (
    <pre className="overflow-auto rounded-lg border border-white/5 bg-ink-950/80 font-mono text-[11px] leading-5">
      {lines.map((line, i) => (
        <div
          key={`${i}-${line.type}`}
          className={
            line.type === "add"
              ? "bg-emerald-500/10 text-emerald-100"
              : line.type === "del"
                ? "bg-red-500/10 text-red-100"
                : "text-ink-400"
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
