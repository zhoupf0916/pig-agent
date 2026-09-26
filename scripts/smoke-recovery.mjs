import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// Destructive fault injection is deliberately restricted to the isolated acceptance project.
const project = 'pig-recovery';
const env = parseEnv(await readFile('data/recovery-test/stack.env', 'utf8'));
const base = 'http://127.0.0.1:8892';
const compose = ['compose', '-p', project, '--env-file', 'data/recovery-test/stack.env', '-f', 'infra/cluster/compose.yml', '-f', 'infra/recovery/compose.yml'];
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sql = query => docker(['exec', `${project}-postgres-1`, 'psql', '-U', 'pig', '-d', 'pig', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query]);
const req = async (path, body, token=env.ADMIN_TOKEN, expected=200) => {
 const r = await fetch(base+path, { method: body ? 'POST':'GET', headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'Idempotency-Key': randomUUID() }, body: body ? JSON.stringify(body):undefined, signal:AbortSignal.timeout(10000) });
 assert.equal(r.status, expected, `${path}: HTTP ${r.status}`); return r.json();
};
const until = async (fn, label, timeout=85000) => {
 const end=Date.now()+timeout;
 while(Date.now()<end) { const r=await fn(); if(r) return r; await new Promise(r=>setTimeout(r,150)); }
 throw Error(`Timeout: ${label}`);
};
const evidence=[];
const inspect = id => JSON.parse(sql(`SELECT row_to_json(r) FROM (SELECT id,state,worker_id,checkpoint_phase,recovery_count,deadline_at,jsonb_array_length(coalesce(checkpoint->'messages','[]'::jsonb)) AS messages FROM runs WHERE id='${id}') r`));
const create = async approval => {
 const run=await req('/v1/runs',{prompt:'Recovery acceptance: write and read cloud-proof.txt', requireApproval:approval},env.ADMIN_TOKEN,201);
 assert.match(run.id,/^run_[a-f0-9]+$/);return run.id;
};
const serviceFor = worker => worker.endsWith('-a') ? 'runner-a' : worker.endsWith('-b') ? 'runner-b' : null;
try {
 const id=await create(false);
 const before=await until(()=>{
  const r=inspect(id);
  const hasWrite=sql(`SELECT count(*) FROM runs,jsonb_array_elements(checkpoint->'messages') m WHERE id='${id}' AND m->>'role'='tool' AND m->>'toolCallId'='write-proof'`)==='1';
  return r.checkpoint_phase==='safe' && hasWrite ? r:null;
 },'safe checkpoint after actual write');
 const service=serviceFor(before.worker_id);assert.ok(service);
 docker([...compose,'kill','-s','KILL',service]);
 const done=await until(async()=>{const r=await req(`/v1/runs/${id}`);return ['succeeded','failed','cancelled'].includes(r.state)?r:null;},'replacement Runner finishes');
 assert.equal(done.state,'succeeded',done.error);
 const after=inspect(id);assert.equal(after.recovery_count,1);assert.equal(after.deadline_at,before.deadline_at);
 const writes=Number(sql(`SELECT count(*) FROM events WHERE run_id='${id}' AND event->>'type'='tool_start' AND event->>'name'='write_file'`));assert.equal(writes,1);
 const artifact=sql(`SELECT content FROM artifacts WHERE run_id='${id}' AND path='cloud-proof.txt'`);assert.equal(artifact,'PIG_CLOUD_CONTAINER_OK');
 const trace=await req(`/v1/runs/${id}/debug`);assert.equal(trace.timing.attempts,2);assert.equal(trace.timing.recoveries,1);assert.ok(trace.timing.elapsedMs>0);
 await req(`/v1/runs/${id}/debug`,undefined,env.MEMBER_TOKEN,404);
 evidence.push({scenario:'kill-after-safe-checkpoint',runId:id,state:done.state,writes,restoredArtifact:true,timing:trace.timing});
 docker([...compose,'start',service]);
 const unsafeId=await create(true);
 const waiting=await until(async()=>{const r=await req(`/v1/runs/${unsafeId}/approvals`);return r.approvals?.some(a=>a.state==='pending')?inspect(unsafeId):null;},'approval wait');
 assert.equal(waiting.checkpoint_phase,'unsafe');
 const unsafeService=serviceFor(waiting.worker_id);assert.ok(unsafeService);docker([...compose,'kill','-s','KILL',unsafeService]);
 const failed=await until(async()=>{const r=await req(`/v1/runs/${unsafeId}`);return r.state==='failed'?r:null;},'unsafe attempt fails without replay');
 assert.equal(inspect(unsafeId).recovery_count,0);
 assert.equal(sql(`SELECT count(*) FROM artifacts WHERE run_id='${unsafeId}'`),'0');
 evidence.push({scenario:'kill-while-awaiting-approval',runId:unsafeId,state:failed.state,recoveries:0,artifacts:0});
 docker([...compose,'start',unsafeService]);
 // Claim tokens directly using a fixture worker to test fencing and cancellation without races with real workers.
 sql('UPDATE workers SET enabled=false');
 const workerId='recovery-fixture',instanceId=randomUUID();
 await req('/internal/workers/register',{workerId,instanceId,capacity:1,profiles:['standard']},env.WORKER_TOKEN);
 sql("UPDATE workers SET enabled=true WHERE id='recovery-fixture'");
 const cancelledId=await create(false);
 const job=await req('/internal/claim',{workerId,instanceId},env.WORKER_TOKEN);assert.equal(job.id,cancelledId);
 await req('/internal/checkpoint',{token:job.token,phase:'unsafe'},env.WORKER_TOKEN);
 await req(`/v1/runs/${cancelledId}/abort`,{},env.ADMIN_TOKEN);
 await req('/internal/checkpoint',{token:job.token,phase:'unsafe'},env.WORKER_TOKEN,409);
 sql(`UPDATE runs SET lease_until=now()-interval '1 second' WHERE id='${cancelledId}'`);
 await until(async()=> (await req(`/v1/runs/${cancelledId}`)).state==='cancelled','cancel remains terminal');
 evidence.push({scenario:'cancel-fences-checkpoint',runId:cancelledId,state:'cancelled',lateCheckpointStatus:409});
 for (const scenario of ['retry-limit','deadline']) {
  const rid=await create(false);
  const claim=await req('/internal/claim',{workerId,instanceId},env.WORKER_TOKEN);assert.equal(claim.id,rid);
  sql(`UPDATE runs SET checkpoint=(SELECT checkpoint FROM runs WHERE id='${id}'),checkpoint_phase='safe',recovery_count=${scenario==='retry-limit'?2:0},lease_until=now()-interval '1 second'${scenario==='deadline'?",deadline_at=now()-interval '1 second'":''} WHERE id='${rid}'`);
  await req('/internal/checkpoint',{token:claim.token,phase:'unsafe'},env.WORKER_TOKEN,409);
  await until(async()=> (await req(`/v1/runs/${rid}`)).state==='failed',scenario);
  evidence.push({scenario,runId:rid,state:'failed',expiredAttemptRejected:true});
 }
} finally {
 sql("UPDATE workers SET enabled=(id!='recovery-fixture')");
 docker([...compose,'start','runner-a','runner-b']);
 await mkdir('data/recovery-test',{recursive:true});
 await writeFile('data/recovery-test/evidence.json',JSON.stringify({at:new Date().toISOString(),model:'mock',evidence},null,2));
}
console.log(JSON.stringify({ok:true,evidence},null,2));
