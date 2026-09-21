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
  }) => void;
}) {
  const target =
    session.executionTarget ||
    (settings?.runtime === "cloud" ? "remote" : "local");
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
        <option value="local">本地执行</option>
        <option value="remote">远端容器</option>
      </select>
      <select
        className="field !w-auto text-xs"
        aria-label="执行引擎"
        disabled={disabled || target === "remote"}
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
    </>
  );
}
