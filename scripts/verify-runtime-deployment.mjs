import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const env=parseEnv(await readFile(process.env.VERIFY_ENV || 'data/cloud-local/stack.env','utf8'));
const base=process.env.VERIFY_URL || 'http://127.0.0.1:8890';
async function req(path,body) {
 const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${env.ADMIN_TOKEN}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
 assert.ok(r.ok,`${path}: HTTP ${r.status}`);return r.json();
}
// Exactly one short real-model task on the configured deployment channel. No tool work requested.
const run=await req('/v1/runs',{prompt:'发布验收：不要调用任何工具，不修改文件。请只回复“运行时发布验证通过”。',requireApproval:true});
try {
let state;
const until=Date.now()+90000;
while(Date.now()<until){state=await req(`/v1/runs/${run.id}`);if(['succeeded','failed','cancelled'].includes(state.state))break;await new Promise(r=>setTimeout(r,500));}
assert.equal(state.state,'succeeded','deployment task must succeed');
const debug=await req(`/v1/runs/${run.id}/debug`);
assert.ok(debug.spans.some(s=>s.name==='checkpoint_safe'&&s.status==='ok'),'safe checkpoint must be acknowledged');
assert.ok(!debug.spans.some(s=>s.kind==='tool'),'verification must not execute tools');
assert.equal(debug.timing.attempts,1);
assert.equal(debug.timing.recoveries,0);
assert.ok(debug.timing.modelCallsObserved>=1);
const report={at:new Date().toISOString(),runId:run.id,conversationId:run.conversationId,state:state.state,checkpointConfirmed:true,toolCalls:0,timing:debug.timing};
await mkdir('data/deployment',{recursive:true});await writeFile('data/deployment/runtime-2026-09-26.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));

} catch (error) {
  await req(`/v1/runs/${run.id}/abort`, {}).catch(() => {});
  throw error;
}
