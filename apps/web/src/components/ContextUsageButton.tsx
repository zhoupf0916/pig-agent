import { useEffect, useId, useRef, useState } from "react";
import type { ContextCallSnapshot } from "@pig-agent/contracts";

function share(part: number | undefined, budget: number | undefined): string {
  if (part === undefined || !budget) return "未采集";
  const ratio = Math.round((part / budget) * 1000) / 10;
  return `${part.toLocaleString("zh-CN")} · ${ratio}%`;
}

function percent(usage: ContextCallSnapshot): number {
  if (usage.availability !== "collected" || usage.ratio === undefined) return 0;
  return Math.round(usage.ratio * 100);
}

export function ContextUsageButton({ usage }: { usage?: ContextCallSnapshot }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const narrow = window.matchMedia("(max-width: 720px)").matches;
    const previousOverflow = document.body.style.overflow;
    if (narrow) document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);
  const label = !usage ? "未采集" : usage.availability === "unknown" ? "未知" : usage.availability === "collected" ? `${percent(usage)}%` : "未采集";
  const collected = usage?.availability === "collected";
  return (
    <div className="context-usage" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="context-usage-ring"
        aria-label="上下文用量"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle cx="18" cy="18" r="14" />
          <circle cx="18" cy="18" r="14" strokeDasharray={`${collected ? percent(usage) * 0.88 : 0} 88`} />
        </svg>
        <span>{label}</span>
      </button>
      {open && (
        <>
        <button type="button" className="context-usage-backdrop" aria-label="关闭上下文用量" onClick={() => setOpen(false)} />
        <div className="context-usage-popover" role="dialog" aria-labelledby={titleId}>
          <div className="context-usage-heading">
            <strong id={titleId}>最近一次调用</strong>
            <button type="button" aria-label="关闭上下文详情" onClick={() => { setOpen(false); trigger.current?.focus(); }}>关闭</button>
          </div>
          <p>字符估算，不代表供应商 token 窗口。</p>
          {!usage && <p>未采集</p>}
          {usage?.availability === "unknown" && <p>未知。{usage.note}</p>}
          {usage?.availability === "not_collected" && <p>未采集。{usage.note}</p>}
          {collected && usage && (
            <dl>
              <div><dt>已用 / 预算</dt><dd>{usage.usedChars?.toLocaleString("zh-CN")} / {usage.budgetChars?.toLocaleString("zh-CN")}</dd></div>
              <div><dt>总占比</dt><dd>{percent(usage)}%</dd></div>
              <div><dt>系统指令</dt><dd>{share(usage.systemChars, usage.budgetChars)}</dd></div>
              <div><dt>工具定义</dt><dd>{share(usage.toolSchemaChars, usage.budgetChars)}</dd></div>
              <div><dt>消息</dt><dd>{share(usage.messageChars, usage.budgetChars)}</dd></div>
              <div><dt>省略消息</dt><dd>{usage.omittedMessages ?? 0}</dd></div>
              <div><dt>截断的工具结果</dt><dd>{usage.trimmedToolResults ?? 0}</dd></div>
              <div><dt>时间</dt><dd title={usage.capturedAt}>{new Date(usage.capturedAt).toLocaleString("zh-CN", { hour12: false })}</dd></div>
              <div><dt>调用</dt><dd>{usage.callId}</dd></div>
            </dl>
          )}
          {collected && <p>分项为字符数与占比；分母是本次输入字符预算，不是计费 token。</p>}
        </div>
        </>
      )}
    </div>
  );
}
