import { useEffect, useState } from "react";
export function FileEditor({
  path,
  content,
  dirty,
  readOnly,
  notice,
  onBack,
  onChange,
  onSave,
  saving,
}: {
  path: string;
  content: string;
  dirty: boolean;
  readOnly: boolean;
  notice: string;
  saving: boolean;
  onBack: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => setConfirmLeave(false), [path]);
  return (
    <section className="file-editor" aria-label="文件编辑">
      <header className="file-editor-bar">
        <button type="button" disabled={saving} onClick={() => { if (dirty) setConfirmLeave(true); else onBack(); }}>返回对话</button>
        <strong>{path}</strong>
        <span>{readOnly ? "只读" : dirty ? "未保存" : "已保存"}</span>
        {!readOnly && (
          <button type="button" onClick={onSave} disabled={saving || !dirty}>
            {saving ? "保存中…" : "保存"}
          </button>
        )}
      </header>
      {confirmLeave && (
        <div className="file-editor-confirm" role="alertdialog" aria-label="未保存的文件修改">
          <span>还有未保存的修改。</span>
          <button type="button" onClick={() => setConfirmLeave(false)}>继续编辑</button>
          <button type="button" onClick={onBack}>放弃修改并返回</button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {readOnly ? (
        <pre className="file-editor-text">{content}</pre>
      ) : (
        <textarea
          className="file-editor-text"
          aria-label="文件内容"
          value={content}
          disabled={saving}
          spellCheck={false}
          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); if (dirty && !saving) onSave(); } }}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </section>
  );
}
