import { describe, expect, it } from "vitest";
import { memoryHash, parseHash, projectsHash, searchHash, sessionHash } from "./hash";

describe("hash routes", () => {
  it("parses search, session, and project asset/todo hints", () => {
    expect(parseHash("#/search?q=%E8%B0%83%E7%A0%94")).toEqual({ name: "search", q: "调研" });
    expect(parseHash("#/sessions/ses_abc")).toEqual({ name: "workstation", sessionId: "ses_abc" });
    expect(parseHash("#/projects/prj_1?asset=ast_2&todo=todo_3")).toEqual({
      name: "projects",
      projectId: "prj_1",
      assetId: "ast_2",
      todoId: "todo_3",
    });
    expect(parseHash("#/")).toEqual({ name: "workstation" });
    expect(parseHash("#/memory/mem_abc")).toEqual({ name: "memory", noteId: "mem_abc" });
    expect(parseHash("#/memory")).toEqual({ name: "memory" });
  });

  it("builds hrefs that parseHash understands", () => {
    expect(searchHash("foo bar")).toBe("#/search?q=foo%20bar");
    expect(sessionHash("ses_1")).toBe("#/sessions/ses_1");
    expect(projectsHash("prj_1", { assetId: "ast_9" })).toBe("#/projects/prj_1?asset=ast_9");
    expect(parseHash(projectsHash("prj_1", { todoId: "todo_8" }))).toMatchObject({
      name: "projects",
      projectId: "prj_1",
      todoId: "todo_8",
    });
    expect(memoryHash("mem_1")).toBe("#/memory/mem_1");
    expect(parseHash(memoryHash("mem_9"))).toEqual({ name: "memory", noteId: "mem_9" });
  });
});
