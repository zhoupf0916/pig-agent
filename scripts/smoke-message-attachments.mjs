import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:8892',out='docs/evidence/message-attachments-2026-09-22';await mkdir(out,{recursive:true});
const {accounts}=JSON.parse(await readFile('data/project-ui-evidence/accounts.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true}),ctx=await browser.newContext({viewport:{width:1440,height:900}}),page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(base);await page.getByLabel('用户名',{exact:true}).fill(accounts[0].username);await page.getByLabel('密码',{exact:true}).fill(accounts[0].password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.global-links')).toBeVisible();await page.getByRole('button',{name:'新对话',exact:true}).first().click();
 const prompt='请读取附件 input-note.txt，并创建 cloud-proof.txt 验证消息附件。';
 await page.getByLabel('任务消息').fill(prompt);
 await page.locator('.message-attachments input[type=file]').setInputFiles({name:'input-note.txt',mimeType:'text/plain',buffer:Buffer.from('Attachment acceptance proof: 7319')});
 await expect(page.locator('.attachment-chip.ready')).toHaveCount(1);await page.screenshot({path:out+'/attachment-ready-desktop.png'});
 await page.reload();await expect(page.getByLabel('任务消息')).toHaveValue(prompt);await expect(page.locator('.attachment-chip.ready')).toHaveCount(1);
 await page.locator('.message-attachments input[type=file]').setInputFiles({name:'unsupported.exe',mimeType:'application/octet-stream',buffer:Buffer.from([0,1,2,3])});
 await expect(page.locator('.attachment-chip.error')).toHaveCount(1);await expect(page.getByRole('button',{name:'发送消息'})).toBeDisabled();await page.screenshot({path:out+'/attachment-error-desktop.png'});await page.getByRole('button',{name:'移除 unsupported.exe'}).click();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/attachment-ready-mobile.png'});await page.setViewportSize({width:1440,height:900});
 const created=page.waitForResponse(r=>new URL(r.url()).pathname==='/v1/runs'&&r.request().method()==='POST');await page.getByRole('button',{name:'发送消息'}).click();const response=await created;assert.equal(response.status(),201);const data=await response.json();assert.equal(response.request().postDataJSON().attachmentIds.length,1);
 await expect(page.getByRole('button',{name:'批准操作',exact:true})).toBeVisible({timeout:60000});await page.screenshot({path:out+'/attachment-approval-desktop.png'});await page.getByRole('button',{name:'批准操作',exact:true}).click();await expect(page.locator('.cw-state')).toHaveText('已完成',{timeout:60000});
 await expect(page.locator('.message-input-file').filter({hasText:'input-note.txt'}).first()).toBeVisible();await page.reload();await expect(page.locator('.message-input-file').filter({hasText:'input-note.txt'}).first()).toBeVisible();
 const link=page.locator('.message-input-file').filter({hasText:'input-note.txt'}).first();const download=await ctx.request.get(new URL(await link.getAttribute('href'),base).href);assert.equal(await download.text(),'Attachment acceptance proof: 7319');await page.screenshot({path:out+'/attachment-result-desktop.png'});
 await writeFile(out+'/report.json',JSON.stringify({status:'PASS',runId:data.id,checks:['upload ready','draft and attachment refresh recovery','unsupported file blocks send','remove failed attachment','mobile composer','run association','real Runner completes after approval','authenticated original download after reload'],errors},null,2));assert.deepEqual(errors,[]);
}finally{await browser.close()}
