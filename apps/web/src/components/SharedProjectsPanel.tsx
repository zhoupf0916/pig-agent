import { useEffect, useState } from "react";
import type {
  CloudSpace,
  CloudSharedProject,
  CloudRunSummary,
} from "@pig-agent/contracts/cloud";
const roleNames = { viewer: "只读", editor: "编辑", admin: "管理员" };
async function api(path: string, method = "GET", body?: unknown, key?: string) {
  const r = await fetch("/api/remote/v1" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "控制面请求失败");
  return data;
}
export function SharedProjectsPanel({
  onRun,
}: {
  onRun: (id: string) => void;
}) {
  const [spaces, setSpaces] = useState<CloudSpace[]>([]),
    [projects, setProjects] = useState<CloudSharedProject[]>([]);
  const [spaceId, setSpaceId] = useState(""),
    [projectId, setProjectId] = useState("");
  const [members, setMembers] = useState<
    Array<{ id: string; name: string; role: keyof typeof roleNames }>
  >([]);
  const [runs, setRuns] = useState<CloudRunSummary[]>([]),
    [name, setName] = useState(""),
    [projectName, setProjectName] = useState(""),
    [joinCode, setJoinCode] = useState(""),
    [invite, setInvite] = useState(""),
    [role, setRole] = useState<keyof typeof roleNames>("viewer");
  const [requireApproval, setRequireApproval] = useState(false);
  const [prompt, setPrompt] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const selected = spaces.find((s) => s.id === spaceId),
    project = projects.find((p) => p.id === projectId);
  async function refresh() {
    const [a, b] = await Promise.all([api("/spaces"), api("/shared-projects")]);
    setSpaces(a.spaces);
    setProjects(b.projects);
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => setInvite(""), [spaceId]);
  useEffect(() => {
    let disposed = false;
    setMembers([]);
    if (spaceId)
      void api(`/spaces/${spaceId}/members`)
        .then((d) => {
          if (!disposed) setMembers(d.members);
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [spaceId, busy]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setRuns([]);
    async function poll() {
      try {
        const d = await api(`/shared-projects/${projectId}/runs`);
        if (!disposed) setRuns(d.runs);
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        if (!disposed) timer = setTimeout(poll, 3000);
      }
    }
    if (projectId) void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [projectId]);
  return (
    <div className="min-h-0 flex-1 overflow-auto space-y-5 p-5">
      <p className="text-sm text-ink-500">
        共享项目中的会话、文件版本和运行记录对组织成员可见。新任务从空的远端工作区开始，不上传本机目录。
      </p>
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          className="field flex-1"
          aria-label="组织名称"
          placeholder="创建组织"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="btn-ghost"
          disabled={busy || !name.trim()}
          onClick={() =>
            void action(async () => {
              const d = await api("/spaces", "POST", { name });
              setSpaceId(d.id);
              setName("");
            })
          }
        >
          创建组织
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          className="field flex-1"
          aria-label="组织邀请码"
          type="password"
          placeholder="使用组织邀请码加入"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
        />
        <button
          className="btn-ghost"
          disabled={busy || !joinCode.trim()}
          onClick={() =>
            void action(async () => {
              const d = await api("/spaces/join", "POST", {
                invite: joinCode.trim(),
              });
              setSpaceId(d.id);
              setJoinCode("");
            })
          }
        >
          加入组织
        </button>
      </div>
      <label className="block text-sm">
        组织
        <select
          className="field mt-1"
          value={spaceId}
          onChange={(e) => {
            setSpaceId(e.target.value);
            setProjectId("");
          }}
        >
          <option value="">选择组织</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {roleNames[s.role]}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <>
          <details className="rounded-card border border-ink-300 p-3">
            <summary>成员与权限（{members.length}）</summary>
            {members.map((m) => (
              <div
                key={m.id}
                className="flex flex-wrap items-center gap-2 mt-2 text-sm"
              >
                <span>
                  {m.name} · {roleNames[m.role]}
                  {m.id === selected.owner_id ? " · 创建者" : ""}
                </span>
                {selected.role === "admin" && m.id !== selected.owner_id && (
                  <>
                    <select
                      className="field !w-auto"
                      aria-label={`${m.name}的角色`}
                      disabled={busy}
                      value={m.role}
                      onChange={(e) =>
                        void action(async () => {
                          await api(
                            `/spaces/${spaceId}/members/${m.id}`,
                            "PATCH",
                            { role: e.target.value },
                          );
                        })
                      }
                    >
                      {Object.entries(roleNames).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn-ghost"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api(
                            `/spaces/${spaceId}/members/${m.id}`,
                            "DELETE",
                          );
                        })
                      }
                    >
                      移除成员
                    </button>
                  </>
                )}
              </div>
            ))}
            {selected.role === "admin" && (
              <div className="space-y-2 mt-3">
                <select
                  className="field"
                  aria-label="邀请成员角色"
                  value={role}
                  onChange={(e) =>
                    setRole(e.target.value as keyof typeof roleNames)
                  }
                >
                  {Object.entries(roleNames).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const d = await api(
                        `/spaces/${spaceId}/invitations`,
                        "POST",
                        { role },
                      );
                      setInvite(d.invite);
                    })
                  }
                >
                  生成一次性组织邀请
                </button>
                {invite && (
                  <label className="block text-xs">
                    24 小时有效；仅供已有平台账号加入此组织
                    <input
                      className="field mt-1"
                      readOnly
                      value={invite}
                      aria-label="生成的组织邀请码"
                    />
                  </label>
                )}
              </div>
            )}
          </details>
          {selected.role !== "viewer" && (
            <div className="flex flex-wrap gap-2">
              <input
                className="field flex-1"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="共享项目名称"
                aria-label="共享项目名称"
              />
              <button
                className="btn-ghost"
                disabled={busy || !projectName.trim()}
                onClick={() =>
                  void action(async () => {
                    const d = await api("/shared-projects", "POST", {
                      spaceId,
                      name: projectName,
                    });
                    setProjectId(d.id);
                    setProjectName("");
                  })
                }
              >
                创建共享项目
              </button>
            </div>
          )}
          <label className="block text-sm">
            共享项目
            <select
              className="field mt-1"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">选择项目</option>
              {projects
                .filter((p) => p.space_id === spaceId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        </>
      )}
      {project && (
        <>
          <h3 className="font-medium">{project.name}</h3>
          {project.role !== "viewer" ? (
            <div className="space-y-2">
              <label className="text-sm flex gap-2">
                <input
                  type="checkbox"
                  checked={requireApproval}
                  onChange={(e) => {
                    setRequireApproval(e.target.checked);
                    setKey(crypto.randomUUID());
                  }}
                />
                写入或执行命令前要求审批
              </label>
              <textarea
                className="field"
                aria-label="共享项目任务"
                placeholder="给这个共享项目创建远端任务"
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              />
              <button
                className="btn-ghost"
                disabled={busy || !prompt.trim()}
                onClick={() =>
                  void action(async () => {
                    const d = await api(
                      "/runs",
                      "POST",
                      { projectId, prompt, requireApproval },
                      key,
                    );
                    setPrompt("");
                    setKey(crypto.randomUUID());
                    onRun(d.id);
                  })
                }
              >
                在共享项目运行
              </button>
            </div>
          ) : (
            <p className="text-sm text-ink-500">
              你拥有只读权限，可以查看运行记录和下载成果。
            </p>
          )}
          {runs.map((r) => (
            <button
              className="block w-full text-left rounded-card border border-ink-300 p-3 mt-2"
              key={r.id}
              onClick={() => onRun(r.id)}
            >
              {r.prompt}
              <span className="ml-2 text-xs text-ink-500">{r.state}</span>
            </button>
          ))}
          {!runs.length && (
            <p className="text-sm text-ink-500">暂无运行记录。</p>
          )}
        </>
      )}
    </div>
  );
}
