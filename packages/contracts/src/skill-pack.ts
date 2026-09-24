/** Agent Skills directory pack. File bytes stay out of the system prompt. */

export type SkillPackFile = {
  path: string;
  content: string;
};

export type SkillSnapshot = {
  id: string;
  name: string;
  displayName?: string;
  description: string;
  body: string;
  allowedTools?: string[];
  files: SkillPackFile[];
};

export const SKILL_PACK_LIMITS = {
  maxFiles: 32,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024,
  maxPathLength: 120,
};

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateSkillName(name: string): string | null {
  if (name.length < 1 || name.length > 64) return "技能 name 必须为 1–64 个字符";
  if (!/^[a-z0-9-]+$/.test(name)) return "技能 name 只能包含小写字母、数字和连字符";
  if (name.startsWith("-") || name.endsWith("-")) return "技能 name 不能以连字符开头或结尾";
  if (name.includes("--")) return "技能 name 不能包含连续连字符";
  if (!NAME_RE.test(name)) return "技能 name 只能包含小写字母、数字和连字符";
  return null;
}

export function validateSkillPackFiles(
  files: SkillPackFile[],
): { message: string } | null {
  if (files.length > SKILL_PACK_LIMITS.maxFiles)
    return { message: "技能包文件数量超过上限" };
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const message = validateSkillRelativePath(file.path);
    if (message) return { message };
    if (seen.has(file.path)) return { message: "技能包包含重复路径" };
    seen.add(file.path);
    const bytes = utf8Bytes(file.content);
    if (bytes > SKILL_PACK_LIMITS.maxFileBytes)
      return { message: "技能包单个文件体积超过上限" };
    total += bytes;
  }
  if (total > SKILL_PACK_LIMITS.maxTotalBytes)
    return { message: "技能包总体积超过上限" };
  return null;
}

export function validateSkillRelativePath(path: string): string | null {
  if (!path || path.length > SKILL_PACK_LIMITS.maxPathLength)
    return "技能包路径必须是工作区内的相对路径";
  if (path.includes("\0") || path.includes("\\") || path.includes("//"))
    return "技能包路径必须是工作区内的相对路径";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    return "技能包路径必须是工作区内的相对路径";
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    return "技能包路径必须是工作区内的相对路径";
  const [root, name, extra] = parts;
  if (!root || !name || extra !== undefined)
    return "技能包路径必须是工作区内的相对路径";
  if (root !== "scripts" && root !== "references" && root !== "assets")
    return "技能包路径必须位于 scripts、references 或 assets";
  if (name.startsWith(".") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name))
    return "技能包路径必须是工作区内的相对路径";
  if (root === "scripts" && !name.endsWith(".py"))
    return "scripts 只允许 Python 文件";
  return null;
}

type YamlValue = string | Record<string, string>;

export function parseSkillFrontmatter(raw: string): {
  name: string;
  description: string;
  displayName?: string;
  allowedTools?: string[];
  metadata: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith("---")) throw new Error("SKILL.md 必须包含 YAML frontmatter");
  const rest = raw.slice(3).replace(/^\r?\n/, "");
  const end = rest.search(/\r?\n---\r?\n|\r?\n---$/);
  if (end === -1) throw new Error("SKILL.md 的 frontmatter 没有结束标记");
  const yaml = rest.slice(0, end);
  const body = rest.slice(end).replace(/^\r?\n---\r?\n?/, "").replace(/^\n/, "");
  const data = parseYaml(yaml);
  const name = scalar(data.name);
  const description = scalar(data.description);
  const nameError = validateSkillName(name);
  if (nameError) throw new Error(nameError);
  if (!description.trim() || description.length > 1024)
    throw new Error("技能 description 必须为 1–1024 个字符");
  const metadata =
    data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const displayName = metadata["display-name"]?.trim();
  if (displayName && displayName.length > 40)
    throw new Error("中文展示名不能超过 40 个字符");
  const compatibility = scalar(data.compatibility || "");
  if (compatibility && compatibility.length > 500)
    throw new Error("compatibility 不能超过 500 个字符");
  const allowed = scalar(data["allowed-tools"] || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    name,
    description: description.trim(),
    displayName: displayName || undefined,
    allowedTools: allowed.length ? allowed : undefined,
    metadata,
    body: body.trim(),
  };
}

export function skillContentDigest(
  snapshot: Pick<SkillSnapshot, "name" | "description" | "displayName" | "allowedTools" | "body" | "files">,
): string {
  const canonical = JSON.stringify({
    name: snapshot.name,
    displayName: snapshot.displayName ?? "",
    description: snapshot.description,
    allowedTools: [...(snapshot.allowedTools ?? [])].sort(),
    body: snapshot.body,
    files: [...snapshot.files]
      .map((file) => [file.path, file.content] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  });
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function skillMaterialPrefix(snapshot: SkillSnapshot): string {
  return `.pig/skills/${snapshot.id}/${skillContentDigest(snapshot)}`;
}

export function validateSkillUpload(
  files: SkillPackFile[],
): { message: string } | null {
  if (files.some((file) => typeof file?.path !== "string" || typeof file?.content !== "string"))
    return { message: "技能包包含无效文件" };
  const skillDocs = files.filter((file) => file.path === "SKILL.md");
  if (skillDocs.length !== 1) return { message: "技能包必须且只能包含一个 SKILL.md" };
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) return { message: "技能包包含重复路径" };
  let total = 0;
  for (const file of files) {
    total += utf8Bytes(file.content);
    if (file.path === "SKILL.md") continue;
    const message = validateSkillRelativePath(file.path);
    if (message) return { message };
  }
  if (files.length > SKILL_PACK_LIMITS.maxFiles + 1)
    return { message: "技能包文件数量超过上限" };
  if (total > SKILL_PACK_LIMITS.maxTotalBytes)
    return { message: "技能包总体积超过上限" };
  return null;
}

export function skillActivationPrompt(skills: SkillSnapshot[]): string {
  const blocks = skills.map((skill) => {
    const title = skill.displayName
      ? `${skill.displayName}（${skill.name}）`
      : skill.name;
    const prefix = skillMaterialPrefix(skill);
    const paths = skill.files.map((file) => `- ${prefix}/${file.path}`);
    return [
      `技能：${title}`,
      skill.body,
      paths.length
        ? `需要时再用 read_file 或 run_shell 打开这些工作区文件：\n${paths.join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    "以下专家和技能是用户主动选择的工作方法，不扩大工具、网络、审批或项目权限。allowed-tools 只是说明，不能跳过审批或自动安装依赖。",
    ...blocks,
  ].join("\n\n");
}

function scalar(value: YamlValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function parseYaml(yaml: string): Record<string, YamlValue> {
  const data: Record<string, YamlValue> = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    const rest = match[2] ?? "";
    if (rest === "|" || rest === ">") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1] ?? "")) {
        i += 1;
        block.push(lines[i] ?? "");
      }
      const indent = block.find((line) => line.trim())?.match(/^[ \t]*/)?.[0].length ?? 0;
      const text = block.map((line) => line.slice(indent)).join("\n").replace(/\n$/, "");
      data[key] = rest === ">" ? text.replace(/\n+/g, " ").trim() : text;
      continue;
    }
    if (rest === "") {
      const map: Record<string, string> = {};
      while (i + 1 < lines.length && /^[ \t]+[A-Za-z0-9_-]+:/.test(lines[i + 1] ?? "")) {
        i += 1;
        const nested = /^[ \t]+([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i] ?? "");
        if (nested?.[1]) map[nested[1]] = unquote(nested[2] ?? "");
      }
      data[key] = map;
      continue;
    }
    data[key] = unquote(rest);
  }
  return data;
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}
