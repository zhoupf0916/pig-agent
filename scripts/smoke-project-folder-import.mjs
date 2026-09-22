import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const env=Object.fromEntries((await readFile('data/cluster-local/stack.env','utf8')).trim().split('\n').map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const base='http://127.0.0.1:8892';
const evidence={status:'running',checks:[],runs:[]};
async function req(path,{method='GET',body,status=200,key,token=env.MEMBER_TOKEN}={}) {
 const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});
 assert.equal(r.status,status,`${method} ${path}: ${await (r.status!==status?r.clone().text():Promise.resolve(''))}`);return r;
}
async function wait(id) {
 for(let i=0;i<240;i++) {
  const run=await (await req('/v1/runs/'+id)).json();
  assert.ok(!('input' in run),'Run metadata cannot expose uploaded source');
  if(['failed','cancelled'].includes(run.state)) throw Error(run.error || run.state);
  if(run.state==='succeeded') return run;
  await new Promise(r=>setTimeout(r,500));
 }
 throw Error('Container timeout');
}
const marker='IMPORTED_'+randomUUID();
const project=await (await req('/v1/projects',{method:'POST',status:201,body:{name:'目录导入 API 验收 '+Date.now(),workspaceName:'fixture',workspaceFiles:[{path:'src/probe.txt',content:marker},{path:'cloud-proof.txt',content:'INITIAL_SEED'}]}})).json();
const manifest=await (await req(`/v1/projects/${project.id}/workspace`)).json();
assert.equal(manifest.seed.fileCount,2);assert.ok(!JSON.stringify(manifest).includes(marker));
await req(`/v1/projects/${project.id}/workspace/files`,{method:'PUT',status:404,token:env.MEMBER2_TOKEN,body:{files:[{path:'a.txt',content:'blocked'}]}});
await req(`/v1/projects/${project.id}/workspace`,{token:env.MEMBER2_TOKEN,status:404});
await req(`/v1/projects/${project.id}/workspace/files`,{method:'PUT',status:400,body:{files:[{path:'../escape',content:'blocked'}]}});
evidence.checks.push('Atomic project creation imports nested files; metadata excludes source; cross-owner access and unsafe path rejected');
const body={projectId:project.id,prompt:'Validate imported workspace',requireApproval:false};const key=randomUUID();
const first=await (await req('/v1/runs',{method:'POST',status:201,body,key})).json();
await req(`/v1/projects/${project.id}/workspace/files`,{method:'PUT',body:{files:[{path:'src/probe.txt',content:'REPLACED_PROJECT_SEED'}]}});
const replay=await (await req('/v1/runs',{method:'POST',body,key})).json();assert.equal(replay.id,first.id);
const run=await wait(first.id);evidence.runs.push(first.id);
let archive=gunzipSync(Buffer.from(await (await req(`/v1/conversations/${run.conversation_id}/workspace/${first.id}`)).arrayBuffer()));
assert.ok(archive.includes(Buffer.from(marker)));assert.ok(archive.includes(Buffer.from('PIG_CLOUD_CONTAINER_OK')));assert.ok(!archive.includes(Buffer.from('INITIAL_SEED')));
evidence.checks.push('Real Runner materializes nested seed; mock model executes real write_file/read_file; project seed update does not mutate queued run or idempotent replay');
const second=await (await req(`/v1/runs/${first.id}/follow-ups`,{method:'POST',status:201,key:randomUUID(),body:{prompt:'Continue from the existing snapshot'}})).json();await wait(second.id);evidence.runs.push(second.id);
archive=gunzipSync(Buffer.from(await (await req(`/v1/conversations/${run.conversation_id}/workspace/${second.id}`)).arrayBuffer()));
assert.ok(archive.includes(Buffer.from(marker)));assert.ok(!archive.includes(Buffer.from('REPLACED_PROJECT_SEED')));
evidence.checks.push('Follow-up container restores prior conversation snapshot rather than updated project seed');
const third=await (await req('/v1/runs',{method:'POST',status:201,key:randomUUID(),body})).json();const latest=await wait(third.id);evidence.runs.push(third.id);
archive=gunzipSync(Buffer.from(await (await req(`/v1/conversations/${latest.conversation_id}/workspace/${third.id}`)).arrayBuffer()));
assert.ok(archive.includes(Buffer.from('REPLACED_PROJECT_SEED')));assert.ok(!archive.includes(Buffer.from(marker)));
evidence.checks.push('New conversation takes latest project seed; public run metadata never returns input/file bodies');
evidence.status='PASS';evidence.model='mock provider, real Docker Runner and file tools';evidence.completedAt=new Date().toISOString();
await mkdir('data/project-folder-evidence',{recursive:true});await writeFile('data/project-folder-evidence/api-report.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
