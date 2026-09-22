import assert from "node:assert/strict";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
const env=Object.fromEntries((await readFile("data/cluster-local/stack.env","utf8")).split("\n").filter(x=>x.includes("=")).map(x=>[x.slice(0,x.indexOf("=")),x.slice(x.indexOf("=")+1)]));
const base="http://127.0.0.1:8892",checks=[];
async function req(path,{body,method=body?"POST":"GET",status=200,token=env.MEMBER_TOKEN}={}){const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json","Idempotency-Key":randomUUID()},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,status,`${path} ${await(r.status!==status?r.clone().text():Promise.resolve(""))}`);return r.json();}
const skills=(await req("/v1/skills")).skills,experts=(await req("/v1/experts")).experts;assert(skills.some(s=>s.id==="coding-helper"&&s.body));assert(experts.some(e=>e.id==="exp_scout"&&e.instruction));
const skill=await req("/v1/skills",{body:{name:"核验流程",description:"用户保存技能",body:"CAPABILITY_SKILL_PROOF：先验证输入再核验输出"},status:201});
const expert=await req("/v1/experts",{body:{name:"核验专家",description:"用户保存专家",instruction:"CAPABILITY_EXPERT_PROOF：执行所选核验流程",skillIds:[skill.id]},status:201});
await req(`/v1/skills/${skill.id}`,{method:"PATCH",body:{description:"修改后保持"}});assert.equal((await req(`/v1/skills/${skill.id}`)).description,"修改后保持");
for(const path of [`/v1/skills/${skill.id}`,`/v1/experts/${expert.id}`]){await req(path,{token:env.MEMBER2_TOKEN,status:404});await req(path,{token:env.MEMBER2_TOKEN,method:"PATCH",body:{name:"Denied"},status:404});}
await req("/v1/experts/exp_scout",{method:"PATCH",body:{name:"Denied"},status:403});await req("/v1/skills/coding-helper",{method:"PATCH",body:{name:"Denied"},status:403});
await req("/v1/runs",{token:env.MEMBER2_TOKEN,body:{prompt:"不能使用别人的专家",expertId:expert.id},status:400});
checks.push("existing bundled experts/skills readable and immutable; user create/edit/read persists; otheraccount read/edit/use denied");
const run=await req("/v1/runs",{body:{prompt:"验证选中的专家和技能",expertId:expert.id,skillIds:[skill.id]},status:201});
let finished;for(let i=0;i<300;i++){finished=await req(`/v1/runs/${run.id}`);if(["succeeded","failed","cancelled"].includes(finished.state))break;await new Promise(r=>setTimeout(r,200));}assert.equal(finished.state,"succeeded",finished.error);
const count=execFileSync("docker",["compose","--env-file","data/cluster-local/stack.env","-f","infra/cluster/compose.yml","exec","-T","postgres","psql","-U","pig","-d","pig","-At","-c",`SELECT count(*) FROM runs WHERE id='${run.id}' AND input->>'capabilityContext' LIKE '%CAPABILITY_EXPERT_PROOF%' AND input->>'capabilityContext' LIKE '%CAPABILITY_SKILL_PROOF%'`],{encoding:"utf8"}).trim();assert.equal(count,"1");
checks.push("selected user expert and skill resolve to authoritative execution context and real Docker run completes");
await req("/v1/resource-drafts",{body:{kind:"expert",prompt:"核验专家"},status:503});checks.push("mock platform without configured provider honestly returns503 for AI draft; manual creation remains usable");
await mkdir("data/capabilities-evidence",{recursive:true});await writeFile("data/capabilities-evidence/checks.json",JSON.stringify({at:new Date().toISOString(),environment:"real local Docker cluster8892 and Postgres; mock execution model; no real provider draft generation claim",runId:run.id,expertId:expert.id,skillId:skill.id,checks},null,2));console.log(checks.join("\n"));
