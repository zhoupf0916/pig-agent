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

export function isJson(path: string): boolean {
  return extOf(path) === "json";
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

export function isImage(path: string, mimeType?: string): boolean {
  if (mimeType?.toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXT.has(extOf(path));
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

export function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function toolLabel(name: string): string {
  const map: Record<string, string> = {
    update_plan: "更新计划",
    list_dir: "列出目录",
    read_file: "读取文件",
    write_file: "写入文件",
    edit_file: "编辑文件",
    apply_patch: "应用补丁",
    search_files: "搜索文件",
    delete_file: "删除文件",
    move_file: "移动文件",
    run_shell: "运行命令",
    http_fetch: "抓取网页",
    list_skills: "列出技能",
    load_skill: "加载技能",
    command_execution: "运行命令",
    file_change: "变更文件",
    web_search: "网页搜索",
    mcp_tool_call: "MCP 工具",
  };
  return map[name] ?? name;
}

export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  if (typeof rec.path === "string") return rec.path;
  if (typeof rec.from === "string" && typeof rec.to === "string") {
    return `${rec.from} → ${rec.to}`;
  }
  if (typeof rec.command === "string") return rec.command;
  if (typeof rec.query === "string") return rec.query;
  if (typeof rec.url === "string") return rec.url;
  if (typeof rec.name === "string") return rec.name;
  return "";
}

export function searchHitLabel(type: string): string {
  if (type === "session") return "会话";
  if (type === "project") return "项目";
  if (type === "todo") return "待办";
  if (type === "asset") return "资产";
  if (type === "project_message") return "动态";
  if (type === "memory") return "记忆";
  return type;
}

export function artifactLabel(action: string): string {
  if (action === "created") return "新建";
  if (action === "modified") return "修改";
  if (action === "deleted") return "删除";
  if (action === "moved") return "移动";
  return action;
}
