import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { MarkdownView } from "./MarkdownView";
import type { TurnView } from "../lib/conversation-turns";

const OUTCOME_LABEL = {
  running: "正在执行",
  approval: "等待批准",
  failed: "本轮失败",
  cancelled: "已取消",
  answered: "",
  no_answer: "本轮没有最终回答",
} as const;

export function TurnTranscript({ turns, extras }: { turns: TurnView[]; extras?: ReactNode }) {
  return (
    <div className="conv-column">
      {turns.map((turn) => (
        <article key={turn.id} className="conv-turn">
          {turn.userText && (
            <div className="conv-user-block">
              {turn.author && <small className="conv-author">{turn.author}</small>}
              <div className="conv-user">{turn.userText}</div>
              {turn.attachments?.map((file) => (
                <a className="message-input-file" key={file.id} href={file.href} download>
                  <FileText size={14} />
                  {file.name}
                  {file.detail && <small>{file.detail}</small>}
                </a>
              ))}
            </div>
          )}
          {(turn.collapsed.length > 0 || turn.notes.length > 0) && (
            <details className="conv-activity">
              <summary>
                执行过程
                <span>{turn.collapsed.length ? ` · ${turn.collapsed.length} 项已完成` : ""}</span>
              </summary>
              {turn.notes.map((note) => <pre key={note} className="conv-log">{note}</pre>)}
              {turn.collapsed.map((row) => (
                <details key={row.id} className="conv-log-item">
                  <summary>{row.title}{row.detail ? ` · ${row.detail}` : ""}</summary>
                  <pre className="conv-log">{row.output || "这次操作没有文本输出。"}</pre>
                </details>
              ))}
            </details>
          )}
          {turn.current && <p className="conv-current" role="status">{turn.current.title}{turn.current.detail ? ` · ${turn.current.detail}` : ""}</p>}
          {turn.visible.map((row) => (
            <div key={row.id} className={`conv-alert ${row.state}`} role={row.state === "failed" ? "alert" : "status"}>
              <strong>{row.state === "cancelled" ? "未执行" : row.state === "approval" ? "等待批准" : row.state === "failed" ? "失败" : row.title}</strong>
              <span>{row.title}{row.detail ? ` · ${row.detail}` : ""}</span>
              {row.output && <pre className="conv-log">{row.output}</pre>}
            </div>
          ))}
          {turn.outcome !== "answered" && turn.notice && (
            <p className={`conv-notice ${turn.outcome}`} role={turn.outcome === "failed" ? "alert" : "status"}>
              <strong>{OUTCOME_LABEL[turn.outcome]}</strong>
              {turn.notice}
            </p>
          )}
          {turn.outcome === "no_answer" && !turn.notice && (
            <p className="conv-notice no_answer" role="status"><strong>本轮没有最终回答</strong></p>
          )}
          {turn.answer && (
            <div className={`conv-answer ${turn.answerStreaming ? "is-streaming" : ""}`}>
              <MarkdownView text={turn.answer} />
            </div>
          )}
        </article>
      ))}
      {extras}
    </div>
  );
}
