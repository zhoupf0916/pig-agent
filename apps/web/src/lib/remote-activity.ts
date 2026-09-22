import { useEffect, useState } from "react";
import type {
  CloudApproval,
  CloudRunSummary,
} from "@pig-agent/contracts/cloud";
export type RemoteActivity = {
  run: CloudRunSummary | null;
  approvals: CloudApproval[];
  error: string;
  loading: boolean;
  onApprovalDecided?: (id: string, state: "approved" | "rejected") => void;
};
export const remoteStateLabels: Record<string, string> = {
  queued: "排队中",
  preparing: "准备环境",
  running: "执行中",
  cancelling: "取消中",
  cancelled: "已取消",
  succeeded: "已完成",
  failed: "执行失败",
};
export async function remoteRequest(path: string, init?: RequestInit) {
  const response = await fetch(`/api/remote${path}`, {
    signal: AbortSignal.timeout(12000),
    ...init,
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || `请求失败 (${response.status})`);
  return data;
}
export function approvalAllowed(state?: string) {
  return state === "running" || state === "preparing";
}
export function activityForRun(
  state: RemoteActivity & { identity?: string },
  runId?: string,
): RemoteActivity {
  return state.identity === runId
    ? state
    : { run: null, approvals: [], error: "", loading: !!runId };
}
/** A confirmed decision cannot return to pending when an older poll completes. */
export function reconcileApprovals(
  previous: CloudApproval[],
  incoming: CloudApproval[],
) {
  return incoming.map((approval) => {
    const confirmed = previous.find(
      (a) => a.id === approval.id && a.state !== "pending",
    );
    return approval.state === "pending" && confirmed ? confirmed : approval;
  });
}
export function useRemoteActivity(runId?: string): RemoteActivity {
  const [state, setState] = useState<RemoteActivity & { identity?: string }>({
    run: null,
    approvals: [],
    error: "",
    loading: false,
  });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setState({
      identity: runId,
      run: null,
      approvals: [],
      error: "",
      loading: !!runId,
    });
    if (!runId) return;
    async function poll() {
      try {
        const [run, review] = await Promise.all([
          remoteRequest(`/v1/runs/${runId}`),
          remoteRequest(`/v1/runs/${runId}/approvals`),
        ]);
        if (active)
          setState((current) => ({
            identity: runId,
            run,
            approvals: reconcileApprovals(
              current.identity === runId ? current.approvals : [],
              review.approvals,
            ),
            error: "",
            loading: false,
          }));
      } catch (error) {
        if (active)
          setState((s) => ({
            ...s,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
          }));
      } finally {
        if (active) timer = setTimeout(poll, 1800);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [runId]);
  return {
    ...activityForRun(state, runId),
    onApprovalDecided: (id, decision) =>
      setState((current) =>
        current.identity !== runId
          ? current
          : {
              ...current,
              approvals: current.approvals.map((approval) =>
                approval.id === id
                  ? { ...approval, state: decision }
                  : approval,
              ),
            },
      ),
  };
}
