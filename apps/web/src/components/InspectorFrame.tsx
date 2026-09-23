import { useDialog } from "../lib/use-dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
export function InspectorFrame({
  children,
  onClose,
  wide = false,
}: {
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const [width, setWidth] = useState(400);
  const [expanded, setExpanded] = useState(false);
  const [drawer, setDrawer] = useState(
    () => window.matchMedia("(max-width: 1100px)").matches,
  );
  useEffect(() => {
    if (!wide) setExpanded(false);
  }, [wide]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const update = () => setDrawer(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const panel = useDialog<HTMLElement>(drawer, onClose);
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <section
      ref={panel}
      tabIndex={-1}
      role={drawer ? "dialog" : "region"}
      aria-modal={drawer ? true : undefined}
      className={`inspector-frame${wide ? " is-wide" : ""}${expanded ? " is-expanded" : ""}`}
      style={expanded ? undefined : { width: wide ? Math.max(width, 720) : width }}
      aria-label="任务成果检查器"
      onKeyDown={(event) => {
        if (!drawer && event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div
        role="separator"
        aria-label="调整成果面板宽度"
        aria-orientation="vertical"
        aria-valuemin={300}
        aria-valuemax={wide ? 960 : 680}
        aria-valuenow={wide ? Math.max(width, 720) : width}
        tabIndex={0}
        className="inspector-resizer"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            setWidth((w) =>
              Math.max(
                300,
                Math.min(wide ? 960 : 680, w + (e.key === "ArrowLeft" ? 24 : -24)),
              ),
            );
          }
        }}
        onPointerDown={(e) => {
          start.current = { x: e.clientX, width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (start.current)
            setWidth(
              Math.max(
                300,
                  Math.min(
                  wide ? 960 : 680,
                  start.current.width + start.current.x - e.clientX,
                ),
              ),
            );
        }}
        onPointerUp={() => {
          start.current = null;
        }}
        onPointerCancel={() => {
          start.current = null;
        }}
      />
      <header className="inspector-header">
        <strong>成果与文件</strong>
        <span className="flex items-center gap-1">
          {wide && (
            <button type="button" className="btn-ghost text-xs" aria-label={expanded ? "收回开发者" : "展开开发者"} onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收回" : "展开"}
            </button>
          )}
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="关闭成果面板"
        >
          <X size={18} />
        </button>
        </span>
      </header>
      {children}
    </section>
  );
}
