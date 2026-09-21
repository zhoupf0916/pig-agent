import {mkdir,readdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const source=resolve('data/redesign-evidence');const destination=resolve('docs/evidence/redesign-2026-09-22');
const selected=[];
async function copy(from,to){await mkdir(join(destination,to,'..'),{recursive:true});await copyFile(from,join(destination,to));selected.push(to);}
for(const folder of ['before','after','admin']){
 for(const file of await readdir(join(source,folder))){
  const image=/\.png$/.test(file)&&!/(failure|first-render)/.test(file)&&!(folder==='after'&&file.startsWith('admin-'));
  const json=folder==='before'?['manifest.json','pages.json','README.md'].includes(file):folder==='after'?['workbench-matrix.json','settings-check.json','pages-flow.json','session-context.json'].includes(file):file==='evidence.json';
  if(image||json)await copy(join(source,folder,file),folder+'/'+file);
 }
}
for(const file of ['artifact-source.json','artifact-source-desktop.png','artifact-source-mobile.png','real-flow/flow.json'])await copy(join(source,file),file);
for(const file of ['completion-fencing.json','finish-fault.json'])await copy(resolve('data/acceptance-redesign',file),'reliability/'+file);
await copy(resolve('data/acceptance-redesign/cluster-dns.json'),'cluster/dns.json');
for(const file of ['control.json','runners.json'])await copy(resolve('data/cluster-local/evidence',file),'cluster/'+file);
for(const file of ['flow.json','artifact-source.json','admin-ui.json','flow-approval.png','flow-result.png','flow-conversation.png','artifact-source-desktop.png','artifact-source-mobile.png','settings-mobile.png','admin-overview.png','admin-runners.png','admin-settings.png','admin-accounts.png','admin-audit.png','admin-run-detail.png','admin-mobile.png'])await copy(resolve('data/product-evidence',file),'final-product/'+file);
const result=spawnSync(process.execPath,['scripts/redesign/evidence-index.mjs'],{env:{...process.env,REDESIGN_EVIDENCE_DIR:destination},stdio:'inherit'});if(result.status!==0)throw Error('Evidence index failed');
selected.push('index.html','paired-index.json');
for(const file of ['README.md','validation.json'])try{await readFile(join(destination,file));selected.push(file);}catch{}
const files=[];
for(const file of selected.sort()){const bytes=await readFile(join(destination,file));if(file.endsWith('.json')&&/sk-[a-zA-Z0-9]{16,}|Bearer\s+[a-zA-Z0-9_-]{20,}|"(?:apiKey|api_key|cloudToken|workerToken|leaseToken)"\s*:\s*"[^"\s]+"/.test(bytes.toString()))throw Error('Sensitive-looking value in '+file);files.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
await writeFile(join(destination,'archive-manifest.json'),JSON.stringify({at:new Date().toISOString(),origin:'Isolated local browser and Docker evidence; UTC timestamps, Asia/Shanghai review date',files},null,2));console.log(JSON.stringify({destination,files:files.length,totalBytes:files.reduce((n,f)=>n+f.bytes,0)}));
