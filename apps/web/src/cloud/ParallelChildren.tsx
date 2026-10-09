import { useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Loader2, RotateCcw, XCircle } from "lucide-react";
import "./parallel.css";

type Item = { idx: number; item: string; state: string; attempts: number; child_run_id: string | null; error: string | null; model_calls: number; preview: string | null; run_state: string | null };
type Group = { call_id: string; instruction: string; state: string; max_parallel: number; created_at: string; completed_at: string | null; items: Item[] };

const stateLabel: Record<string, string> = { pending: "等待", running: "执行中", succeeded: "完成", failed: "失败", cancelled: "已取消" };
const icon = (state: string) =>
  state === "succeeded" ? <CheckCircle2 size={14} aria-hidden /> : state === "failed" || state === "cancelled" ? <XCircle size={14} aria-hidden /> : state === "running" ? <Loader2 size={14} className="pc-spin" aria-hidden /> : <CircleDashed size={14} aria-hidden />;

/** Child-task grid for a run that used spawn_parallel: progress, per-item result preview, retry of failed items. */
export function ParallelChildren({ runId, active, waiting, canWrite, request }: { runId: string; active: boolean; waiting: boolean; canWrite: boolean; request: (path: string, method?: string, body?: unknown) => Promise<unknown> }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    const load = () =>
      request(`/v1/runs/${runId}/children`)
        .then((d) => { if (!stop) { setGroups((d as { groups: Group[] }).groups); setError(""); } })
        .catch((e) => { if (!stop) setError(e instanceof Error ? e.message : "加载子任务失败"); });
    void load();
    const timer = active ? setInterval(load, 2000) : undefined;
    return () => { stop = true; if (timer) clearInterval(timer); };
  }, [runId, active, tick]);
  if (!groups.length) return error ? <p className="pc-error">{error}</p> : null;
  return (
    <>
      {groups.map((g) => {
        const done = g.items.filter((i) => ["succeeded", "failed", "cancelled"].includes(i.state)).length;
        return (
          <section key={g.call_id} className="pc-group" aria-label="并行子任务">
            <header>
              <strong>并行子任务</strong>
              <span>{done}/{g.items.length} 已结束 · 同时 {g.max_parallel} 个{g.state === "running" ? "" : g.state === "completed" ? " · 已汇总" : " · 已取消"}</span>
            </header>
            <p className="pc-instruction" title={g.instruction}>{g.instruction}</p>
            <progress max={g.items.length} value={done} aria-label="子任务进度" />
            <ol className="pc-grid">
              {g.items.map((i) => (
                <li key={i.idx} data-state={i.state}>
                  <div className="pc-head">
                    {icon(i.state)}
                    <span className="pc-index">{i.idx + 1}</span>
                    <span className="pc-item" title={i.item}>{i.item}</span>
                    <span className="pc-state">{stateLabel[i.state] ?? i.state}{i.attempts > 1 ? ` · 第 ${i.attempts} 次` : ""}</span>
                  </div>
                  {(i.preview || i.error) && <p className="pc-body" title={i.error || i.preview || ""}>{i.error || i.preview}</p>}
                  {waiting && canWrite && g.state === "running" && (i.state === "failed" || i.state === "cancelled") && (
                    <button type="button" onClick={() => void request(`/v1/runs/${runId}/children/${encodeURIComponent(g.call_id)}/${i.idx}/retry`, "POST", {}).then(() => setTick((t) => t + 1)).catch((e) => setError(e instanceof Error ? e.message : "重试失败"))}>
                      <RotateCcw size={13} aria-hidden /> 重试
                    </button>
                  )}
                </li>
              ))}
            </ol>
            {error && <p className="pc-error">{error}</p>}
          </section>
        );
      })}
    </>
  );
}
