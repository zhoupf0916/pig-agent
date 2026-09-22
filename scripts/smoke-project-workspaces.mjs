import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const env=Object.fromEntries((await readFile('data/cluster-local/stack.env','utf8')).split('\n').filter(x=>x.includes('=')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
const base='http://127.0.0.1:8893',peer='http://127.0.0.1:8894';
async function api(path,{token=env.MEMBER_TOKEN,body,status=200,origin=base}={}){const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,status,await(r.status===status?Promise.resolve(path):r.text()));return r.json();}
const project=await api('/v1/projects',{body:{name:'个人工作区验收 '+randomUUID().slice(0,8),description:'项目背景 WORKSPACE_CONTEXT',workspaceName:'分析文件'},status:201});
const listed=await api('/v1/projects',{origin:peer});
assert.equal(listed.projects.find(p=>p.id===project.id).kind,'personal');
assert.equal(listed.projects.find(p=>p.id===project.id).workspace_name,'分析文件');
const outsider=await api('/v1/projects',{token:env.MEMBER2_TOKEN});assert(!outsider.projects.some(p=>p.id===project.id));
await api(`/v1/projects/${project.id}/workspace`,{token:env.MEMBER2_TOKEN,status:404});
await api('/v1/runs',{token:env.MEMBER2_TOKEN,body:{projectId:project.id,prompt:'越权'},status:403});
const run=await api('/v1/runs',{body:{projectId:project.id,prompt:'请完成工作区测试'},status:201});
let detail;
for(let i=0;i<400;i++){detail=await api('/v1/runs/'+run.id);if(['succeeded','failed','cancelled'].includes(detail.state))break;await new Promise(r=>setTimeout(r,150));}
assert.equal(detail.state,'succeeded',detail.error);
const workspace=await api(`/v1/projects/${project.id}/workspace`,{origin:peer});assert.equal(workspace.workspaceMode,'conversation');assert.equal(workspace.workspaceName,'分析文件');assert.equal(workspace.conversations[0].id,detail.conversation_id);
assert.equal(workspace.conversations[0].versions[0].run_id,run.id);
await mkdir('data/project-workspace-evidence',{recursive:true});await writeFile('data/project-workspace-evidence/checks.json',JSON.stringify({at:new Date().toISOString(),environment:'2 control planes,2 runners,local Docker mock model',projectId:project.id,runId:run.id,checks:['private project persists across control instances','non-owner list/workspace/run creation denied','project task executes and saved workspace version appears across control instances'],workspace},null,2));
console.log('Private project isolation and workspace version runtime checks passed');
