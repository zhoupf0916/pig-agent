/** Trusted bundled entrypoint. It only accepts file tools, in an OS sandbox, with no credentials. */
import { executeTool, type ArtifactPatch } from "./tools.ts";
import type { ArtifactAction } from "../types.ts";
const allowed = new Set([
  "list_dir",
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "search_files",
  "delete_file",
  "move_file",
  "__capture",
  "__restore",
  "__preview",
  "__tree",
  "__readbinary",
  "__handoff",
]);
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16 * 1024 * 1024)
      throw Error("文件工具请求过大");
  }
  const request = JSON.parse(input);
  if (!allowed.has(request.name) || typeof request.workspaceRoot !== "string")
    throw Error("非法文件工具请求");
  const artifacts: Array<{
    path: string;
    action: ArtifactAction;
    extra?: ArtifactPatch;
  }> = [];
  let result;
  if (request.name === "__capture" || request.name === "__restore") {
    const { capture, restoreVersions } = await import("../store/workbench.ts");
    if (request.name === "__capture")
      result = {
        output: JSON.stringify(
          await capture(request.workspaceRoot, request.args.paths),
        ),
      };
    else {
      await restoreVersions(request.workspaceRoot, request.args.versions);
      result = { output: "restored" };
    }
  } else if (request.name === "__tree" || request.name === "__preview") {
    const { buildTree, readWorkspaceText } = await import("../workspace.ts");
    result = {
      output: JSON.stringify(
        request.name === "__tree"
          ? await buildTree(
              request.workspaceRoot,
              request.args.path,
              request.args.maxDepth,
            )
          : await readWorkspaceText(request.workspaceRoot, request.args.path),
      ),
    };
  } else if (request.name === "__readbinary") {
    const { resolveInWorkspace } = await import("./sandbox.ts");
    const { readFile, stat } = await import("node:fs/promises");
    const path = resolveInWorkspace(request.workspaceRoot, request.args.path, {
      mustExist: true,
    });
    const info = await stat(path);
    if (!info.isFile() || info.size > 1500000)
      throw Error("文件不是普通文件或超过1.5MB读取上限");
    const bytes = await readFile(path);
    if (bytes.length > 1500000) throw Error("文件超过1.5MB读取上限");
    result = { output: bytes.toString("base64") };
  } else if (request.name === "__handoff") {
    const { buildRemoteWorkspaceHandoff } = await import("./cloud/request.ts");
    result = {
      output: JSON.stringify(
        buildRemoteWorkspaceHandoff({
          ...request.args.settings,
          workspaceRoot: request.workspaceRoot,
        }),
      ),
    };
  } else {
    result = await executeTool(request.name, request.args, {
      workspaceRoot: request.workspaceRoot,
      shellMode: "host",
      artifacts: [],
      recordArtifact: (path, action, extra) =>
        artifacts.push({ path, action, extra }),
    });
  }
  process.stdout.write(JSON.stringify({ result, artifacts }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
