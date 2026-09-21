import { spawn } from "node:child_process";
import { mkdir, chmod } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
const args = [
  "compose",
  "--env-file",
  "data/cloud-local/stack.env",
  "-f",
  "infra/cloud/compose.yml",
  "exec",
  "-T",
  "postgres",
];
async function docker(command, { input, output } = {}) {
  const p = spawn("docker", [...args, ...command], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const done = new Promise((ok, fail) => {
    p.on("error", fail);
    p.on("exit", (code) =>
      code === 0 ? ok() : fail(Error("Database command failed: " + code)),
    );
  });
  const work = [];
  if (input) work.push(pipeline(createReadStream(input), p.stdin));
  else p.stdin.end();
  if (output)
    work.push(
      pipeline(
        p.stdout,
        createWriteStream(output, { flags: "wx", mode: 0o600 }),
      ),
    );
  else p.stdout.resume();
  await Promise.all([done, ...work]);
}
const command = process.argv[2] || "backup";
if (command === "backup") {
  await mkdir("data/cloud-local/backups", { recursive: true, mode: 0o700 });
  const file = resolve(
    "data/cloud-local/backups/" +
      new Date().toISOString().replaceAll(":", "-") +
      ".dump",
  );
  await docker(["pg_dump", "-U", "pig", "-Fc", "pig"], { output: file });
  await chmod(file, 0o600);
  await docker(["pg_restore", "--list"], { input: file });
  console.log("Verified backup:", file);
  console.log(
    "Keep stack.env separately: ENCRYPTION_KEY is required to decrypt model channels.",
  );
} else if (command === "verify-restore") {
  if (!process.argv[3])
    throw Error(
      "Usage: pnpm cloud:restore:verify /absolute/path/to/backup.dump",
    );
  const target = "pig_restore_" + Date.now();
  await docker(["createdb", "-U", "pig", target]);
  try {
    await docker(
      [
        "pg_restore",
        "-U",
        "pig",
        "--exit-on-error",
        "--no-owner",
        "-d",
        target,
      ],
      { input: resolve(process.argv[3]) },
    );
    await docker([
      "psql",
      "-U",
      "pig",
      "-d",
      target,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT count(*) FROM runs; SELECT count(*) FROM conversations; SELECT count(*) FROM model_channels;",
    ]);
    console.log(
      "Restore verification passed in disposable database. Live data untouched.",
    );
  } finally {
    await docker(["dropdb", "-U", "pig", target]);
  }
} else throw Error("Unknown backup operation");
