import { _electron as electron, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const root=resolve("."), profile=await mkdtemp(join(tmpdir(),"pig-shared-desktop-")),base="http://127.0.0.1:8892";
const env=Object.fromEntries((await readFile("data/cluster-local/stack.env","utf8")).split("\n").filter(x=>x.includes("=")).map(x=>[x.slice(0,x.indexOf("=")),x.slice(x.indexOf("=")+1)]));
const token=env.MEMBER_TOKEN;
async function api(path,body){const r=await fetch(base+path,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json","Idempotency-Key":randomUUID()},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,path+" "+r.status);return r.json();}
async function waitRun(id){let run;await expect.poll(async()=>{run=await api(`/v1/runs/${id}`);return run.state;},{timeout:60000}).toBe("succeeded");return run;}
const space=await api("/v1/spaces",{name:"Desktop transport "+randomUUID().slice(0,5)});
const project=await api("/v1/shared-projects",{spaceId:space.id,name:"桌面共享验收",description:"跨设备共用的项目背景"});
const first=await api("/v1/runs",{projectId:project.id,prompt:"桌面打开已有共享会话"});const run=await waitRun(first.id);
const app=await electron.launch({executablePath:createRequire(join(root,"apps/desktop/package.json"))("electron"),args:[join(root,"apps/desktop")],env:{...process.env,PIG_DESKTOP_USER_DATA:profile}});
const checks=[],errors=[];
try{
 const page=await app.firstWindow();page.on("pageerror",e=>errors.push(e.message));await page.waitForURL("pig://app/**");
 const config=await page.evaluate(async({base,token})=>{const r=await fetch("/api/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({cloudBaseUrl:base,cloudToken:token,cloudMode:"remote"})});return {status:r.status};},{base,token});assert.equal(config.status,200);
 const before=await page.evaluate(()=>fetch("/api/sessions").then(r=>r.json()));assert.equal(before.sessions.length,0);
 const streams=[];page.on("response",r=>{if(r.url().includes("/events?")&&r.url().includes("/conversations/"))streams.push({status:r.status(),url:r.url()});});
 await page.goto(`pig://app/#/shared/${run.conversation_id}`);
 await expect(page.getByRole("heading",{name:"桌面打开已有共享会话",exact:true})).toBeVisible({timeout:30000});
 await expect.poll(()=>streams.some(r=>r.status===200)).toBe(true);
 checks.push("actual Electron pig:// isolated profile opens existing control-plane conversation with no local session import; conversation SSE returns200 through desktop proxy");
 const follow=await api(`/v1/runs/${first.id}/follow-ups`,{prompt:"另一个设备追加，桌面实时收到"});await waitRun(follow.id);
 await expect(page.getByText("另一个设备追加，桌面实时收到",{exact:true})).toBeVisible({timeout:30000});
 await expect(page.getByText("已完成",{exact:true})).toBeVisible();
 checks.push("remote API appends next turn and already-open Electron conversation receives it over persistent SSE");
 await page.getByRole("button",{name:"成果与过程",exact:true}).click();await page.getByText("分享会话",{exact:true}).click();
 await expect(page.getByLabel("会话链接")).toHaveValue(`${base}/#/conversations/${run.conversation_id}`);
 const after=await page.evaluate(()=>fetch("/api/sessions").then(r=>r.json()));assert.equal(after.sessions.length,0);
 checks.push("share link is control-plane HTTP URL usable by logged-in project members, never pig://; local session count remainszero");
 await mkdir("data/desktop-shared-evidence",{recursive:true});await page.screenshot({path:"data/desktop-shared-evidence/workspace.png"});
 assert.equal(errors.length,0,errors.join("\n"));await writeFile("data/desktop-shared-evidence/checks.json",JSON.stringify({at:new Date().toISOString(),environment:"actual Electron44 isolated profile; pig:// desktop proxy; Docker cluster8892 mock model; no OS permission requests",conversationId:run.conversation_id,checks,errors},null,2));console.log(checks.join("\n"));
}finally{await app.close();await rm(profile,{recursive:true,force:true});}
