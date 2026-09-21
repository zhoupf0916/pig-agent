import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
const directory = "data/cloud-local",
  file = directory + "/stack.env";
const command = process.argv[2] || "status";
async function run(args) {
  await new Promise((resolve, reject) => {
    const p = spawn(
      "docker",
      ["compose", "--env-file", file, "-f", "infra/cloud/compose.yml", ...args],
      { stdio: "inherit" },
    );
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error("Docker compose exit " + code)),
    );
  });
}
if (command === "setup") {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await access(file);
    const existing=await readFile(file,"utf8");
    if (!/^ENCRYPTION_KEY=/m.test(existing)) await writeFile(file,existing.trimEnd()+"\nENCRYPTION_KEY="+randomBytes(32).toString("hex")+"\n",{mode:0o600});
    console.log("Existing credentials preserved:", file);
  } catch {
    const credentials = Object.fromEntries(
      [
        "DB_PASSWORD",
        "ENCRYPTION_KEY",
        "ADMIN_TOKEN",
        "MEMBER_TOKEN",
        "MEMBER2_TOKEN",
        "WORKER_TOKEN",
      ].map((k) => [k, randomBytes(32).toString("hex")]),
    );
    await writeFile(
      file,
      Object.entries(credentials)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\nMODEL_MODE=mock\n",
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(
      directory + "/access.txt",
      `Execution diagnostics: http://127.0.0.1:8890/debug/runs\nAdmin: http://127.0.0.1:8890/admin/\nMember token: ${credentials.MEMBER_TOKEN}\nAdmin token: ${credentials.ADMIN_TOKEN}\n`,
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      "Local credentials generated in data/cloud-local/access.txt (not printed).",
    );
  }
} else {
  await readFile(file);
  if (command === "up") {
    await run(["--profile", "build", "build"]);
    await run(["up", "-d", "--wait", "--wait-timeout", "90"]);
  } else if (command === "down") {
    await run(["stop", "worker"]);
    const ids = await new Promise((resolve) => {
      let s = "";
      const p = spawn(
        "docker",
        ["ps", "-aq", "--filter", "label=pig-agent.managed=true"],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      p.stdout.on("data", (b) => (s += b));
      p.on("exit", () => resolve(s.trim().split(/\s+/).filter(Boolean)));
    });
    if (ids.length)
      await new Promise((resolve) => {
        spawn("docker", ["rm", "-f", ...ids], { stdio: "inherit" }).on(
          "exit",
          resolve,
        );
      });
    await run(["down"]);
    const networks = execFileSync(
      "docker",
      ["network", "ls", "-q", "--filter", "label=pig-agent.managed=true"],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (networks.length)
      execFileSync("docker", ["network", "rm", ...networks], {
        stdio: "inherit",
      });
  } else if (command === "logs")
    await run(["logs", "--tail", "100", ...process.argv.slice(3)]);
  else await run(["ps"]);
}
