import { afterEach, describe, it, expect, vi } from "vitest";
const mock = vi.hoisted(() => ({
  call: vi.fn().mockResolvedValue("external result"),
}));
vi.mock("../agent/mcp-client.ts", () => ({
  callMcpTool: mock.call,
  listMcpTools: vi.fn().mockResolvedValue([]),
}));
import { setDesktopSecrets, type DesktopSecrets } from "./desktop-secrets.ts";
import {
  createMcpServer,
  requireMcpTarget,
  updateMcpServer,
  invokeApprovedMcp,
} from "./mcp-servers.ts";
afterEach(() => {
  setDesktopSecrets(undefined);
  mock.call.mockClear();
});
describe("MCP credential snapshot consistency", () => {
  it("never uses a replacement secret with an approval for the previous credential version", async () => {
    let stored: DesktopSecrets = {
      llmApiKey: "",
      cloudToken: "",
      mcpSecrets: {},
    };
    let hold = false;
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    setDesktopSecrets({
      read: async () => stored,
      write: async (value) => {
        stored = value;
        if (hold) {
          entered();
          await barrier;
        }
      },
    });
    const [server] = await createMcpServer({
      name: "fixture",
      url: "http://127.0.0.1:1/mcp",
      enabled: true,
      secret: "synthetic-first",
    });
    const tool = `mcp__${server!.id}__echo`,
      target = await requireMcpTarget(tool);
    hold = true;
    const updating = updateMcpServer(server!.id, {
      secret: "synthetic-second",
    });
    await started;
    try {
      await expect(invokeApprovedMcp(tool, {}, target)).rejects.toThrow(
        /凭据|配置|变化/,
      );
      expect(mock.call).not.toHaveBeenCalled();
    } finally {
      release();
      await updating;
    }
  });
});
