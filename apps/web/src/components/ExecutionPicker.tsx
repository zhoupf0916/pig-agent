import type { Session, Settings } from "../types";
export function ExecutionPicker({
  session,
  settings,
  disabled,
  onChange,
}: {
  session: Session;
  settings: Settings | null;
  disabled: boolean;
  onChange: (patch: {
    executionTarget: "local" | "remote";
    engine: "pig" | "codex";
    remoteRequireApproval?: boolean;
  }) => void;
}) {
  const target =
    session.executionTarget ||
    (settings?.runtime === "cloud"
      ? settings.cloudMode === "remote"
        ? "remote"
        : "stub"
      : "local");
  const engine =
    session.engine || (settings?.runtime === "codex" ? "codex" : "pig");
  return (
    <>
      <select
        className="field !w-auto text-xs"
        aria-label="执行位置"
        disabled={disabled}
        value={target}
        onChange={(e) =>
          onChange({
            executionTarget: e.target.value as "local" | "remote",
            engine: e.target.value === "remote" ? "pig" : engine,
          })
        }
      >
        {target === "stub" && (
          <option value="stub" disabled>
            本地隔离（兼容）
          </option>
        )}
        <option value="local">本地执行</option>
        <option value="remote">远端容器</option>
      </select>
      <select
        className="field !w-auto text-xs"
        aria-label="执行引擎"
        disabled={disabled || target !== "local"}
        value={engine}
        onChange={(e) =>
          onChange({
            executionTarget: "local",
            engine: e.target.value as "pig" | "codex",
          })
        }
      >
        <option value="pig">Pig</option>
        <option value="codex">Codex</option>
      </select>
      {target === "remote" && (
        <label className="flex items-center gap-1 text-xs text-ink-600">
          <input
            type="checkbox"
            checked={!!session.remoteRequireApproval}
            disabled={disabled || !!session.remoteRunId}
            onChange={(e) =>
              onChange({
                executionTarget: "remote",
                engine: "pig",
                remoteRequireApproval: e.target.checked,
              })
            }
          />
          写入前审批
        </label>
      )}
    </>
  );
}
