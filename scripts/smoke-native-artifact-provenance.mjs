import {spawn} from 'node:child_process';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseEnv} from 'node:util';
const env=parseEnv(await readFile('data/cluster-local/stack.env','utf8'));
const data=await mkdtemp(resolve('data/native-artifact-'));
const workspace=resolve('data/redesign-local/workspace');await mkdir(workspace,{recursive:true});
const serverEnv={...process.env,PIG_DESKTOP:'1',PORT:'8803',DATA_DIR:data,PIG_TEST_DATA_DIR:data,WORKSPACE_ROOT:workspace};
for(const key of Object.keys(serverEnv))if(/^(LLM_|DEEPSEEK_|OPENAI_|CODEX_|CLOUD_)/.test(key))delete serverEnv[key];
const server=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:resolve('apps/server'),env:serverEnv,stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
const base='http://127.0.0.1:8803';
async function api(path,body,method=body?'POST':'GET'){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(`${path} ${r.status}: ${await r.text()}`);return r.headers.get('content-type')?.includes('event-stream')?r.text():r.json();}
try {
  let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/api/settings')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error(logs);
  await api('/api/settings',{runtime:'pig',llmApiKey:'',cloudMode:'remote',cloudBaseUrl:'http://127.0.0.1:8892',cloudToken:env.MEMBER_TOKEN,workspaceRoot:workspace},'PUT');
  const session=await api('/api/sessions',{});await api('/api/sessions/'+session.id,{executionTarget:'remote',engine:'pig',remoteRequireApproval:false},'PATCH');
  await api('/api/sessions/'+session.id+'/messages',{content:'F2 provenance fixture first run'});
  await api('/api/sessions/'+session.id+'/messages',{content:'F2 provenance fixture second run'});
  await new Promise((res,rej)=>{const test=spawn(process.execPath,['scripts/smoke-artifact-provenance.mjs'],{env:{...serverEnv,PIG_REVIEW_BASE:base,PIG_REVIEW_EVIDENCE:'data/native-artifact-evidence',PIG_REVIEW_SESSION_ID:session.id},stdio:'inherit'});test.once('error',rej);test.once('exit',code=>code===0?res():rej(Error('Provenance browser failed '+code)));});
}finally{server.kill('SIGTERM');}
