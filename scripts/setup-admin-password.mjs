import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
const directory = process.env.PIG_ADMIN_SETUP_DIR || "data/cloud-local";
const base = process.env.PIG_ADMIN_SETUP_BASE || "http://127.0.0.1:8890";
const env = Object.fromEntries(
  (await readFile(directory + "/stack.env", "utf8"))
    .split("\n")
    .filter((s) => s.includes("="))
    .map((s) => {
      const i = s.indexOf("=");
      return [s.slice(0, i), s.slice(i + 1)];
    }),
);
if (!env.ADMIN_TOKEN) throw Error("Missing local bootstrap admin credential");
async function api(method, body) {
  const response = await fetch(base + "/v1/admin/password-account", {
    method,
    headers: {
      Authorization: "Bearer " + env.ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Admin setup failed");
  return result;
}
const existing = await api("GET");
if (existing.configured) {
  console.log(
    "Administrator password account already configured; existing credentials preserved.",
  );
  process.exit(0);
}
const username = process.env.PIG_ADMIN_SETUP_USERNAME || "admin";
const password = randomBytes(24).toString("base64url");
const file = resolve(directory, "accounts.txt");
await mkdir(directory, { recursive: true });
await writeFile(
  file,
  `Pig Agent local administrator\nURL: ${base}/admin/\nUsername: ${username}\nPassword: ${password}\n\nKeep this file private. Existing passwords are never reset by setup.\n`,
  { mode: 0o600, flag: "wx" },
);
await chmod(file, 0o600);
try {
  await api("POST", { username, password, onlyIfUnconfigured: true });
  console.log(
    "Administrator password account created. Private credentials: " + file,
  );
} catch (error) {
  console.error(
    "Setup did not confirm success; private credentials retained at " +
      file +
      " for recovery.",
  );
  throw error;
}
