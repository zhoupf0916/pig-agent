// Operator-only end-to-end probe against an explicitly selected deployment.
// Uses one real model task. Approves only the exact public GET fixture below.
import {readFile,writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import assert from 'node:assert/strict';
const base=process.env.VERIFY_BASE||'http://127.0.0.1:8890';
const env=parseEnv(await readFile(process.env.VERIFY_ENV||'data/cloud-local/stack.env','utf8'));
const target='https://www.qq.com/';
const req=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${env.ADMIN_TOKEN}`,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});assert(r.ok,`${path} HTTP ${r.status}`);return r.json();};
const run=await req('/v1/runs',{prompt:`请通过 http_fetch 读取 ${target}，等待我的一次性联网审批后获取网页标题，并用一句话解释结果。不要使用 shell，不要写文件。这是联网验收。`,requireApproval:true,networkPolicy:'ask'});
const evidence={id:run.id,target,started:new Date().toISOString(),approved:[],waitingVerified:false};
try{for(let i=0;i<180;i++){
 const approvals=(await req(`/v1/runs/${run.id}/approvals`)).approvals;
 for(const a of approvals.filter(a=>a.state==='pending')){
  assert.equal(a.tool,'http_fetch');assert.equal(a.args.url,target);assert.equal(a.args.method,'GET');
  if(!evidence.waitingVerified){await new Promise(r=>setTimeout(r,2000));const current=(await req(`/v1/runs/${run.id}/approvals`)).approvals.find(x=>x.id===a.id);assert.equal(current.state,'pending');evidence.waitingVerified=true;}
  assert(evidence.approved.length<1,'No silent repeated approvals');
  await req(`/v1/runs/${run.id}/approvals/${a.id}/decision`,{decision:'approve'});evidence.approved.push(a.id);
 }
 const state=await req('/v1/runs/'+run.id);if(['succeeded','failed','cancelled'].includes(state.state)){evidence.state=state.state;break;}
 await new Promise(r=>setTimeout(r,1000));
}
evidence.events=(await req(`/v1/runs/${run.id}/eventlog`)).events;
evidence.approvals=(await req(`/v1/runs/${run.id}/approvals`)).approvals;
assert.equal(evidence.state,'succeeded');assert.equal(evidence.approved.length,1);assert(evidence.approvals.some(a=>a.state==='consumed'));
const session=evidence.events.find(x=>x.event.type==='done')?.event.session;
assert(session,'Completed session must be recorded');
const networkResult=session.messages.find(m=>m.role==='tool'&&m.toolOk);
assert.equal(JSON.parse(networkResult.content).status,200);
assert(JSON.parse(networkResult.content).body.length>0);
for(const m of session.messages.filter(m=>m.role==='assistant'&&m.content.trim()))assert(/[\u3400-\u9fff]/u.test(m.content),'Progress and final prose must both be Chinese');
console.log('PASS approved GET and Chinese response; run',run.id);
}finally{if(!evidence.state)await req(`/v1/runs/${run.id}/abort`,{});await writeFile(process.env.VERIFY_OUTPUT||'data/network-verification.json',JSON.stringify(evidence,null,2));}
