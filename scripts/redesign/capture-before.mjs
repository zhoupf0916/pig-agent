import {chromium,expect} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
const base='http://127.0.0.1:8799',out='data/redesign-evidence/before';
const secrets=parseEnv(await readFile('data/cluster-local/stack.env','utf8'));
const api=async(path,data,method=data?'POST':'GET')=>{let r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:base},...(data?{body:JSON.stringify(data)}:{})});if(!r.ok)throw Error(`${path} ${r.status} ${await r.text()}`);return r.json()};
await api('/api/settings',{runtime:'pig',llmApiKey:'',cloudMode:'remote',cloudBaseUrl:'http://127.0.0.1:8892',cloudToken:secrets.MEMBER_TOKEN,workspaceRoot:resolve('data/redesign-local/workspace')},'PUT');
const fixtures=[];
for(let i=0;i<15;i++){
 const s=await api('/api/sessions',{});const path=resolve('data/redesign-local/store/sessions',s.id+'.json');const f=JSON.parse(await readFile(path,'utf8'));
 f.title=`[UI夹具] ${i+1} 号任务：核对季度报表中的跨部门数据差异并生成可追溯的执行报告与变更记录`;
 f.messages=i===0?[]:[{id:'msg_fixture_user',role:'user',content:'[UI夹具] 请分析现有数据，列出风险并生成报告。',createdAt:new Date().toISOString()},{id:'msg_fixture_assistant',role:'assistant',content:'[UI夹具，非真实执行结果]\n\n## 数据分析过程\n\n'+('这是用于排版验收的长 Markdown 内容。我们需要清楚区分执行过程、审批要求和最终成果。\n\n').repeat(12)+'```typescript\nconst result = await analyze({ scope: "quarterly", includeHistory: true });\nconsole.log(result);\n```\n\n|项目|状态|\n|---|---|\n|数据对齐|已完成|\n|报告核验|待处理|',createdAt:new Date().toISOString()}];
 await writeFile(path,JSON.stringify(f));fixtures.push(s.id);
}
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
const captures=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
async function matrix(state,kind='real'){
 for(const theme of ['light','dark'])for(const [width,height]of[[1440,900],[1280,800],[390,844]]){
 await page.setViewportSize({width,height});await page.evaluate(t=>{localStorage.setItem('pig-agent.theme',t);document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;window.dispatchEvent(new StorageEvent('storage',{key:'pig-agent.theme',newValue:t}));},theme);await page.waitForTimeout(180);
 const file=`${state}-${width}x${height}-${theme}.png`;await page.screenshot({path:out+'/'+file});captures.push({state,kind,file,width,height,theme,url:page.url(),metrics:await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,headerHeight:document.querySelector('header')?.getBoundingClientRect().height,textareaY:document.querySelector('textarea')?.getBoundingClientRect().y}))});
 }
 await page.setViewportSize({width:1440,height:900});
}
try{
 await page.goto(base+'/#/sessions/'+fixtures[0]);await page.getByRole('button',{name:'设置',exact:true}).waitFor();await matrix('empty','UI fixture task list, real empty session');
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('dialog',{name:'设置'}).waitFor();await matrix('settings');await page.keyboard.press('Escape');
 await page.goto(base+'/#/sessions/'+fixtures[1]);await page.getByText('[UI夹具，非真实执行结果]',{exact:false}).waitFor();await matrix('long-content','UI fixture');
 const r=page.waitForResponse(r=>r.url().endsWith('/api/sessions')&&r.request().method()==='POST');await page.getByRole('button',{name:'新任务',exact:true}).click();const session=await(await r).json();await page.waitForURL('**/sessions/'+session.id);await page.reload();await page.getByLabel('执行位置').selectOption('remote');await page.waitForTimeout(500);if(!await page.getByLabel('写入前审批').isChecked())await page.getByLabel('写入前审批').click();await page.getByPlaceholder(/描述目标/).fill('重设计真实验收：创建并读回 cloud-proof.txt，核验容器成果。');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('button',{name:'停止',exact:true}).waitFor();await matrix('executing','real mock container; may reach approval during viewport sweep');
 await expect(page.getByText(/等待审批，尚未执行/).first()).toBeVisible({timeout:45000});await page.getByRole('button',{name:'远端运行',exact:true}).click();const dialog=page.getByRole('dialog',{name:'远端运行记录'});await expect(dialog.getByRole('button',{name:'批准此操作'})).toBeVisible({timeout:15000});await matrix('approval');await dialog.getByRole('button',{name:'批准此操作'}).click();const file=dialog.getByRole('link',{name:'cloud-proof.txt',exact:true});await expect(file).toBeVisible({timeout:45000});const downloadPromise=page.waitForEvent('download');await file.click();const download=await downloadPromise;const content=await readFile(await download.path(),'utf8');if(content.trim()!=='PIG_CLOUD_CONTAINER_OK')throw Error('artifact mismatch');await matrix('result');
 await page.route('**/api/remote/v1/**',r=>r.abort('failed'));await expect(dialog.getByText(/暂时无法同步控制面/)).toBeVisible({timeout:15000});await matrix('error','real browser network fault injection');await page.unroute('**/api/remote/v1/**');await expect(dialog.getByText(/暂时无法同步控制面/)).toHaveCount(0,{timeout:15000});await matrix('recovery');await page.keyboard.press('Escape');
 await page.goto('http://127.0.0.1:8892/admin/');await page.getByLabel('管理员令牌').fill(secrets.ADMIN_TOKEN);await page.getByRole('button',{name:'连接平台',exact:true}).click();await page.locator('#dashboard').waitFor({state:'visible'});await page.getByRole('link',{name:'Runner 集群',exact:true}).click();await matrix('admin-runners','real cluster; baseline admin has no dark support');
 await writeFile(out+'/manifest.json',JSON.stringify({at:new Date().toISOString(),base,fixtureIds:fixtures,realSessionId:session.id,realArtifact:content.trim(),errors,captures},null,2));console.log(JSON.stringify({screenshots:captures.length,realSessionId:session.id,errors}));
}finally{await browser.close()}
