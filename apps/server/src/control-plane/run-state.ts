import { applyRemoteEvent } from "../agent/cloud/remote.ts";
import type { AgentEvent, Session } from "../types.ts";
import { planeJson } from "./client.ts";
export const isRemoteActive = (state?: string) =>
  ["queued", "preparing", "running", "cancelling"].includes(state || "");

export async function reconcileRemoteSession(session: Session): Promise<void> {
  if (!session.remoteRunId || session.remoteFollowUpPending) return;
  let remote = await planeJson<
    import("@pig-agent/contracts/cloud").CloudRunSummary
  >(`/v1/runs/${encodeURIComponent(session.remoteRunId)}`);
  let transcript: Session["messages"] | undefined;
  if (remote.conversation_id) {
    const conversation = await planeJson<{
      runs: Array<{ id: string }>;
      messages: Session["messages"];
    }>(`/v1/conversations/${encodeURIComponent(remote.conversation_id)}`);
    transcript = conversation.messages;
    const latest = conversation.runs.at(-1);
    if (latest && latest.id !== session.remoteRunId) {
      remote = await planeJson<
        import("@pig-agent/contracts/cloud").CloudRunSummary
      >(`/v1/runs/${encodeURIComponent(latest.id)}`);
      session.remoteRunId = latest.id;
    }
  }
  if (
    ![
      "queued",
      "preparing",
      "running",
      "cancelling",
      "cancelled",
      "failed",
      "succeeded",
    ].includes(remote.state)
  )
    throw Error("控制面返回未知运行状态");
  const log = await planeJson<{ events: Array<{ event: AgentEvent }> }>(
    `/v1/runs/${encodeURIComponent(session.remoteRunId)}/eventlog`,
  );
  for (const { event } of log.events) {
    if (event.type !== "status" && event.type !== "error")
      applyRemoteEvent(session, event);
  }
  if (transcript?.length) session.messages = transcript;
  session.remoteState = remote.state;
  session.status = isRemoteActive(remote.state)
    ? "running"
    : remote.state === "failed"
      ? "error"
      : "idle";
  session.lastError =
    remote.state === "failed" ? remote.error || "远端执行失败" : undefined;
}
