import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeCommand } from "./native-sandbox.ts";
import type { ToolContext, ToolResult, ArtifactPatch } from "./tools.ts";
import type { ArtifactAction } from "../types.ts";
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
export const FILE_TOOLS = new Set([
  "list_dir",
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "search_files",
  "delete_file",
  "move_file",
]);
export async function nativeFileTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.PIG_TOOLS_HELPER,
    join(here, "tools-helper.mjs"),
    "/usr/local/lib/pig-tools-helper.mjs",
    join(here, "../../../../native-dist/tools-helper.mjs"),
  ];
  const helper = candidates.find((path): path is string =>
    Boolean(path && existsSync(path)),
  );
  if (!helper)
    throw Error(
      "原生文件工具尚未构建。请先运行 pnpm build；不会降级为宿主文件访问。",
    );
  const trustedReadPaths = [helper, process.execPath];
  const appIndex = process.execPath.indexOf(".app/");
  if (appIndex >= 0)
    trustedReadPaths.push(process.execPath.slice(0, appIndex + 4));
  const execution = nativeCommand(
    ctx.workspaceRoot,
    `${quote(process.execPath)} ${quote(helper)}`,
    false,
    { stdin: true, helper: true, trustedReadPaths },
  );
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "",
      settled = false;
    const stop = () => {
      try {
        if (execution.child.pid) process.kill(-execution.child.pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(stop, 30000);
    const finish = (error?: Error, result?: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", stop);
      execution.cleanup();
      if (error) reject(error);
      else resolve(result!);
    };
    ctx.signal?.addEventListener("abort", stop, { once: true });
    execution.child.stdout!.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) stop();
    });
    execution.child.stderr!.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 64000) stop();
    });
    execution.child.on("error", (error) => finish(error));
    execution.child.on("close", (code) => {
      try {
        if (!stdout) throw Error(stderr || `原生文件工具退出（${code}）`);
        const value = JSON.parse(stdout);
        if (ctx.signal?.aborted) throw Error("Aborted");
        if (code !== 0 || value.error)
          throw Error(value.error || stderr || "原生文件工具失败");
        for (const artifact of value.artifacts as Array<{
          path: string;
          action: ArtifactAction;
          extra?: ArtifactPatch;
        }>)
          ctx.recordArtifact(artifact.path, artifact.action, artifact.extra);
        finish(undefined, value.result);
      } catch (error) {
        finish(
          error instanceof Error ? error : new Error(stderr || String(error)),
        );
      }
    });
    execution.child.stdin!.on("error", () => {});
    execution.child.stdin!.end(
      JSON.stringify({ name, args, workspaceRoot: ctx.workspaceRoot }),
    );
    if (ctx.signal?.aborted) stop();
  });
}
