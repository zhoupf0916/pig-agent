import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

describe("desktop remote skill catalog", () => {
  it("allows GET /api/remote/v1/skills instead of rejecting the path", async () => {
    const response = await createApp().request("/api/remote/v1/skills");
    expect(response.status).not.toBe(404);
    const body = await response.json() as { error?: string };
    expect(body.error).not.toBe("Unsupported control-plane operation");
  });
});
