import { randomBytes } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const file = "data/cluster-local/stack.env";
const command = process.argv[2] || "status";
await mkdir("data/cluster-local", { recursive: true, mode: 0o700 });
try {
  await access(file);
} catch {
  await writeFile(
    file,
    [
      "DB_PASSWORD",
      "ENCRYPTION_KEY",
      "ADMIN_TOKEN",
      "MEMBER_TOKEN",
      "MEMBER2_TOKEN",
      "WORKER_TOKEN",
    ]
      .map((k) => k + "=" + randomBytes(32).toString("hex"))
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
function compose(args) {
  const r = spawnSync(
    "docker",
    ["compose", "--env-file", file, "-f", "infra/cluster/compose.yml", ...args],
    { stdio: "inherit" },
  );
  if (r.status !== 0) process.exit(r.status || 1);
}
if (command === "up") {
  compose(["build"]);
  compose(["up", "-d", "--wait", "--wait-timeout", "120"]);
  compose([
    "exec",
    "-T",
    "control",
    "nginx",
    "-t",
    "-c",
    "/etc/pig-cluster/nginx.conf",
  ]);
  compose([
    "exec",
    "-T",
    "control",
    "nginx",
    "-s",
    "reload",
    "-c",
    "/etc/pig-cluster/nginx.conf",
  ]);
  let reachable = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      reachable = (
        await fetch("http://127.0.0.1:8892/health", {
          signal: AbortSignal.timeout(2000),
        })
      ).ok;
    } catch {}
    if (reachable) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!reachable)
    throw Error(
      "Containers started but published control entrypoint :8892 is unreachable",
    );
  console.log("Published control entrypoint is healthy: http://127.0.0.1:8892");
} else if (command === "down") {
  compose(["stop", "runner-a", "runner-b"]);
  compose(["down"]);
} else if (command === "logs")
  compose(["logs", "--tail", "100", ...process.argv.slice(3)]);
else if (command === "status") compose(["ps"]);
else if (command === "setup")
  console.log("Isolated cluster credentials ready; values are not printed.");
else throw Error("Expected setup, up, down, status or logs");
