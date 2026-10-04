import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openStore} from '../src/store.ts';
import {createIntroduction,publishDraft,verifyPublication} from '../src/publishing.ts';
function setup(){const dir=mkdtempSync(tmpdir()+'/publish-'),store=openStore(dir+'/data'),path=dir+'/credentials.json';writeFileSync(path,JSON.stringify({name:'KestrelField',api_key:'private-test-key'}));const d=createIntroduction(store);store.db.prepare("UPDATE outreach_drafts SET status='APPROVED' WHERE id=?").run(d.id);return {store,path,id:String(d.id),close:()=>{store.db.close();rmSync(dir,{recursive:true,force:true});}};}
const response=(v:unknown)=>new Response(JSON.stringify(v));
test('publishing reserves once, persists challenge and verifies without exposing credentials',async()=>{
 const x=setup(),now=Date.now();try{let posts=0;const fake=async(url:any,init:any)=>{assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer private-test-key');if(url.endsWith('/agents/status'))return response({status:'claimed'});if(url.endsWith('/posts')){posts++;assert.match(JSON.parse(init.body).content,/ref=kestrelfield/);return response({success:true,verification_required:true,post:{id:'post-123',verification_status:'pending',verification:{verification_code:'private-code',challenge_text:'20 minus 5',expires_at:new Date(now+300000).toISOString()}}});}assert.equal(url,'https://www.moltbook.com/api/v1/verify');assert.deepEqual(JSON.parse(init.body),{verification_code:'private-code',answer:'15.00'});return response({success:true,content_id:'post-123'});};
 const result=await publishDraft(x.store,x.id,'Hello Moltbook','general',x.path,fake as typeof fetch,now);assert.equal(result.status,'PENDING_VERIFICATION');assert.ok(!JSON.stringify(result).includes('private-code'));
 await assert.rejects(publishDraft(x.store,x.id,'Hello Moltbook','general',x.path,fake as typeof fetch,now+7200000),/already/);assert.equal(posts,1);
 await assert.rejects(verifyPublication(x.store,x.id,'15',x.path,fake as typeof fetch,now),/two decimal/);
 assert.equal((await verifyPublication(x.store,x.id,'15.00',x.path,fake as typeof fetch,now)).status,'PUBLISHED');assert.equal(x.store.db.prepare('SELECT verification_code FROM moltbook_publications').get()?.verification_code,null);
 await assert.rejects(verifyPublication(x.store,x.id,'15.00',x.path,fake as typeof fetch,now),/No pending/);
 assert.equal(createIntroduction(x.store).id,x.id);assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM outreach_drafts').get()?.n,1);
 }finally{x.close();}
});
test('unknown delivery, duplicate content and concurrent sends cannot repost',async()=>{
 const x=setup();try{let posts=0;const fake=async(url:any)=>{if(url.endsWith('/agents/status'))return response({status:'claimed'});posts++;throw Error('private provider message');};
 const results=await Promise.allSettled([publishDraft(x.store,x.id,'Hello there','general',x.path,fake as typeof fetch),publishDraft(x.store,x.id,'Hello there','general',x.path,fake as typeof fetch)]);assert.equal(posts,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(x.store.db.prepare('SELECT status,error_code FROM moltbook_publications').get()?.status,'UNCERTAIN');
 x.store.db.prepare("INSERT INTO outreach_drafts(id,service_id,body,status) SELECT 'duplicate',service_id,body,'APPROVED' FROM outreach_drafts WHERE id=?").run(x.id);await assert.rejects(publishDraft(x.store,'duplicate','Different title','general',x.path,fake as typeof fetch,Date.now()+7200001),/already/);assert.equal(posts,1);
 }finally{x.close();}
});
test('approval, claim, interval and rolling daily limits gate publishing',async()=>{
 const x=setup(),now=Date.now();try{const pending=async()=>response({status:'pending_claim'});await assert.rejects(publishDraft(x.store,x.id,'Hello there','general',x.path,pending as typeof fetch,now),/claimed/);assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM moltbook_publications').get()?.n,0);
 x.store.db.prepare("UPDATE outreach_drafts SET status='DRAFT' WHERE id=?").run(x.id);await assert.rejects(publishDraft(x.store,x.id,'Hello there','general',x.path,pending as typeof fetch,now),/approved/);x.store.db.prepare("UPDATE outreach_drafts SET status='APPROVED' WHERE id=?").run(x.id);
 const fake=async(url:any)=>url.endsWith('/agents/status')?response({status:'claimed'}):response({success:true,post:{id:'post-1'}});assert.equal((await publishDraft(x.store,x.id,'Hello there','general',x.path,fake as typeof fetch,now)).status,'PUBLISHED');
 for(let i=1;i<=3;i++){x.store.db.prepare("INSERT INTO outreach_drafts(id,service_id,body,status) VALUES(?,'text-stats',?,'APPROVED')").run('new'+i,'Distinct content '+i);if(i===1)await assert.rejects(publishDraft(x.store,'new1','Hello there','general',x.path,fake as typeof fetch,now+1),/two hours/);if(i<3)assert.equal((await publishDraft(x.store,'new'+i,'Hello there','general',x.path,fake as typeof fetch,now+i*7200000)).status,'PUBLISHED');else await assert.rejects(publishDraft(x.store,'new3','Hello there','general',x.path,fake as typeof fetch,now+i*7200000),/Daily/);}
 }finally{x.close();}
});
test('expired or rejected verification never reports publication',async()=>{
 const x=setup(),now=Date.now();try{const fake=async(url:any)=>url.endsWith('/agents/status')?response({status:'claimed'}):url.endsWith('/posts')?response({post:{id:'post-2',verification_status:'pending',verification:{verification_code:'code',challenge_text:'2 + 3',expires_at:new Date(now+1000).toISOString()}}}):response({success:false});await publishDraft(x.store,x.id,'Hello there','general',x.path,fake as typeof fetch,now);
 await assert.rejects(verifyPublication(x.store,x.id,'5.00',x.path,fake as typeof fetch,now+1001),/expired/);assert.equal((await verifyPublication(x.store,x.id,'4.00',x.path,fake as typeof fetch,now)).status,'VERIFICATION_FAILED');
 }finally{x.close();}
});
