import {_electron,expect} from '@playwright/test';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const out=resolve('data/multiple-workspaces-evidence');await mkdir(out,{recursive:true});const userdata=await mkdtemp(resolve('data/workspace-electron-'));const front=resolve(userdata,'front'),back=resolve(userdata,'back');await mkdir(front);await mkdir(back);await writeFile(resolve(back,'NATIVE_ONLY.txt'),'native workspace');
const app=await _electron.launch({executablePath:createRequire(resolve('apps/desktop/package.json'))('electron'),args:[resolve('apps/desktop')],env:{...process.env,PIG_DESKTOP_USER_DATA:userdata}});const errors=[];
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForLoadState('domcontentloaded');
 await page.evaluate(()=>localStorage.setItem('pig-agent.desktop-setup','complete'));await page.reload();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));
 assert(await page.evaluate(()=>!!window.pigDesktop));
 // Deterministic OS picker response exercises the renderer → preload → main IPC boundary.
 await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},front);
 await page.getByRole('button',{name:'项目',exact:true}).click();await page.getByRole('button',{name:/项目目录/}).click();const catalog=page.getByRole('dialog',{name:'项目目录'});await catalog.getByPlaceholder('新项目名称').fill('桌面多工作区');await catalog.getByRole('button',{name:'选择本地文件夹',exact:true}).click();await expect(catalog.getByPlaceholder('本地目录绝对路径')).toHaveValue(front);await catalog.getByRole('button',{name:'新建项目',exact:true}).click();
 const region=page.getByRole('region',{name:'项目工作区'});await expect(region.getByText(front,{exact:true})).toBeVisible();await region.getByRole('button',{name:'添加工作区'}).click();await region.getByRole('textbox',{name:'名称',exact:true}).fill('服务代码');await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},back);await region.getByRole('button',{name:'选择文件夹',exact:true}).click();await expect(region.getByRole('textbox',{name:'本地目录',exact:true})).toHaveValue(back);await region.getByRole('button',{name:'保存工作区',exact:true}).click();await region.getByRole('radio',{name:/服务代码/}).check();await page.screenshot({path:out+'/electron-workspaces.png'});
 await page.getByRole('button',{name:'在此项目开任务',exact:true}).click();await expect(page).toHaveURL(/sessions\/ses_/);const id=page.url().split('/').at(-1);const session=await page.evaluate(async id=>(await fetch('/api/sessions/'+id)).json(),id);assert.equal(session.workspaceRoot,back);await page.getByRole('button',{name:'文件与产物',exact:true}).click();await page.getByRole('button',{name:'本机工作区',exact:true}).click();await expect(page.getByText('NATIVE_ONLY.txt',{exact:true})).toBeVisible();await page.screenshot({path:out+'/electron-workspace-task.png'});assert.deepEqual(errors,[]);
 await writeFile(out+'/electron-report.json',JSON.stringify({status:'PASS',checks:['Actual Electron isolated profile','Native directory picker IPC with deterministic dialog result','Two project workspace bindings','Selected task root and actual file tree'],errors},null,2));console.log('Electron workspace flow PASS');
}finally{await app.close();}
