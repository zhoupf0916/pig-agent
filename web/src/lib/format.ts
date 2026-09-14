const CODE_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "rb",
  "php",
  "css",
  "scss",
  "html",
  "vue",
  "svelte",
  "sh",
  "bash",
  "zsh",
  "yml",
  "yaml",
  "toml",
  "sql",
  "md",
  "txt",
  "env",
]);

export function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i === -1 ? "" : base.slice(i + 1).toLowerCase();
}

export function isMarkdown(path: string): boolean {
  return extOf(path) === "md" || extOf(path) === "mdx";
}

export function isTextLike(path: string): boolean {
  const ext = extOf(path);
  return ext === "" || CODE_EXT.has(ext);
}

export function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function formatBytes(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function toolLabel(name: string): string {
  const map: Record<string, string> = {
    update_plan: "更新计划",
    list_dir: "列出目录",
    read_file: "读取文件",
    write_file: "写入文件",
    edit_file: "编辑文件",
    run_shell: "运行命令",
    list_skills: "列出技能",
    load_skill: "加载技能",
  };
  return map[name] ?? name;
}
