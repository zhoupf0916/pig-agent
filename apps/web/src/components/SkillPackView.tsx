import { useRef, useState } from "react";
import {
  parseSkillFrontmatter,
  validateSkillPackFiles,
  SKILL_PACK_LIMITS,
  type SkillPackFile,
} from "@pig-agent/contracts";
import "./skills.css";

export function SkillPackFiles({ files = [] }: { files?: SkillPackFile[] }) {
  return files.length ? (
    <section>
      <h3>脚本与参考文件 · {files.length}</h3>
      <p className="muted">按需读取；运行脚本仍须遵守任务的沙箱与审批设置。</p>
      <div className="skill-file-list">
        {files.map((file) => (
          <details key={file.path}>
            <summary>{file.path}</summary>
            <pre>{file.content}</pre>
          </details>
        ))}
      </div>
    </section>
  ) : (
    <p className="muted">此技能仅含操作指南，没有附加文件。</p>
  );
}

export function SkillPackImporter({
  onImport,
}: {
  onImport: (files: SkillPackFile[]) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<SkillPackFile[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="skill-importer">
      <input
        hidden
        ref={input}
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        aria-label="导入技能文件夹"
        onChange={async (e) => {
          setError("");
          setFiles([]);
          const selected = Array.from(e.target.files || []);
          e.target.value = "";
          try {
            if (!selected.length) return;
            if (
              selected.length > SKILL_PACK_LIMITS.maxFiles + 1 ||
              selected.some((f) => f.size > SKILL_PACK_LIMITS.maxFileBytes) ||
              selected.reduce((sum, f) => sum + f.size, 0) >
                SKILL_PACK_LIMITS.maxTotalBytes
            )
              throw new Error(
                "技能包过大：最多 32 个资源文件、单文件 64 KiB、合计 256 KiB",
              );
            const contents = await Promise.all(
              selected.map(async (file) => ({
                path: (file.webkitRelativePath || file.name).replace(
                  /^[^/]+\//,
                  "",
                ),
                content: new TextDecoder("utf-8", { fatal: true }).decode(
                  await file.arrayBuffer(),
                ),
              })),
            );
            const entry = contents.find((f) => f.path === "SKILL.md");
            if (!entry)
              throw new Error("请选择根目录包含 SKILL.md 的技能文件夹");
            const parsed = parseSkillFrontmatter(entry.content);
            const folder = selected[0]?.webkitRelativePath.split("/")[0];
            if (folder && folder !== parsed.name)
              throw new Error("文件夹名称必须与 SKILL.md 的 name 一致");
            const invalid = validateSkillPackFiles(
              contents.filter((f) => f.path !== "SKILL.md"),
            );
            if (invalid) throw new Error(invalid.message);
            setFiles(contents);
            setName(parsed.displayName || parsed.name);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        导入技能文件夹
      </button>
      {error && (
        <p role="alert" className="resource-error">
          {error}
        </p>
      )}
      {files.length > 0 && (
        <div className="cloud-note">
          <strong>{name}</strong>
          <p>
            {files.length} 个文件：{files.map((f) => f.path).join("、")}
          </p>
          <p className="muted">
            支持 UTF-8 文本、Python 脚本、参考资料和文本模板；导入不会执行脚本。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onImport(files);
                setFiles([]);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "正在导入…" : "确认导入"}
          </button>
          <button type="button" disabled={busy} onClick={() => setFiles([])}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}
