// pnpm exec tsx scripts/benchmark-context.ts
// Synthetic, offline measurement of context assembly; not a model-quality benchmark.
import { performance } from "node:perf_hooks";
import { assembleModelContext, type ChatMessage } from "../packages/contracts/src/index.ts";

const createdAt = "2026-09-24T00:00:00.000Z";
for (const turns of [50, 500, 2000]) {
  const messages: ChatMessage[] = [{ id: "goal", role: "user", content: "目标：交付中文报表，保留原始数据。", createdAt }];
  for (let i = 0; i < turns; i++) {
    messages.push({ id: `call-${i}`, role: "assistant", content: "", createdAt, toolCalls: [{ id: `read-${i}`, name: "read_file", arguments: JSON.stringify({ path: `inputs/${i}.txt` }) }] });
    messages.push({ id: `result-${i}`, role: "tool", toolCallId: `read-${i}`, content: "历史观测，仅供参考。".repeat(200), createdAt });
  }
  messages.push({ id: "latest", role: "user", content: "更正：只输出摘要，不要修改数据。", createdAt });
  const times: number[] = [];
  let result = assembleModelContext({ messages, systemChars: 4000, toolSchemaChars: 10000 });
  for (let i = 0; i < 15; i++) {
    const start = performance.now();
    result = assembleModelContext({ messages, systemChars: 4000, toolSchemaChars: 10000 });
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const text = result.messages.map(m => m.content).join("\n");
  if (!text.includes("交付中文报表") || !text.includes("只输出摘要") || result.metrics.usedChars > result.metrics.budgetChars) throw new Error("Context acceptance invariant failed");
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, turns, messages: messages.length, samples: times.length, medianMs: +times[7]!.toFixed(2), p95Ms: +times[14]!.toFixed(2), inputChars: messages.reduce((n, m) => n + m.content.length, 0), ...result.metrics }));
}
