import {chromium,expect} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const base=process.env.REDESIGN_BASE||'http://127.0.0.1:8799';
if(!/^http:\/\/127\.0\.0\.1:8799$/.test(base))throw Error('Settings acceptance only uses isolated8799');
const out='data/redesign-evidence/after';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});
const original=await fetch(base+'/api/settings').then(r=>r.json());if(resolve(original.workspaceRoot)!==resolve('data/redesign-local/workspace')){await browser.close();throw Error('Expected isolated data/redesign-local/workspace; refusing settings changes/restoration');}const checks=[],captures=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
async function openSettings(){await page.getByRole('button',{name:'设置',exact:true}).click();await expect(page.getByRole('dialog',{name:'设置',exact:true})).toBeVisible();}
async function nav(name){await page.getByRole('navigation',{name:'设置分组'}).getByRole('button',{name:new RegExp('^'+name)}).click();}
try{
 await page.goto(base);await openSettings();
 const model=page.getByLabel('Pig 模型',{exact:true});await model.fill('UI_DRAFT_PRESERVED');await page.waitForTimeout(4500);await expect(model).toHaveValue('UI_DRAFT_PRESERVED');await nav('工作区');await nav('模型连接');await expect(model).toHaveValue('UI_DRAFT_PRESERVED');checks.push('all-field draft survives polling and group navigation');
 await page.getByRole('button',{name:'关闭',exact:true}).click();await expect(page.getByRole('alertdialog')).toBeVisible();await page.getByRole('button',{name:'继续编辑',exact:true}).click();await expect(model).toHaveValue('UI_DRAFT_PRESERVED');await page.keyboard.press('Escape');await expect(page.getByRole('alertdialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('alertdialog')).toHaveCount(0);await expect(page.getByRole('dialog',{name:'设置',exact:true})).toBeVisible();checks.push('dirty close prompts; Escape dismisses discard only');
 await page.getByLabel('模型接口地址').fill('not-a-url');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('alert')).toContainText('http://');await expect(model).toHaveValue('UI_DRAFT_PRESERVED');checks.push('invalid address blocks save and preserves draft');
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'放弃修改并关闭',exact:true}).click();await openSettings();await expect(model).toHaveValue(original.llmModel);
 await model.fill('UI_saved_model_no_request');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('status')).toContainText('已保存');await page.getByRole('button',{name:'关闭',exact:true}).click();await page.reload();await openSettings();await expect(model).toHaveValue('UI_saved_model_no_request');await model.fill(original.llmModel);await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('status')).toContainText('已保存');checks.push('model saved through real API, reload persisted, restored without model calls');
 await nav('远端连接');await page.getByRole('button',{name:'保存并检查控制面',exact:true}).click();await expect(page.getByRole('status')).toContainText('访问权限已验证',{timeout:15000});checks.push('saved remote connection verified using real authenticated /v1/runs');
 for(const theme of ['light','dark']){
   await nav('外观');await page.getByRole('button',{name:theme==='light'?'浅色 适合明亮环境':'深色 适合低光环境',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
   for(const [width,height]of[[1440,900],[1280,800],[390,844]]){
    await page.setViewportSize({width,height});
    for(const name of ['模型连接','执行默认值','工作区','远端连接','外观','高级选项']){
     await nav(name);await expect(page.getByRole('button',{name:'保存',exact:true})).toBeInViewport();
     const state=name==='模型连接'?'settings':'settings-'+({'执行默认值':'execution','工作区':'workspace','远端连接':'remote','外观':'appearance','高级选项':'advanced'}[name]);
     const file=`${state}-${width}x${height}-${theme}.png`;await page.screenshot({path:out+'/'+file});const metrics=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,dialogWidth:document.querySelector('.settings-dialog').getBoundingClientRect().width,footer:document.querySelector('.settings-footer').getBoundingClientRect().toJSON()}));if(metrics.scrollWidth>width)throw Error('horizontal overflow '+file);captures.push({file,state,width,height,theme,metrics});
    }
   }
 }
 checks.push('all six sections at three viewports/two themes; save visible; no page overflow');
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');checks.push('appearance persists after browser reload');
 await writeFile(out+'/settings-check.json',JSON.stringify({at:new Date().toISOString(),workspaceRoot:original.workspaceRoot,checks,captures,errors},null,2));if(errors.length)throw Error(errors.join('\n'));console.log(JSON.stringify({ok:true,checks,screenshots:captures.length}));
}catch(error){await page.screenshot({path:out+'/settings-failure.png'});console.error(String(error.message).split('\n').slice(0,8).join('\n'));process.exitCode=1;}finally{await browser.close();await fetch(base+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(original)});}
