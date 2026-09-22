import { chromium, expect } from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const out=resolve('data/multiple-workspaces-evidence');await mkdir(out,{recursive:true});
const root=await mkdtemp(resolve('data/multiple-workspaces-'));
const front=resolve(root,'frontend'),back=resolve(root,'backend');for(const p of [front,back])await mkdir(p);
await writeFile(resolve(front,'FRONT_ONLY.txt'),'FRONT_CONTENT');await writeFile(resolve(back,'BACK_ONLY.txt'),'BACK_CONTENT');
const base='http://127.0.0.1:8803',env={...process.env,PIG_DESKTOP:'1',PORT:'8803',DATA_DIR:root,PIG_TEST_DATA_DIR:root,WORKSPACE_ROOT:front};
for(const key of Object.keys(env))if(/^(LLM_|DEEPSEEK_|OPENAI_|CODEX_|CLOUD_)/.test(key))delete env[key];
const server=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:resolve('apps/server'),env,stdio:['ignore','ignore','inherit']});
let browser;const errors=[];const checks=[];
try{
 for(let i=0;i<50;i++){try{if((await fetch(base+'/api/settings')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByRole('button',{name:'项目',exact:true}).click();
 await page.getByRole('button',{name:/项目目录/}).click();
 const catalog=page.getByRole('dialog',{name:'项目目录'});
 await catalog.getByPlaceholder('新项目名称').fill('多工作区验收');await catalog.getByPlaceholder('本地目录绝对路径').fill(front);await catalog.getByRole('button',{name:'新建项目',exact:true}).click();
 const region=page.getByRole('region',{name:'项目工作区'});await expect(region.getByText(front,{exact:true})).toBeVisible();
 await region.getByRole('button',{name:'添加工作区'}).click();await region.getByRole('textbox',{name:'名称',exact:true}).fill('服务端');await region.getByRole('textbox',{name:'本地目录',exact:true}).fill(back);await region.getByRole('button',{name:'保存工作区',exact:true}).click();
 await expect(region.getByText(back,{exact:true})).toBeVisible();await region.getByRole('radio',{name:/服务端/}).check();
 await page.screenshot({path:out+'/workspaces-desktop.png'});checks.push('Create project with first directory; add second workspace via UI');
 await page.getByRole('button',{name:'在此项目开任务',exact:true}).click();await expect(page).toHaveURL(/sessions\/ses_/);
 const sid=page.url().split('/').at(-1),s=await (await fetch(base+'/api/sessions/'+sid)).json();assert.equal(s.workspaceRoot,back);assert.equal(s.workspaceName,'服务端');
 await page.getByRole('button',{name:'文件与产物',exact:true}).click();await page.getByRole('button',{name:'本机工作区',exact:true}).click();await expect(page.getByText('BACK_ONLY.txt',{exact:true})).toBeVisible();await expect(page.getByText('FRONT_ONLY.txt',{exact:true})).toHaveCount(0);await page.getByText('BACK_ONLY.txt',{exact:true}).click();await expect(page.getByText('BACK_CONTENT',{exact:true})).toBeVisible();await page.screenshot({path:out+'/selected-workspace-files.png'});checks.push('Selected workspace persists into task and actual file tree/read');
 await page.getByRole('button',{name:'项目',exact:true}).click();
 const row=region.locator('article').filter({hasText:'服务端'});await row.getByRole('button',{name:'设为默认'}).click();await expect(row.getByText('默认',{exact:true})).toBeVisible();await page.reload();await expect(region.getByRole('radio',{name:/服务端/})).toBeChecked();
 await region.getByRole('button',{name:'添加工作区'}).click();await region.getByRole('textbox',{name:'本地目录',exact:true}).fill(back);await region.getByRole('button',{name:'保存工作区',exact:true}).click();await expect(region.getByRole('alert')).toBeVisible();await region.getByRole('button',{name:'取消',exact:true}).click();checks.push('Default survives reload; duplicate path shows validation error');
 await page.setViewportSize({width:390,height:844});await page.reload();await expect(region.getByRole('radio',{name:/服务端/})).toBeChecked();await page.screenshot({path:out+'/workspaces-mobile.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await row.getByRole('button',{name:'移除关联'}).click();await expect(region.getByText(back,{exact:true})).toHaveCount(0);await access(back);const old=await(await fetch(base+'/api/sessions/'+sid)).json();assert.equal(old.workspaceRoot,back);checks.push('Remove association preserves directory and existing task snapshot');
 assert.deepEqual(errors,[]);await writeFile(out+'/report.json',JSON.stringify({status:'PASS',checks,errors,environment:'isolated desktop API harness, actual filesystem and Chrome1440x900/390x844; no model calls'},null,2));console.log(checks.join('\n'));
}catch(e){await writeFile(out+'/failure.txt',String(e));throw e;}finally{await browser?.close();server.kill('SIGTERM');}
