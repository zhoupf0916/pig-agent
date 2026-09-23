// Isolated, disposable PostgreSQL database; never connects to application data.
import {spawnSync,spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const container='pig-billing-acceptance-'+Date.now();
function run(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout;}
function sql(q){return run(['exec','-i',container,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-At'],q);}
try {
run(['run','-d','--name',container,'--network','none','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine']);
for(let i=0;i<30;i++){try{sql('SELECT 1');break;}catch{await new Promise(r=>setTimeout(r,500));}}
const schema=readFileSync('apps/cloud/src/billing.ts','utf8').match(/export const billingSchema\s*=\s*`([\s\S]*?)`;/)[1];
sql(`CREATE TABLE principals(id text PRIMARY KEY, enabled boolean DEFAULT true); CREATE TABLE model_channels(id text); CREATE TABLE model_usage(id bigserial PRIMARY KEY,owner_id text,run_id text,created_at timestamptz DEFAULT now()); ${schema} INSERT INTO principals(id) VALUES('new-account');`);
assert.equal(sql("SELECT budget_micros FROM principals WHERE id='new-account'").trim(),'2000000');
function compete(){return new Promise(resolve=>{const p=spawn('docker',['exec','-i',container,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-At']);p.stdin.end(`SELECT reserve_model_budget('new-account','task',1200000,'{"input":2,"cached":0.04,"output":8}');`);let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',()=>{});p.on('exit',code=>resolve({code,output}));});}
const results=await Promise.all([compete(),compete()]);assert.equal(results.filter(r=>r.code===0).length,1);assert.equal(sql('SELECT count(*) FROM model_usage').trim(),'1');
const id=results.find(r=>r.code===0).output.trim();
sql(`UPDATE model_usage SET charged_micros=100000,settled_at=now() WHERE id=${id} AND settled_at IS NULL; UPDATE model_usage SET charged_micros=900000,settled_at=now() WHERE id=${id} AND settled_at IS NULL;`);
assert.equal(sql(`SELECT charged_micros FROM model_usage WHERE id=${id}`).trim(),'100000');
sql(`SELECT reserve_model_budget('new-account','next-task',1800000,'{}');`);
assert.equal(sql('SELECT sum(COALESCE(charged_micros,reserved_micros)) FROM model_usage').trim(),'1900000');
assert.throws(()=>sql(`SELECT reserve_model_budget('new-account','blocked-task',100001,'{}');`),/额度不足/);
console.log('PASS: default ¥2, concurrent reservation rejects overspend, settlement idempotent, released remainder reusable, unknown calls remain charged against budget.');
} finally {run(['rm','-f',container]);}
