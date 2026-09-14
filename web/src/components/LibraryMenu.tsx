import { ChevronDown, Library } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type LibraryPage = "projects" | "experts" | "automations" | "memory";

const ITEMS: { name: LibraryPage; label: string; hint: string }[] = [
  { name: "projects", label: "项目", hint: "看板、资产与转交" },
  { name: "experts", label: "专家", hint: "Playbook 与小队" },
  { name: "automations", label: "自动化", hint: "手动或 cron 开一轮" },
  { name: "memory", label: "记忆", hint: "钉住笔记与回合摘要" },
];

export function isLibraryPage(name: string): name is LibraryPage {
  return ITEMS.some((item) => item.name === name);
}

export function LibraryMenu({
  active,
  onProjects,
  onExperts,
  onAutomations,
  onMemory,
}: {
  active?: LibraryPage;
  onProjects: () => void;
  onExperts: () => void;
  onAutomations: () => void;
  onMemory: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = ITEMS.find((item) => item.name === active);
  const label = current?.label ?? "资料库";

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

  const go = (name: LibraryPage) => {
    setOpen(false);
    if (name === "projects") onProjects();
    else if (name === "experts") onExperts();
    else if (name === "automations") onAutomations();
    else onMemory();
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className={active ? "btn-nav-active" : "btn-nav"}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="资料库"
        onClick={() => setOpen((v) => !v)}
      >
        <Library size={14} />
        {label}
        <ChevronDown size={12} className="text-ink-500" />
      </button>
      {open && (
        <div
          className="absolute right-0 z-20 mt-2 w-56 rounded-card border border-ink-300 bg-white p-1 shadow-lift"
          role="menu"
        >
          <div className="px-2 py-1.5 text-meta uppercase tracking-[0.16em] text-ink-500">资料库</div>
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
