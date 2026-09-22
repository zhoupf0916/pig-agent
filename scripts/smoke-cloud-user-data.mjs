import{randomBytes,randomUUID,createHash}from'node:crypto';import{spawn}from'node:child_process';import{mkdir,writeFile}from'node:fs/promises';import assert from'node:assert/strict';
const base='http://127.0.0.1:8892',tag=randomUUID().replaceAll('-','').slice(0,12),a='userdata_a_'+tag,b='userdata_b_'+tag,ta=randomBytes(32).toString('hex'),tb=randomBytes(32).toString('hex'),secret='private preference '+tag;let personal,team,space,schedule;const runs=[],checks=[];
const sql=query=>new Promise((resolve,reject)=>{let out='',err='';const child=spawn('docker',['exec','-i','pig-agent-cluster-postgres-1','sh','-c','psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],{stdio:['pipe','pipe','pipe']});child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('exit',code=>code?reject(Error(err)):resolve(out.trim()));child.stdin.end(query);});
async function api(path,method='GET',body,token=ta,key){const response=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
const runInput=async id=>JSON.parse(await sql(`SELECT input FROM runs WHERE id='${id}';`));
try{
 await sql(`INSERT INTO principals(id,name,role,token_hash) VALUES('${a}','User data A','member','${createHash('sha256').update(ta).digest('hex')}'),('${b}','User data B','member','${createHash('sha256').update(tb).digest('hex')}');`);
 assert.equal((await api('/v1/settings')).data.requireApproval,true);assert.equal((await api('/v1/settings')).data.configured,false);
 assert.equal((await api('/v1/settings','PUT',{networkPolicy:'blocked',requireApproval:true,memoryEnabled:true})).status,200);assert.equal((await api('/v1/settings')).data.networkPolicy,'blocked');assert.equal((await api('/v1/settings','GET',undefined,tb)).data.configured,false);assert.equal((await api('/v1/settings','PUT',{sandbox:'host'})).status,400);checks.push('PG settings persist per owner; unsafe local sandbox update rejected');
 const memory=await api('/v1/memory','POST',{content:secret});assert.equal(memory.status,201);assert.equal((await api('/v1/memory','GET',undefined,tb)).data.memories.length,0);assert.equal((await api('/v1/memory/'+memory.data.id,'DELETE',undefined,tb)).status,404);checks.push('Memory list/delete strictly owner scoped');
 personal=(await api('/v1/projects','POST',{name:'Private data proof '+tag})).data.id;
 space=(await api('/v1/spaces','POST',{name:'Shared data proof '+tag})).data.id;
 team=(await api('/v1/shared-projects','POST',{spaceId:space,name:'Team data proof '+tag})).data.id;
 const created=await api('/v1/runs','POST',{prompt:'Owner private searchable '+tag,projectId:personal,useUserDefaults:true},ta,'userdata-'+tag);assert.equal(created.status,201);runs.push(created.data.id);const first=await runInput(created.data.id);assert.equal(first.networkPolicy,'blocked');assert.equal(first.requireApproval,true);assert(first.privateMemoryContext.includes(secret));
 const shared=await api('/v1/runs','POST',{prompt:'Shared memory exclusion '+tag,projectId:team,useUserDefaults:true});assert.equal(shared.status,201);runs.push(shared.data.id);assert.equal((await runInput(shared.data.id)).privateMemoryContext,'');checks.push('New personal task snapshots settings/private memory; collaborative task excludes private memory');
 schedule=(await api('/v1/schedules','POST',{name:'User defaults '+tag,prompt:'Schedule defaults',enabled:false},ta,'schedule-'+tag)).data.id;assert(schedule);const scheduled=JSON.parse(await sql(`SELECT input FROM schedules WHERE id='${schedule}';`));assert.equal(scheduled.requireApproval,true);assert.equal(scheduled.networkPolicy,'blocked');checks.push('New schedule snapshots owner execution defaults');
 await api('/v1/settings','PUT',{requireApproval:false,memoryEnabled:false});assert.equal((await runInput(created.data.id)).requireApproval,true);
 const repeated=await api('/v1/runs','POST',{prompt:'Owner private searchable '+tag,projectId:personal,useUserDefaults:true},ta,'userdata-'+tag);assert.equal(repeated.status,200);assert.equal(repeated.data.id,created.data.id);
 const next=await api('/v1/runs','POST',{prompt:'Updated owner defaults '+tag,projectId:personal,useUserDefaults:true});assert.equal(next.status,201);runs.push(next.data.id);assert.equal((await runInput(next.data.id)).requireApproval,false);assert.equal((await runInput(next.data.id)).privateMemoryContext,'');checks.push('Settings affect new task only; disabled memory excluded; original idempotent retry remains stable');
 const searchA=await api('/v1/search?q='+tag);assert(searchA.data.results.some(r=>r.snippet.includes('Owner private searchable')));const searchB=await api('/v1/search?q='+tag,'GET',undefined,tb);assert.equal(searchB.data.results.length,0);checks.push('Search finds own conversation/input and excludes inaccessible owner content');
 assert.equal((await api('/v1/runs/'+created.data.id+'/follow-ups','POST',{prompt:'Unauthorized private follow-up'},tb,'denied-'+tag)).status,404);
 const invitation=(await api('/v1/spaces/'+space+'/invitations','POST',{role:'editor'})).data.invite;assert.equal((await api('/v1/spaces/join','POST',{invite:invitation},tb)).status,200);
 await api('/v1/memory','POST',{content:'Other owner private '+tag},tb);
 let approvalsApplied=0;
 for(let i=0;i<90;i++){
   const pending=(await api('/v1/runs/'+shared.data.id+'/approvals')).data.approvals||[];
   for(const approval of pending.filter(a=>a.state==='pending')){await api('/v1/runs/'+shared.data.id+'/approvals/'+approval.id+'/decision','POST',{decision:'approve'});approvalsApplied++;}
   const state=(await api('/v1/runs/'+shared.data.id)).data.state;if(state==='succeeded')break;if(i===89)throw Error('Shared fixture did not finish');await new Promise(r=>setTimeout(r,500));
 }
 assert(approvalsApplied>0,'Saved approval requirement must produce real pending approval');
 for(let i=0;i<60;i++){const state=(await api('/v1/runs/'+next.data.id)).data.state;if(state==='succeeded')break;if(i===59)throw Error('Approval-disabled task did not complete');await new Promise(r=>setTimeout(r,500));}
 assert.equal((await api('/v1/runs/'+next.data.id+'/approvals')).data.approvals.length,0);checks.push('Saved approval-on task actually waits for decision; approval-off task completes without approval');
 const follow=await api('/v1/runs/'+shared.data.id+'/follow-ups','POST',{prompt:'Other member follows shared task'},tb,'follow-'+tag);assert.equal(follow.status,201);runs.push(follow.data.id);assert.equal((await runInput(follow.data.id)).privateMemoryContext,'');checks.push('Private follow-up denied to other member; collaborative follow-up never inherits either owner private memory');
 await api('/v1/memory/'+memory.data.id,'DELETE');assert.equal((await api('/v1/memory')).data.memories.length,0);
 await mkdir('data/user-data-evidence',{recursive:true});await writeFile('data/user-data-evidence/api.json',JSON.stringify({at:new Date().toISOString(),base,checks},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{
 for(const id of runs){await api('/v1/runs/'+id+'/abort','POST',{}).catch(()=>{});await api('/v1/runs/'+id+'/abort','POST',{},tb).catch(()=>{});}
 for(let i=0;i<30;i++){const statuses=await Promise.all(runs.map(id=>api('/v1/runs/'+id)));if(statuses.every(r=>['succeeded','failed','cancelled'].includes(r.data.state)))break;await new Promise(r=>setTimeout(r,500));}
 // Keep cancelled test runs as traceable verification records; fixture accounts stay disabled.
 await sql(`UPDATE principals SET enabled=false WHERE id IN ('${a}','${b}'); DELETE FROM auth_sessions WHERE owner_id IN ('${a}','${b}'); DELETE FROM user_memories WHERE owner_id IN ('${a}','${b}'); DELETE FROM user_settings WHERE owner_id IN ('${a}','${b}'); UPDATE schedules SET enabled=false,deleted_at=now() WHERE owner_id IN ('${a}','${b}');`);
}
