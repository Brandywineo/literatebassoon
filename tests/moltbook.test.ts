import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openStore} from '../src/store.ts';
import {registerMoltbook,syncMoltbook} from '../src/moltbook.ts';
test('registration privately saves credentials and reuses identity without another POST',async()=>{
 const dir=mkdtempSync(tmpdir()+'/moltbook-'),path=dir+'/credentials.json';try{
 let calls=0;const fake=async(url:any,init:any)=>{calls++;assert.equal(url,'https://www.moltbook.com/api/v1/agents/register');assert.equal(init.redirect,'error');assert.equal(JSON.parse(init.body).name,'KestrelField');return new Response(JSON.stringify({agent:{api_key:'private-test-key',claim_url:'https://www.moltbook.com/claim/test',verification_code:'test-code'}}));};
 const registered=await registerMoltbook('KestrelField',path,fake as typeof fetch);assert.equal(registered.reused,false);assert.ok(!JSON.stringify(registered).includes('private-test-key'));assert.equal(statSync(path).mode&0o777,0o600);assert.equal(JSON.parse(readFileSync(path,'utf8')).api_key,'private-test-key');
 assert.equal((await registerMoltbook('Other',path,fake as typeof fetch)).name,'KestrelField');assert.equal(calls,1);
 const store=openStore(dir+'/data');try{const status=async(url:any,init:any)=>{assert.equal(url,'https://www.moltbook.com/api/v1/agents/status');assert.equal(init.headers.Authorization,'Bearer private-test-key');return new Response(JSON.stringify({status:'pending_claim'}));};assert.equal(await syncMoltbook(store,path,status as typeof fetch,10000000),true);assert.equal(await syncMoltbook(store,path,status as typeof fetch,10000001),false);const state=store.db.prepare('SELECT * FROM moltbook_state').get();assert.equal(state?.status,'pending_claim');assert.ok(!JSON.stringify(state).includes('private-test-key'));
 const failed=async()=>new Response('secret provider message',{status:429});await syncMoltbook(store,path,failed as typeof fetch,12000000);assert.equal(store.db.prepare('SELECT error_code FROM moltbook_state').get()?.error_code,'moltbook_http_429');}finally{store.db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('registration rejects off-domain claim links',async()=>{
 const dir=mkdtempSync(tmpdir()+'/moltbook-link-');try{const fake=async()=>new Response(JSON.stringify({agent:{api_key:'test-key',claim_url:'https://evil.example/claim/test'}}));const result=await registerMoltbook('KestrelField',dir+'/credentials.json',fake as typeof fetch);assert.equal(result.claim_url,null);}finally{rmSync(dir,{recursive:true,force:true});}
});
