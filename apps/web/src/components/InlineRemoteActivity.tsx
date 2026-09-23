import { useRef, useState } from "react";
import { Check, ShieldCheck, Terminal, FileText } from "lucide-react";
import type { CloudApproval } from "@pig-agent/contracts/cloud";
import {
  approvalAllowed,
  remoteRequest,
  remoteStateLabels,
  type RemoteActivity,
} from "../lib/remote-activity";
import { redactSecretsForDisplay } from "../lib/remote-retry";
export function InlineRemoteActivity({
  activity,
  runId,
  onOpenDetails,
}: {
  activity: RemoteActivity;
  runId: string;
  onOpenDetails: () => void;
}) {
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [decided, setDecided] = useState<Record<string, string>>({});
  const lock = useRef(false);
  const reviews = activity.approvals.filter(
    (a) => a.state === "pending" || a.state === "approved",
  );
  const terminal =
    activity.run &&
    ["succeeded", "failed", "cancelled"].includes(activity.run.state);
  const eligible = approvalAllowed(activity.run?.state);
  async function decide(
    approval: CloudApproval,
    decision: "approve" | "reject",
  ) {
    if (lock.current || !eligible || activity.run?.can_write === false) return;
    lock.current = true;
    setPending(approval.id);
    setError("");
    try {
      await remoteRequest(
        `/v1/runs/${runId}/approvals/${approval.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      setDecided((v) => ({ ...v, [approval.id]: decision }));
      activity.onApprovalDecided?.(
        approval.id,
        decision === "approve" ? "approved" : "rejected",
      );
    } catch (e) {
      setError(
        redactSecretsForDisplay(e instanceof Error ? e.message : String(e)),
      );
    } finally {
      lock.current = false;
      setPending("");
    }
  }
  return (
    <section className="remote-activity" aria-label="当前远端执行">
      <div className="execution-summary">
        <span className="status-dot" />
        <strong>
          {reviews.some((a) => a.state === "pending" && !decided[a.id]) &&
          eligible
            ? "等待审批"
            : activity.run
              ? remoteStateLabels[activity.run.state]
              : "正在连接执行记录"}
        </strong>
        <span>远端容器</span>
        <button className="text-action" onClick={onOpenDetails}>
          日志与运行详情
        </button>
      </div>
      {activity.error && (
        <p role="alert" className="notice error">
          连接暂时中断，正在重新连接。{redactSecretsForDisplay(activity.error)}
        </p>
      )}
      {error && (
        <p role="alert" className="notice error">
          操作未确认：{error}。可重试，决定由控制面校验。
        </p>
      )}
      {!terminal &&
        reviews.map((a) => {
          const args = a.args;
          const path = String(args.path ?? args.file_path ?? args.file ?? "");
          const command = String(args.command ?? args.cmd ?? "");
          const content =
            args.content ?? args.new_string ?? args.replacement ?? args.patch;
          const accepted =
            a.state === "approved" || decided[a.id] === "approve";
          const rejected = decided[a.id] === "reject";
          if (accepted || rejected)
            return (
              <p key={a.id} className="notice" role="status">
                {accepted
                  ? "已批准，等待执行器确认。"
                  : "已拒绝，正在结束本轮。"}
              </p>
            );
          return (
            <article
              key={a.id}
              className="approval-card"
              aria-label="当前操作审批"
            >
              <header>
                <ShieldCheck size={20} />
                <div>
                  <h3>
                    {accepted
                      ? "已批准操作"
                      : rejected
                        ? "已拒绝操作"
                        : terminal
                          ? "审批已失效"
                          : "需要你批准"}
                  </h3>
                  <p>
                    {accepted
                      ? "授权已提交，执行结果将在会话中更新。"
                      : rejected
                        ? "本轮将结束，未授权此操作。"
                        : a.mcp_target ? "批准后由外部 MCP 服务执行，不受本机沙箱约束。" : "批准后将在远端工作区执行以下操作。"}
                  </p>
                </div>
              </header>
              {a.mcp_target && <p className="approval-mcp-target"><strong>{a.mcp_target.serverName}</strong> · <code>{a.mcp_target.url}</code></p>}
              <div className="operation-target">
                {command ? <Terminal size={17} /> : <FileText size={17} />}
                <strong>{path || a.tool}</strong>
                <span>{a.tool}</span>
              </div>
              {command && (
                <pre className="approval-code">
                  {redactSecretsForDisplay(command)}
                </pre>
              )}
              {content !== undefined && (
                <div className="proposed-content">
                  <span>拟写入内容{args.old_string ? " · 替换预览" : ""}</span>
                  {args.old_string !== undefined && (
                    <pre className="removed-content">
                      {redactSecretsForDisplay(String(args.old_string))}
                    </pre>
                  )}
                  <pre>{redactSecretsForDisplay(String(content))}</pre>
                </div>
              )}
              <p className="approval-scope">
                影响范围：远端容器{path ? ` / ${path}` : "内的命令或工具操作"}
                。执行计时已暂停，审批最多等待 30 分钟。
              </p>
              <details>
                <summary>高级：完整操作参数</summary>
                <pre className="approval-code">
                  {redactSecretsForDisplay(JSON.stringify(args, null, 2))}
                </pre>
              </details>
              {eligible &&
                !accepted &&
                !rejected &&
                activity.run?.can_write !== false && (
                  <footer>
                    <button
                      className="btn-quiet"
                      disabled={!!pending}
                      onClick={() => void decide(a, "reject")}
                    >
                      拒绝并结束本轮
                    </button>
                    <button
                      className="btn-primary"
                      disabled={!!pending}
                      onClick={() => void decide(a, "approve")}
                    >
                      <Check size={16} />
                      {pending === a.id ? "提交中…" : "批准操作"}
                    </button>
                  </footer>
                )}
              {activity.run?.can_write === false && (
                <p className="approval-scope">
                  当前为只读权限，需项目编辑者审批。
                </p>
              )}
            </article>
          );
        })}
    </section>
  );
}
