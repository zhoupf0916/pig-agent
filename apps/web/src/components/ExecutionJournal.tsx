import type { AgentEvent } from "../types";
import { executionJournal } from "../lib/execution-journal";
import { redactSecretsForDisplay } from "../lib/remote-retry";

export function ExecutionJournal({ events }: { events: AgentEvent[] }) {
  const entries = executionJournal(events);
  return (
    <section aria-label="执行步骤日志" className="space-y-2">
      {!entries.length && (
        <p className="text-sm text-ink-600">
          暂无工具操作或错误。回复显示在会话中。
        </p>
      )}
      {entries.map((entry) => (
        <details
          key={entry.key}
          className={`rounded-btn border p-3 text-sm ${entry.failed ? "border-danger text-danger" : "border-ink-300"}`}
        >
          <summary className="cursor-pointer">
            <span>{entry.title}</span>
            <span className="float-right text-xs">
              {entry.failed ? "失败" : entry.running ? "执行中" : "完成"}
            </span>
          </summary>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">
            {redactSecretsForDisplay(entry.detail)}
          </pre>
        </details>
      ))}
      {!!events.length && (
        <details className="pt-3 text-xs text-ink-600">
          <summary className="cursor-pointer">
            诊断：原始事件（{events.length}）
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words">
            {redactSecretsForDisplay(JSON.stringify(events, null, 2))}
          </pre>
        </details>
      )}
    </section>
  );
}
