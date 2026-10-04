import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

test('HTTP registration, discovery, job delivery and private results',async()=>{
 const dir=mkdtempSync(tmpdir()+'/exchange-api-');
 const child=spawn(process.execPath,['src/server.ts'],{env:{...process.env,PORT:'19043',DATA_DIR:dir,ADMIN_KEY:'test-admin-key-with-more-than-32-characters',OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 try {
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Startup timed out: '+stderr)),5000);child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});child.once('exit',()=>{clearTimeout(timeout);reject(Error('Server exited: '+stderr));});});
  const call=async(path:string,method='GET',body?:unknown,token?:string,key?:string)=>{const response=await fetch('http://127.0.0.1:19043'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const publicPage=await fetch('http://127.0.0.1:19043/');assert.equal(publicPage.status,200);assert.equal((await fetch('http://127.0.0.1:19043/',{method:'HEAD'})).status,200);assert.match(publicPage.headers.get('content-security-policy')||'',/frame-ancestors/);
  const a=await call('/api/agents/register','POST',{name:'buyer',referral:'kestrelfield'});assert.equal(a.status,201);assert.ok(a.data.api_key);
  const b=await call('/api/agents/register','POST',{name:'other'});
  assert.equal((await call('/api/me')).status,401);
  const admin='test-admin-key-with-more-than-32-characters';
  assert.equal((await call('/api/admin/overview')).status,401);
  assert.equal((await call('/api/admin/overview','GET',undefined,a.data.api_key)).status,401);
  const overview=await call('/api/admin/overview','GET',undefined,admin);assert.equal(overview.status,200);assert.equal(overview.data.referrals[0].referral,'kestrelfield');assert.equal(overview.data.referrals[0].registrations,1);assert.equal(overview.data.referrals[0].completed_jobs,0);assert.equal(overview.data.publications.length,0);assert.equal(overview.data.operator.enabled,0);assert.ok(!JSON.stringify(overview.data).includes('token_hash'));
  assert.equal((await call('/api/admin/drafts','POST',{service_id:'text-stats'},a.data.api_key)).status,401);
  const draft=await call('/api/admin/drafts','POST',{service_id:'text-stats'},admin);assert.equal(draft.status,201);assert.match(draft.data.body,/test credits/);
  assert.equal((await call('/api/admin/drafts/'+draft.data.id,'POST',{status:'SENT'},admin)).status,400);
  assert.equal((await call('/api/admin/drafts/'+draft.data.id,'POST',{status:'APPROVED'},admin)).status,200);
  assert.equal((await call('/api/admin/overview','GET',undefined,admin)).data.drafts[0].status,'APPROVED');
  assert.equal((await call('/api/admin/drafts/'+draft.data.id,'POST',{status:'ARCHIVED'},admin)).status,200);
  assert.equal((await call('/api/admin/operator','POST',{enabled:true,provider:'openai',model:'test',daily_limit:10},admin)).status,400);
  assert.equal((await call('/api/admin/agents/'+b.data.id,'POST',{disabled:true},admin)).status,200);
  assert.equal((await call('/api/me','GET',undefined,b.data.api_key)).status,401);
  assert.equal((await call('/api/admin/agents/'+b.data.id,'POST',{disabled:false},admin)).status,200);

  assert.equal((await call('/api/services')).data.services.length,3);
  assert.equal((await call('/api/jobs','POST',{service_id:'text-stats',input:{text:'hello world'}},a.data.api_key)).status,400);
  const payload={service_id:'text-stats',input:{text:'hello world'}};
  const job=await call('/api/jobs','POST',payload,a.data.api_key,'request-123');assert.equal(job.status,201);
  assert.equal((await call('/api/jobs','POST',payload,a.data.api_key,'request-123')).data.id,job.data.id);
  assert.equal((await call('/api/jobs','GET',undefined,b.data.api_key)).data.jobs.length,0);
  assert.equal((await call('/api/jobs/'+job.data.id+'/complete','POST',{result:{}},b.data.api_key)).status,403);
  let completed;for(let i=0;i<15;i++){completed=(await call('/api/jobs','GET',undefined,a.data.api_key)).data.jobs[0];if(completed.status==='COMPLETED')break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(completed.status,'COMPLETED');assert.equal(JSON.parse(completed.result).words,2);
  const balance=await call('/api/me','GET',undefined,a.data.api_key);assert.equal(balance.data.credits,99);assert.equal((await call('/api/admin/overview','GET',undefined,admin)).data.referrals[0].completed_jobs,1);assert.equal(balance.data.ledger.length,2);assert.equal(balance.data.ledger[0].kind,'reserved');
  assert.equal((await call('/api/jobs/'+job.data.id+'/cancel','POST',{},a.data.api_key)).status,400);
  assert.equal((await call('/api/services','POST',{name:'bad',description:'invalid price',price:-1},a.data.api_key)).status,400);
  assert.equal((await call('/api/agents/register','POST',{name:'<script>'})).status,400);
 } finally {child.kill('SIGTERM');await once(child,'exit');rmSync(dir,{recursive:true,force:true});}
});
