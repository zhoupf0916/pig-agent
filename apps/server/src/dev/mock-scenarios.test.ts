import { describe, expect, it } from "vitest";
import { mockReply, pickScenario } from "./mock-scenarios.ts";

const u = (content: string) => ({ role: "user", content });
describe("mock LLM scenarios", () => {
  it("routes by intent", () => {
    expect(pickScenario("列出工作区文件")).toBe("list");
    expect(pickScenario("写一个 hello.txt")).toBe("write");
    expect(pickScenario("运行 `ls -la`")).toBe("shell");
    expect(pickScenario("读 notes/todo.md")).toBe("read");
    expect(pickScenario("整理工作区写 README 摘要")).toBe("readme");
    expect(pickScenario("帮我整理工作区摘要")).toBe("readme");
    expect(pickScenario("你好")).toBe("chat");
    expect(pickScenario("anything [mock:fail]")).toBe("fail");
    expect(pickScenario("你好", "readme")).toBe("readme");
  });
  it("write scenario uses the requested file and finishes after tool rounds", () => {
    const first = mockReply([u("写一个 hello.txt")], "");
    expect(first.toolCalls?.[0]?.name).toBe("list_dir");
    const second = mockReply([u("写一个 hello.txt"), { role: "tool", content: "a" }], "");
    expect(second.toolCalls?.[0]?.arguments.path).toBe("hello.txt");
    expect(mockReply([u("写一个 hello.txt"), { role: "tool" }, { role: "tool" }], "").content).toContain("hello.txt");
  });
  it("tool rounds reset on a new user turn", () => {
    const r = mockReply([u("列出文件"), { role: "tool", content: "x" }, { role: "assistant", content: "ok" }, u("运行 `pwd`")], "");
    expect(r.toolCalls?.[0]).toMatchObject({ name: "run_shell", arguments: { command: "pwd" } });
  });
});
