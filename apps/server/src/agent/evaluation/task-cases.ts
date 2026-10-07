/** End-to-end task eval cases: workspace fixture + deterministic graders. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TaskCheck = { name: string; pass: (input: { root: string; reply: string; tools: string[] }) => boolean };
export type TaskCase = { id: string; prompt: string | string[]; files: Record<string, string>; checks: TaskCheck[]; tags?: string[] };

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
