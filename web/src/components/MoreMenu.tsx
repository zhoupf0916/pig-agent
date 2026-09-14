import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type MorePage = "memory" | "automations";

const ITEMS: { name: MorePage; label: string; hint: string }[] = [
  { name: "memory", label: "记忆", hint: "钉住笔记与回合摘要" },
  { name: "automations", label: "自动化", hint: "手动或 cron 开一轮" },
];

export function isMorePage(name: string): name is MorePage {
  return ITEMS.some((item) => item.name === name);
}

export function MoreMenu({
  active,
  onMemory,
  onAutomations,
}: {
  active?: MorePage;
  onMemory: () => void;
  onAutomations: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const go = (name: MorePage) => {
    setOpen(false);
    if (name === "memory") onMemory();
    else onAutomations();
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className={active ? "btn-nav-active" : "btn-nav"}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="更多"
        onClick={() => setOpen((v) => !v)}
      >
        更多
        <ChevronDown size={12} className="text-ink-500" />
      </button>
      {open && (
        <div
          className="absolute right-0 z-20 mt-2 w-56 rounded-card border border-ink-300 bg-white p-1 shadow-lift"
          role="menu"
        >
          {ITEMS.map((item) => {
            const selected = item.name === active;
            return (
              <button
                key={item.name}
                type="button"
                role="menuitem"
                aria-current={selected ? "page" : undefined}
                className={`flex w-full flex-col rounded-[10px] px-2 py-1.5 text-left ${
                  selected ? "bg-ink-100 text-ink-800" : "text-ink-700 hover:bg-ink-100"
                }`}
                onClick={() => go(item.name)}
              >
                <span className={`text-[13px] ${selected ? "font-medium" : ""}`}>{item.label}</span>
                <span className="text-meta text-ink-500">{item.hint}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
