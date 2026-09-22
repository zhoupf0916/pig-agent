/** Synthetic canary only. Reproduces the former host-path race, then checks the native helper boundary. */
import { readWorkspaceText } from "../../apps/server/src/workspace.ts";
import { gunzipSync } from "node:zlib";
import { nativeFileTool } from "../../apps/server/src/agent/file-helper-client.ts";
import { nativeCommand } from "../../apps/server/src/agent/native-sandbox.ts";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const parent = realpathSync(mkdtempSync(join(tmpdir(), "pig-race-"))),
  root = join(parent, "work");
mkdirSync(root);
mkdirSync(join(parent, "private"));
writeFileSync(join(parent, "private/secret"), "PRIVATE_CANARY");
mkdirSync(join(root, "slot"));
writeFileSync(join(root, "slot/secret"), "SAFE");
const code = `const fs=require('fs');for(;;){try{fs.renameSync('slot','park');fs.symlinkSync(${JSON.stringify(join(parent, "private"))},'slot');fs.unlinkSync('slot');fs.renameSync('park','slot')}catch{} }`;
const attacker = nativeCommand(
  root,
  `node -e '${code.replaceAll("'", "'\\''")}'`,
);
let safe = 0,
  blocked = 0,
  legacyLeaks = 0;
try {
  await new Promise((r) => setTimeout(r, 100));
  process.env.PIG_FILE_HELPER = "1";
  for (let j = 0; j < 1000; j++)
    try {
      if (
        (await readWorkspaceText(root, "slot/secret")).content.includes(
          "PRIVATE_CANARY",
        )
      )
        legacyLeaks++;
    } catch {}
  delete process.env.PIG_FILE_HELPER;
  for (let i = 0; i < 12; i++) {
    for (const name of ["__preview", "__readbinary", "__handoff"])
      try {
        const value = await nativeFileTool(
          name,
          name === "__handoff" ? { settings: {} } : { path: "slot/secret" },
          {
            workspaceRoot: root,
            shellMode: "native",
            artifacts: [],
            recordArtifact: () => {},
          },
        );
        if (name === "__handoff") {
          const handoff = JSON.parse(value.output);
          if (
            handoff.snapshot &&
            gunzipSync(Buffer.from(handoff.snapshot.data, "base64")).includes(
              Buffer.from("PRIVATE_CANARY"),
            )
          )
            throw Error("LEAK");
        }
        if (
          value.output.includes("PRIVATE_CANARY") ||
          value.output.includes(
            Buffer.from("PRIVATE_CANARY").toString("base64"),
          )
        )
          throw Error("LEAK");
        safe++;
      } catch (error) {
        if (String(error).includes("LEAK")) throw error;
        blocked++;
      }
  }
  if (readFileSync(join(parent, "private/secret"), "utf8") !== "PRIVATE_CANARY")
    throw Error("modified");
  console.log(
    JSON.stringify({
      actualSandboxSymlinkRacer: true,
      legacyHostReads: 1000,
      legacyLeaks,
      requests: 36,
      safe,
      blocked,
      secretUnchanged: true,
    }),
  );
} finally {
  try {
    process.kill(-attacker.child.pid!, "SIGKILL");
  } catch {}
  attacker.cleanup();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(parent, { recursive: true, force: true });
}
