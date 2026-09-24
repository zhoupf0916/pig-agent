export type NetworkPhase = "dns" | "connect" | "response";
export class NetworkAccessError extends Error {
  constructor(
    public readonly code: string,
    public readonly phase: NetworkPhase,
    message: string,
  ) {
    super(message);
    this.name = "NetworkAccessError";
  }
}
/** Public diagnostics contain no resolver IPs, credentials, response bodies or raw exceptions. */
export function networkFailure(
  error: unknown,
  phase: NetworkPhase,
  signal?: AbortSignal,
): NetworkAccessError {
  if (error instanceof NetworkAccessError) return error;
  const raw = error as { code?: string; name?: string; message?: string };
  if (signal?.aborted)
    return signal.reason?.name === "TimeoutError"
      ? new NetworkAccessError(
          "NETWORK_TIMEOUT",
          phase,
          `网络${phase === "dns" ? "解析" : phase === "connect" ? "连接" : "读取"}超时；目标可能无法从当前服务器访问。`,
        )
      : new NetworkAccessError(
          "NETWORK_CANCELLED",
          phase,
          "网络访问已取消，任务或授权已失效。",
        );
  if (/非公网|内网|元数据|本机地址/.test(raw?.message || ""))
    return new NetworkAccessError(
      "NETWORK_POLICY",
      phase,
      "目标解析到非公网地址，已被安全策略阻止。",
    );
  if (phase === "dns")
    return new NetworkAccessError(
      "DNS_FAILED",
      phase,
      "域名解析失败；请检查目标域名和服务器 DNS 配置。",
    );
  if (/CERT|TLS|SSL/.test(raw?.code || ""))
    return new NetworkAccessError(
      "TLS_FAILED",
      phase,
      "目标 TLS 证书或握手失败；未降低证书校验要求。",
    );
  if (raw?.code === "ECONNREFUSED")
    return new NetworkAccessError(
      "CONNECTION_REFUSED",
      phase,
      "目标拒绝连接；审批已通过，但目标服务不可达。",
    );
  if (raw?.code === "ECONNRESET")
    return new NetworkAccessError(
      "CONNECTION_RESET",
      phase,
      "目标或中间网络重置了连接；审批已通过，这不是沙箱拒绝联网。",
    );
  return new NetworkAccessError(
    "NETWORK_UNREACHABLE",
    phase,
    "目标网络不可达或响应中断；审批已通过，请检查服务器出站链路或更换资料来源。",
  );
}
