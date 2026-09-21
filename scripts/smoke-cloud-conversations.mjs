import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
const env = Object.fromEntries(
  (await readFile("data/cloud-local/stack.env", "utf8"))
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = "http://127.0.0.1:8890";
async function req(path, body, status = 200, key, token = env.MEMBER_TOKEN) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(
    r.status,
    status,
    await (r.status !== status ? r.clone().text() : Promise.resolve(path)),
  );
  return r;
}
async function wait(id) {
  for (let i = 0; i < 300; i++) {
    const r = await (await req("/v1/runs/" + id)).json();
    if (["succeeded", "failed", "cancelled"].includes(r.state)) {
      assert.equal(r.state, "succeeded", r.error);
      return r;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("run timeout");
}
const marker = randomUUID();
const first = await (
  await req(
    "/v1/runs",
    {
      prompt: "Continuity smoke",
      files: [{ path: "marker.txt", content: marker }],
    },
    201,
    randomUUID(),
  )
).json();
const run = await wait(first.id);
assert.ok(run.conversation_id);
const path = `/v1/runs/${first.id}/follow-ups`,
  key = randomUUID();
const a = await req(
  path,
  { prompt: "Continue with the previous workspace" },
  201,
  key,
);
const b = await req(
  path,
  { prompt: "Continue with the previous workspace" },
  200,
  key,
);
const second = await a.json();
assert.equal((await b.json()).id, second.id);
await req(path, { prompt: "Conflicting turn" }, 409, randomUUID());
await req(
  `/v1/conversations/${run.conversation_id}`,
  undefined,
  404,
  undefined,
  env.MEMBER2_TOKEN,
);
await wait(second.id);
const conversation = await (
  await req(`/v1/conversations/${run.conversation_id}`)
).json();
assert.equal(conversation.runs.length, 2);
assert.equal(conversation.versions.length, 2);
assert.equal(conversation.messages.filter((m) => m.role === "user").length, 2);
const archive = await req(
  `/v1/conversations/${run.conversation_id}/workspace/${second.id}`,
);
const tar = gunzipSync(Buffer.from(await archive.arrayBuffer()));
assert.ok(
  tar.includes(Buffer.from(marker)),
  "Initial file must survive the next container",
);
assert.ok(
  tar.includes(Buffer.from("PIG_CLOUD_CONTAINER_OK")),
  "Generated file must persist",
);
await req(path, { prompt: "Continue with the previous workspace" }, 200, key);
console.log(
  "PASS: two containers share versioned workspace; authoritative transcript; serialized turns; replay idempotency; owner isolation; archive download.",
);
