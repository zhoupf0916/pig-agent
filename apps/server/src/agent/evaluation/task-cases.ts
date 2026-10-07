/** End-to-end task eval cases: workspace fixture + deterministic graders. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TaskCheck = { name: string; pass: (input: { root: string; reply: string; tools: string[] }) => boolean };
/** rubric: optional natural-language grading criteria for the LLM judge (--judge). */
export type TaskCase = { id: string; prompt: string | string[]; files: Record<string, string>; checks: TaskCheck[]; tags?: string[]; rubric?: string };

const read = (root: string, p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "");
const log = Array.from({ length: 400 }, (_, i) => `2026-10-0${(i % 9) + 1} INFO worker-${i % 5} batch ${i} ok${i % 41 === 0 ? " ERROR db timeout" : ""}`).join("\n");

export function taskCases(): TaskCase[] {
  return [
    {
      id: "list-and-summarize",
      prompt: "notes 目录里有哪些文件？每个一句话说明。",
      files: { "notes/todo.txt": "- 写周报\n- 修复登录 bug\n", "notes/meeting.md": "# 周会\n讨论发布计划" },
      checks: [
        { name: "mentions both files", pass: ({ reply }) => reply.includes("todo.txt") && reply.includes("meeting.md") },
        { name: "used a read tool", pass: ({ tools }) => tools.some((t) => ["list_dir", "read_file", "search_files", "spawn_subagent"].includes(t)) },
      ],
      tags: ["read"],
      rubric: "回复必须基于真实文件内容：todo.txt 是待办（写周报、修复登录 bug），meeting.md 是周会/发布计划记录；每个文件一句话，不能编造不存在的文件或内容。",
    },
    {
      id: "write-file",
      prompt: "创建 hello.txt，内容只有一行：hello pig",
      files: {},
      checks: [{ name: "file content", pass: ({ root }) => read(root, "hello.txt").trim() === "hello pig" }],
      tags: ["write"],
    },
    {
      id: "edit-existing",
      prompt: "把 config.json 里的 port 从 3000 改成 8080，其他不要动",
      files: { "config.json": JSON.stringify({ name: "demo", port: 3000, debug: false }, null, 2) },
      checks: [
        { name: "port updated", pass: ({ root }) => { try { return JSON.parse(read(root, "config.json")).port === 8080; } catch { return false; } } },
        { name: "others kept", pass: ({ root }) => { try { const j = JSON.parse(read(root, "config.json")); return j.name === "demo" && j.debug === false; } catch { return false; } } },
      ],
      tags: ["edit"],
    },
    {
      id: "log-count",
      prompt: "统计 app.log 中 ERROR 行的数量，只回答数字和你的方法。",
      files: { "app.log": log },
      checks: [{ name: "correct count (10)", pass: ({ reply }) => /\b10\b/.test(reply) }],
      tags: ["analysis"],
      rubric: "包含 ERROR 字样的行共 10 行，答案应以 10 为结论并说明可复现的方法（如 grep -c）。这些 ERROR 出现在 INFO 级别行的末尾；若回复额外澄清“按日志级别统计为 0”，属于正确的补充说明而非含糊。只有结论错误、无方法或编造统计过程才扣分。",
    },
    {
      id: "explain-bug",
      prompt: "calc.js 里的 sumTo(n) 应该返回 1 到 n 的和。找出 bug 并解释原因，给出修复建议，但不要修改文件。",
      files: { "calc.js": "function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\nmodule.exports = { sumTo };\n" },
      checks: [
        { name: "file untouched", pass: ({ root }) => read(root, "calc.js").includes("i < n;") },
        { name: "mentions off-by-one fix", pass: ({ reply }) => /<=\s*n|i\s*<=|off.by.one|少加|漏掉|不包含\s*n|没有加上\s*n/i.test(reply) },
      ],
      tags: ["reasoning"],
      rubric: "必须指出循环条件 i < n 导致漏加 n（差一错误），建议改为 i <= n 或使用 n*(n+1)/2；解释清楚且未声称已修改文件。",
    },
    {
      id: "multi-turn-memory",
      prompt: ["记住：发布分支叫 release/2026-q4。先列出工作区文件。", "我刚才说的发布分支叫什么？"],
      files: { "README.md": "demo" },
      checks: [{ name: "recalls branch", pass: ({ reply }) => reply.includes("release/2026-q4") }],
      tags: ["context"],
    },
  ];
}
