import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const env=Object.fromEntries((await readFile("data/cluster-local/stack.env","utf8")).split("\n").filter(x=>x.includes("=")).map(x=>[x.slice(0,x.indexOf("=")),x.slice(x.indexOf("=")+1)]));
const base="http://127.0.0.1:8893", peer="http://127.0.0.1:8894", accounts=[], checks=[];
async function req(path,{token=env.ADMIN_TOKEN,body,method=body?"POST":"GET",status=200,key=randomUUID(),origin=base}={}){
 const r=await fetch(origin+path,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json","Idempotency-Key":key},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 assert.equal(r.status,status,`${path} ${await(r.status!==status?r.clone().text():Promise.resolve(""))}`);return r.json();
}
async function until(fn,label){for(let i=0;i<600;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);}
async function wait(id,token){let run;await until(async()=>{run=await req(`/v1/runs/${id}`,{token});return ["succeeded","failed","cancelled"].includes(run.state);},"run terminal");assert.equal(run.state,"succeeded",run.error);return run;}
async function stream(id,token,after=0){
 const controller=new AbortController(),items=[];let closed=false;
 const response=await fetch(`${peer}/v1/conversations/${id}/events?after=${after}`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});assert.equal(response.status,200);
 const task=(async()=>{const reader=response.body.getReader();let buffer="";const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf("\n\n"))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+2);for(const line of raw.split("\n"))if(line.startsWith("data: "))items.push(JSON.parse(line.slice(6)));}}}catch(e){if(e.name!=="AbortError")throw e;}finally{closed=true;}})();
 return {items,task,stop:()=>controller.abort(),get closed(){return closed;}};
}
let feed,replay,revoked;
try{
 for(let i=0;i<3;i++){const invite=await req("/v1/admin/invitations",{body:{name:"realtime-"+i+"-"+randomUUID().slice(0,6)},status:201});accounts.push(await req("/auth/accept-invite",{body:{invite:invite.invite},status:201}));}
 const [owner,editor,viewer]=accounts;
 const space=await req("/v1/spaces",{token:owner.token,body:{name:"实时协作验收"},status:201});
 const project=await req("/v1/shared-projects",{token:owner.token,body:{spaceId:space.id,name:"共享销售分析",description:"项目共同背景标记 SHARED_CONTEXT_PROOF；交付前核对总额。"},status:201});
 for(const [account,role]of[[editor,"editor"],[viewer,"viewer"]]){const invitation=await req(`/v1/spaces/${space.id}/invitations`,{token:owner.token,body:{role},status:201});await req("/v1/spaces/join",{token:account.token,body:{invite:invitation.invite}});}
 const initial=await req("/v1/runs",{token:owner.token,body:{projectId:project.id,prompt:"第一位成员开始共享分析"},status:201});
 const run=await wait(initial.id,owner.token),id=run.conversation_id;
 feed=await stream(id,editor.token);
 await until(()=>feed.items.some(e=>e.type==="conversation_snapshot"),"initial snapshot");
 const first=await req(`/v1/conversations/${id}`,{token:viewer.token});assert.equal(first.conversation.can_write,false);assert.equal(first.messages.find(m=>m.content==="第一位成员开始共享分析").author.id,owner.account.id);
 await req(`/v1/runs/${run.id}/follow-ups`,{token:viewer.token,body:{prompt:"只读不可发送"},status:404});
 const key=randomUUID(),prompt="第二位成员继续，共享同一上下文";
 const follow=await req(`/v1/runs/${run.id}/follow-ups`,{token:editor.token,body:{prompt},status:201,key});
 await req(`/v1/runs/${run.id}/follow-ups`,{token:editor.token,body:{prompt},key});
 await until(()=>feed.items.some(e=>e.type==="conversation_snapshot"&&e.runs.some(r=>r.id===follow.id)),"new turn arrives across CP without resubscription");
 await wait(follow.id,owner.token);
 await until(()=>feed.items.some(e=>e.type==="run_event"&&e.runId===follow.id&&e.event.type==="token"),"cross CP incremental tokens");
 const detail=await req(`/v1/conversations/${id}`,{token:owner.token});assert.equal(detail.runs.length,2);assert.equal(detail.messages.find(m=>m.content===prompt).author.id,editor.account.id);assert(detail.messages.some(m=>m.content==="第一位成员开始共享分析"));
 const proof=execFileSync("docker",["compose","--env-file","data/cluster-local/stack.env","-f","infra/cluster/compose.yml","exec","-T","postgres","psql","-U","pig","-d","pig","-At","-c",`SELECT count(*) FROM runs WHERE conversation_id='${id}' AND input->>'projectContext' LIKE '%SHARED_CONTEXT_PROOF%' AND (parent_run_id IS NULL OR input->'messages' @> '[{"role":"user","content":"第一位成员开始共享分析"}]'::jsonb)`],{encoding:"utf8"}).trim();
 assert.equal(proof,"2","both runs pin shared project context and followup carries authoritative first-user message");
 checks.push("database verifies common project context on both turns and previous member user message in followup model input");
 checks.push("two users share durable history and attributed authors; editor followup with idempotency; viewer cannot write; live SSE sees subsequent turn and tokens across two control instances");
 const cursor=feed.items.find(e=>e.type==="run_event"&&e.runId===follow.id).seq;
 replay=await stream(id,owner.token,cursor);await until(()=>replay.items.some(e=>e.type==="run_event"),"cursor replay");assert(replay.items.filter(e=>e.type==="run_event").every(e=>e.seq>cursor));replay.stop();await replay.task;
 // Competing participants cannot create sibling turns from the same parent.
 const results=await Promise.all([owner,editor].map(async(account)=>{const r=await fetch(base+`/v1/runs/${follow.id}/follow-ups`,{method:"POST",headers:{Authorization:`Bearer ${account.token}`,"Content-Type":"application/json","Idempotency-Key":randomUUID()},body:JSON.stringify({prompt:"并发跟进 "+account.account.id})});return {status:r.status,body:await r.json()};}));
 assert.deepEqual(results.map(x=>x.status).sort(),[201,409]);await wait(results.find(x=>x.status===201).body.id,owner.token);checks.push("concurrent multiuser followup is serialized: one201 one409; cursor replay excludes earlier sequence");
 revoked=await stream(id,viewer.token);await until(()=>revoked.items.some(e=>e.type==="conversation_snapshot"),"viewer connected");await req(`/v1/spaces/${space.id}/members/${viewer.account.id}`,{token:owner.token,method:"DELETE"});await until(()=>revoked.closed,"membership revocation closes stream");assert(revoked.items.some(e=>e.type==="access_revoked"));
 await req("/v1/logout",{token:editor.token,method:"POST"});await until(()=>feed.closed,"session revocation closes stream");assert(feed.items.some(e=>e.type==="access_revoked"));checks.push("membership removal and logout revoke already-open SSE streams within polling bound");
 await mkdir("data/realtime-evidence",{recursive:true});await writeFile("data/realtime-evidence/checks.json",JSON.stringify({at:new Date().toISOString(),environment:"local Docker cluster 2 control planes on8893/8894; 2 runners; mock model",checks,conversationId:id,runIds:[initial.id,follow.id,...results.filter(x=>x.status===201).map(x=>x.body.id)]},null,2));console.log(checks.join("\n"));
}finally{for(const s of [feed,replay,revoked]){s?.stop();await s?.task;}for(const a of accounts)await req(`/v1/admin/accounts/${a.account.id}`,{method:"PATCH",body:{enabled:false,revokeSessions:true}});}
