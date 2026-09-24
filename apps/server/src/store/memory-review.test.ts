import { describe, expect, it } from "vitest";
import { clearMemoryRefs, createMemory, listRecentPinTexts, memoryFile } from "./memory.ts";
import { writeFile } from "node:fs/promises";

describe("memory lifecycle acceptance", () => {
  it("does not inject a deleted project's former scoped note into unrelated projects", async () => {
    await createMemory({ text: "PRIVATE_DELETED_PROJECT_CONTEXT", projectId: "project-to-delete" });
    await clearMemoryRefs("projectId", "project-to-delete");
    expect(await listRecentPinTexts({ projectId: "unrelated-project", sessionId: "other" })).not.toContain("PRIVATE_DELETED_PROJECT_CONTEXT");
  });

  it("keeps legacy notes private when their project is deleted", async () => {
    const note = await createMemory({ text: "LEGACY_PRIVATE_CONTEXT", projectId: "legacy-project" });
    const { source, scope, stability, ...legacy } = note;
    await writeFile(memoryFile(note.id), JSON.stringify(legacy));
    await clearMemoryRefs("projectId", "legacy-project");
    expect(await listRecentPinTexts({ projectId: "other-project" })).not.toContain("LEGACY_PRIVATE_CONTEXT");
  });
});
