import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'pig-core-market-'));
const work=join(root,'workspace'); await mkdir(work);
const out=resolve(process.env.PIG_CORE_EVIDENCE || 'data/core-market-review'); await mkdir(out,{recursive:true});
const checks=[], errors=[], calls=[];
let followCalls=0;
const provider=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw); calls.push(body);
 const lastUser=body.messages.filter(m=>m.role==='user').at(-1)?.content || '';
 if(lastUser.includes('CORE_ERROR')) {res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture rejected'}}));return;}
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const emit=delta=>res.write(`data: ${JSON.stringify({choices:[{delta}]})}\n\n`);
 const tools=body.messages.filter(m=>m.role==='tool');
 if(lastUser.includes('CORE_REJECT')) {emit({tool_calls:[{index:0,id:'denied-first',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'denied.txt',content:'must not write'})}},{index:1,id:'denied-second',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'after-denial.txt',content:'must not write'})}}]});}
 else if(lastUser.includes('CORE_FOLLOW')) {followCalls++;emit({content:'已核对：上一轮创建了 proof.txt，内容为 CORE_PROOF。'});}
 else if(!tools.some(t=>t.tool_call_id==='core-write')) emit({tool_calls:[{index:0,id:'core-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'proof.txt',content:'CORE_PROOF'})}}]});
 else if(!tools.some(t=>t.tool_call_id==='core-read')) emit({tool_calls:[{index:0,id:'core-read',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'proof.txt'})}}]});
 else {for(const content of ['已完成：','创建并读回 proof.txt，','内容为 CORE_PROOF。']) {emit({content});await new Promise(r=>setTimeout(r,100));}}
 res.end('data: [DONE]\n\n');
});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(LLM_|DEEPSEEK_|OPENAI_|CODEX_|CLOUD_|PIG_CLOUD_)/.test(key)));
const base='http://127.0.0.1:18801';
const server=spawn(process.execPath,['--import','tsx','apps/server/src/index.ts'],{env:{...env,PIG_DESKTOP:'1',PIG_LOCAL_WORKBENCH:'1',PORT:'18801',DATA_DIR:root,WORKSPACE_ROOT:work,LLM_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,LLM_API_KEY:'fixture-only',LLM_MODEL:'core-fixture'},stdio:'ignore'});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
const api=async(path,body,method=body?'POST':'GET')=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,`${path}: ${r.status} ${await r.clone().text()}`);return r.json();};
const shot=async(name)=>{for(const width of [1440,390]){await page.setViewportSize({width,height:width===1440?900:844});await page.screenshot({path:join(out,`${name}-${width}.png`),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' overflow '+width);}await page.setViewportSize({width:1440,height:900});};
try {
 await expect.poll(async()=>{try{return(await fetch(base+'/api/health')).status;}catch{return 0;}},{timeout:20000}).toBe(200);
 await page.goto(base+'/#/projects');
 await page.getByRole('button',{name:/项目目录/}).click();
 await page.getByPlaceholder('新项目名称').fill('交互回归项目');
 await page.getByPlaceholder('本地目录绝对路径').fill(work);
 await page.getByRole('dialog',{name:'项目目录'}).getByRole('button',{name:'新建项目',exact:true}).click();
 await expect(page.getByRole('heading',{name:'交互回归项目',exact:true})).toBeVisible();
 await shot('project');
 await page.getByRole('button',{name:'在此项目开任务',exact:true}).click();
 await expect(page).toHaveURL(/sessions/);
 const sid=page.url().split('/').at(-1);
 const wb=await api('/api/sessions/'+sid+'/workbench'); await api('/api/sessions/'+sid+'/workbench',{...wb.policy,review:true},'PUT'); await page.reload();
 await expect(page.getByLabel('任务消息')).toBeEnabled();
 await page.getByLabel('添加本地任务文件').setInputFiles({name:'input-note.txt',mimeType:'text/plain',buffer:Buffer.from('CORE_ATTACHMENT：验收输入')});
 await expect(page.locator('.local-attachments')).toContainText('input-note.txt');
 await page.getByLabel('任务消息').fill('CORE_START：读取附件并创建 proof.txt，然后回读核对。');
 await shot('attachment');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByRole('button',{name:'批准执行',exact:true})).toBeVisible({timeout:20000});
 await assert.rejects(access(join(work,'proof.txt')));
 assert.equal(calls.length,1,'approval must block next model call');
 await page.reload();
 await expect(page.getByRole('button',{name:'批准执行',exact:true})).toBeVisible();
 if(process.env.PIG_CORE_BEFORE!=='1') await expect(page.getByText('本轮没有最终回答',{exact:true})).toHaveCount(0);
 await shot('approval');
 await page.getByRole('button',{name:'批准执行',exact:true}).click();
 if(process.env.PIG_CORE_BEFORE==='1' && await page.getByRole('button',{name:'返回对话',exact:true}).isVisible()) {await shot('unwanted-file-navigation');await page.getByRole('button',{name:'返回对话',exact:true}).click();}
 await expect(page.getByText('已完成：创建并读回 proof.txt，内容为 CORE_PROOF。',{exact:true})).toBeVisible({timeout:20000});
 assert.equal(await readFile(join(work,'proof.txt'),'utf8'),'CORE_PROOF');
 await shot('result');
 await page.getByLabel('任务消息').fill('CORE_FOLLOW：上一轮的成果是什么？');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByText('已核对：上一轮创建了 proof.txt，内容为 CORE_PROOF。',{exact:true})).toBeVisible();
 await page.reload();
 await expect(page.getByText('已核对：上一轮创建了 proof.txt，内容为 CORE_PROOF。',{exact:true})).toBeVisible();
 const session=await api('/api/sessions/'+sid);
 assert.equal(session.messages.filter(m=>m.role==='user'&&m.content.includes('CORE_FOLLOW')).length,1);assert.equal(followCalls,1);
 checks.push('real project creation and workspace binding; actual attachment upload; native write gated before approval and survives refresh; actual readback; follow-up appears once and survives refresh');
 // Sending failure must retain the original draft.
 await page.route('**/api/sessions/*/messages',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'验收网络中断，请重试'})}));
 await page.getByLabel('任务消息').fill('CORE_RETRY 保留这条消息');await page.getByRole('button',{name:'发送',exact:true}).click();
 if(process.env.PIG_CORE_BEFORE==='1') {await expect(page.getByLabel('任务消息')).toHaveValue(''); checks.push('BEFORE defect: HTTP rejection clears unsent draft');} else await expect(page.getByLabel('任务消息')).toHaveValue('CORE_RETRY 保留这条消息');
 await shot('send-error');await page.unroute('**/api/sessions/*/messages');
 if(process.env.PIG_CORE_BEFORE!=='1') {await page.reload();await expect(page.getByLabel('任务消息')).toHaveValue('CORE_RETRY 保留这条消息');await expect(page.getByRole('button',{name:'重试本轮',exact:true})).toHaveCount(0);checks.push('HTTP send failure retains draft after reload and removes phantom user message');}
 if(process.env.PIG_CORE_BEFORE!=='1') {
  // POST an independent session; never exercise negative cases on the completed project task.
  const rejected=await api('/api/sessions',{});
  const state=await api('/api/sessions/'+rejected.id+'/workbench');
  await api('/api/sessions/'+rejected.id+'/workbench',{...state.policy,review:true},'PUT');
  await page.goto(base+'/#/sessions/'+rejected.id);
  await expect(page.getByRole('heading',{name:'新任务',exact:true})).toBeVisible();
  await expect(page.getByLabel('任务消息')).toBeEnabled();
  await page.getByLabel('任务消息').fill('CORE_REJECT：两个连续写入，拒绝第一项后不能执行第二项。');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.getByRole('button',{name:'批准执行',exact:true})).toHaveCount(1);
  await expect(page.getByRole('button',{name:'拒绝',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'拒绝',exact:true}).click();
  await expect(page.getByRole('button',{name:'批准执行',exact:true})).toHaveCount(0);
  await assert.rejects(access(join(work,'denied.txt')));await assert.rejects(access(join(work,'after-denial.txt')));
  await shot('rejected');
  checks.push('only one approval shown; rejecting first tool prevents both writes in the batch');
  const cancelled=await api('/api/sessions',{});
  const cancelState=await api('/api/sessions/'+cancelled.id+'/workbench');
  await api('/api/sessions/'+cancelled.id+'/workbench',{...cancelState.policy,review:true},'PUT');
  await page.goto(base+'/#/sessions/'+cancelled.id);
  await expect(page.getByRole('heading',{name:'新任务',exact:true})).toBeVisible();
  await expect(page.getByLabel('任务消息')).toBeEnabled();
  await page.getByLabel('任务消息').fill('CORE_REJECT：等待审批时取消整轮。');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.getByRole('button',{name:'批准执行',exact:true})).toBeVisible();
  await page.getByRole('button',{name:/执行与验收/}).click();
  await page.getByRole('button',{name:'停止执行',exact:true}).click();
  await expect.poll(async()=>(await api('/api/sessions/'+cancelled.id+'/workbench')).operations.some(op=>op.status==='pending')).toBe(false);
  await page.getByRole('button',{name:'关闭执行与验收',exact:true}).click();
  await page.reload();await expect(page.getByRole('button',{name:'批准执行',exact:true})).toHaveCount(0);
  await assert.rejects(access(join(work,'denied.txt')));await assert.rejects(access(join(work,'after-denial.txt')));
  await expect(page.getByText('已取消',{exact:true})).toBeVisible();
  checks.push('cancel waiting approval through browser and reload: durable cancelled outcome, no pending approval or writes');

 }
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('button',{name:/^插件/}).click();
 const panel=page.getByRole('region',{name:'插件管理'});
 await expect(panel).toBeVisible();
 await panel.getByLabel('搜索扩展').fill('CSV');
 await expect(panel.getByRole('heading',{name:'CSV 数据质量',exact:true})).toBeVisible();
 await shot('market');
 await panel.getByRole('button',{name:'查看内容',exact:true}).click();
 await shot('market-detail');
 if(process.env.PIG_CORE_BEFORE==='1') {await writeFile(join(out,'baseline.json'),JSON.stringify({checks,errors},null,2));}
 else {
  await expect(panel.getByText('scripts/check_csv.py',{exact:true})).toBeVisible();
  await page.route('**/api/plugins/catalog/data-quality', route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'验收：暂时无法安装，请重试'})}), {times:1});
  await panel.getByRole('button',{name:'安装此扩展',exact:true}).click();
  await expect(panel.getByRole('alert')).toContainText('暂时无法安装');
  await shot('market-error');
  await panel.getByRole('button',{name:'安装此扩展',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText('已安装');
  assert.equal((await api('/api/plugins')).plugins[0].enabled,false);
  await panel.getByRole('button',{name:'启用此扩展',exact:true}).click();
  await expect(panel.getByRole('button',{name:'停用此扩展',exact:true})).toBeVisible();
  await shot('market-enabled');
  await panel.getByRole('link',{name:'选择专家与技能，开始使用 →'}).click();
  await expect(page.getByRole('heading',{name:'数据核验专家',exact:true})).toBeVisible();
  await page.getByRole('heading',{name:'数据核验专家',exact:true}).locator('..').getByRole('button',{name:'用于当前任务'}).click();
  await expect(page.getByLabel('任务消息')).toBeVisible();
  const boundId=page.url().split('/').at(-1);
  await expect.poll(async()=>(await api('/api/sessions/'+boundId)).expertId).toBe('plugin_data-quality_data-quality-expert');
  await page.getByLabel('任务消息').fill('/CSV');
  await page.getByRole('option').filter({hasText:'CSV 数据质量'}).click();
  await expect.poll(async()=>(await api('/api/sessions/'+boundId)).skillIds).toContain('plugin_data-quality_data-quality-guide');
  await expect(page.getByLabel('已选技能')).toContainText('CSV 数据质量');
  await shot('skill-selected');
  checks.push('market search, resource preview, visible install error and retry, install disabled, enable, usable expert binding and slash skill selection persisted');
  assert.deepEqual(errors,[]);
  await writeFile(join(out,'report.json'),JSON.stringify({status:'PASS',environment:'isolated local server, scripted SSE provider, real native tools; no production or Docker',checks,errors},null,2));
 }
 console.log('PASS '+checks.join('; ')+' Evidence: '+out);
} catch(e) {await page.screenshot({path:join(out,'failure.png'),fullPage:true});await writeFile(join(out,'failure.txt'),String(e)+'\n'+await page.locator('body').innerText());throw e;}
finally {await browser.close();server.kill('SIGTERM');provider.closeAllConnections();provider.close();}
