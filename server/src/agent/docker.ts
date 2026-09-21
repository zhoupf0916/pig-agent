import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { normalizeWorkspaceRoot } from "./sandbox.ts";
export function dockerArgs(root: string, command: string, image: string, network: boolean, name: string): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,200}$/.test(image)) throw new Error("Invalid Docker image");
  const mount = normalizeWorkspaceRoot(root);
  if (mount.includes(",")) throw new Error("Docker 挂载路径不能包含逗号。");
  return ["run", "--pull=never", "--rm", "--name", name, "--init", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=512m", "--cpus=1", "--network", network ? "bridge" : "none", "--tmpfs", "/tmp:rw,nosuid,size=128m", "--mount", `type=bind,src=${mount},dst=/workspace`, "--workdir", "/workspace", "--env", "HOME=/tmp", image, "sh", "-lc", command];
}
export function dockerCommand(root: string, command: string, image: string, network: boolean) {
  const name = `pig-${randomUUID()}`;
  return { child: spawn("docker", dockerArgs(root, command, image, network, name), { windowsHide: true }), cleanup: () => { execFile("docker", ["rm", "-f", name], { timeout: 10000 }, () => {}); } };
}
export async function dockerStatus() {
  return new Promise<{ available: boolean; version?: string; error?: string }>((resolve) => {
    execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 }, (error, stdout) => resolve(error ? { available: false, error: "Docker 未启动或不可用，请启动 Docker Desktop 后重试。" } : { available: true, version: stdout.trim() }));
  });
}
