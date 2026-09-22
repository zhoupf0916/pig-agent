import {chromium,expect} from "@playwright/test";
import assert from "node:assert/strict";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {randomUUID,createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
const env=Object.fromEntries((await readFile("data/cluster-local/stack.env","utf8")).split("\n").filter(x=>x.includes("=")).map(x=>[x.slice(0,x.indexOf("=")),x.slice(x.indexOf("=")+1)]));
const base="http://127.0.0.1:8892",token=env.MEMBER_TOKEN,checks=[],runIds=[];
async function req(path,body,status=200,auth=token){const r=await fetch(base+path,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${auth}`,"Content-Type":"application/json","Idempotency-Key":randomUUID()},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});assert.equal(r.status,status,path+" "+await(r.status!==status?r.clone().text():Promise.resolve("")));return r.json();}
async function until(fn,label){for(let n=0;n<600;n++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw Error(label);}
async function done(id){return until(async()=>{const r=await req(`/v1/runs/${id}`);return ["succeeded","failed","cancelled"].includes(r.state)&&r;},"terminal");}
async function create(policy="ask"){const run=await req("/v1/runs",{prompt:"[NETWORK_ACCEPTANCE:https://example.com/] 验证限制、申请与单次访问",networkPolicy:policy,requireApproval:false},201);runIds.push(run.id);return run.id;}
async function pending(id){return until(async()=>{const a=(await req(`/v1/runs/${id}/approvals`)).approvals;return a.find(a=>a.tool==="http_fetch"&&a.state==="pending");},"network approval");}
async function events(id){return (await req(`/v1/runs/${id}/eventlog`)).events;}
function sql(text){return execFileSync("docker",["compose","--env-file","data/cluster-local/stack.env","-f","infra/cluster/compose.yml","exec","-T","postgres","psql","-U","pig","-d","pig","-At","-c",text],{encoding:"utf8"}).trim();}
async function browserApprove(id) {
 const run=await req(`/v1/runs/${id}`), browser=await chromium.launch({channel:"chrome",headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 try {
   const login=await context.request.post(base+"/auth/web/login",{headers:{Origin:base},data:{token}});assert(login.ok());
   const page=await context.newPage();await page.goto(base+"/#/conversations/"+run.conversation_id);
   await expect(page.getByText("请求访问网络",{exact:true})).toBeVisible({timeout:15000});
   await mkdir("data/network-evidence",{recursive:true});await page.screenshot({path:"data/network-evidence/approval-desktop.png"});
   await page.setViewportSize({width:390,height:844});await page.getByRole("button",{name:"批准操作",exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:"data/network-evidence/approval-mobile.png"});
   await page.getByRole("button",{name:"批准操作",exact:true}).click();
   await context.request.post(base+"/auth/web/logout",{headers:{Origin:base}});
 } finally {await browser.close();}
}
const approved=await create(),ap=await pending(approved);
assert.equal(ap.args.method,"GET");assert.equal(ap.args.url,"https://example.com/");
await browserApprove(approved);await done(approved);
const approvedEvents=await events(approved),raw=JSON.stringify(approvedEvents);
assert(raw.includes("NETWORK_RESTRICTED"),"container shell remains network restricted");
assert(raw.includes("Example Domain"),"approved gateway GET must actually retrieve public page");
assert.equal((await req(`/v1/runs/${approved}/approvals`)).approvals.find(a=>a.id===ap.id).state,"consumed");
checks.push("real isolated container direct shell HTTPS probe fails; exact URL GET approval then retrieves actual public HTTPS response through gateway and consumes authorization");
const rejected=await create(),rp=await pending(rejected);await req(`/v1/runs/${rejected}/approvals/${rp.id}/decision`,{decision:"reject"});await done(rejected);assert(JSON.stringify(await events(rejected)).includes("用户拒绝了单次网络访问"));assert.equal(sql(`SELECT count(*) FROM audit WHERE run_id='${rejected}' AND action LIKE 'network:get:%'`),"0");checks.push("reject produces denied tool result and no outbound authorization claim");
const blocked=await create("blocked");await done(blocked);assert.equal((await req(`/v1/runs/${blocked}/approvals`)).approvals.length,0);assert(JSON.stringify(await events(blocked)).includes("此任务禁止网络访问"));checks.push("blocked policy produces no approval or network GET");
const cancelled=await create(),cp=await pending(cancelled);await req(`/v1/runs/${cancelled}/abort`,{});assert.equal((await done(cancelled)).state,"cancelled");await req(`/v1/runs/${cancelled}/approvals/${cp.id}/decision`,{decision:"approve"},409);checks.push("cancel while waiting terminates container and old approval cannot be accepted");
// Direct control-plane authorization fixture verifies exact binding/replay on real Postgres.
const fixture="run_"+randomUUID().replaceAll("-",""),secret=randomUUID(),hash=createHash("sha256").update(secret).digest("hex"),aid="approval_"+randomUUID().replaceAll("-",""),callId="network-binding-proof";
const request={url:"https://example.com/",method:"GET",timeoutMs:10000,maxBytes:200000};
sql(`INSERT INTO runs(id,owner_id,input,state,attempt_token,lease_until,deadline_at,worker_id) VALUES('${fixture}','member','{"prompt":"authorization fixture","networkPolicy":"ask"}','running','${hash}',now()+interval '1 minute',now()+interval '1 minute',(SELECT id FROM workers WHERE enabled LIMIT 1)); INSERT INTO approvals(id,run_id,call_id,tool,args,state) VALUES('${aid}','${fixture}','${callId}','http_fetch','${JSON.stringify(request)}','approved');`);
try{
await req("/internal/network/claim",{token:secret,callId,request:{...request,url:"https://example.org/"}},403,env.WORKER_TOKEN);
await req("/internal/network/claim",{token:secret,callId,request:{...request,url:"https://127.0.0.1/"}},400,env.WORKER_TOKEN);
await req("/internal/network/claim",{token:secret,callId,request},200,env.WORKER_TOKEN);
await req("/internal/network/claim",{token:secret,callId,request},403,env.WORKER_TOKEN);
checks.push("real database claim rejects altered URL, SSRF target and reused permission; one matching GET accepted");
}finally{sql(`UPDATE runs SET state='cancelled',attempt_token=NULL,lease_until=NULL WHERE id='${fixture}'`);}
await mkdir("data/network-evidence",{recursive:true});await writeFile("data/network-evidence/checks.json",JSON.stringify({at:new Date().toISOString(),environment:"local Docker 2CP/2Runner cluster8892, explicit mock model network scenario, real HTTPS GET to example.com via explicit public DoH mode; private/Fake-IP addresses stay blocked",checks,runIds},null,2));console.log(checks.join("\n"));
