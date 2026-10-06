import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openStore} from '../src/store.ts';
import {observeComment,scanFollowups} from '../src/social-threads.ts';
import {setAutonomy,runSocialCycle} from '../src/social-autonomy.ts';
const body='Queue retries need durable request identifiers and reliable result records.';
const own='Use durable request identifiers and result records for queue retries.';
function fixture(){const dir=mkdtempSync(tmpdir()+'/reconcile-'),store=openStore(dir+'/data'),path=dir+'/identity',now=Date.now();writeFileSync(path,JSON.stringify({name:'KestrelField',api_key:'secret'}));store.setOperator(true,'ollama','test',50);setAutonomy(store,true);store.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at,full_content,source_created_at) VALUES('post','Queue retries',?,'Other','general',?,1,?)").run(body,now,new Date(now-1000).toISOString());store.db.prepare("INSERT INTO social_replies(id,post_id,body,status,attempted_at,comment_id,error_code) VALUES('root','post',?,'VERIFICATION_FAILED',?,'comment','moltbook_http_400')").run(own,now-7200000);return {store,path,now,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}
const comment=()=>({id:'comment',content:own,parent_id:null,author:{name:'kestrelfield'},verification_status:'failed'});
test('public visibility is independent from failed and expired verification; exact identity is required',()=>{const x=fixture();try{
 const row=x.store.db.prepare('SELECT * FROM social_replies').get()!;
 assert.equal(observeComment(x.store,row,[comment()],'KestrelField',x.now),true);
 assert.equal(x.store.db.prepare('SELECT status FROM social_replies').get()?.status,'VERIFICATION_FAILED');
 assert.equal(x.store.db.prepare('SELECT visibility,verification_status FROM social_visibility').get()?.visibility,'VISIBLE');
 for(const changed of [{...comment(),author:{name:'Impostor'}},{...comment(),content:'changed'},{...comment(),parent_id:'wrong'}]){assert.equal(observeComment(x.store,row,[changed],'KestrelField',x.now+1),false);assert.equal(x.store.db.prepare('SELECT visibility FROM social_visibility').get()?.visibility,'MISMATCH');}
 assert.equal(observeComment(x.store,row,[{...comment(),is_spam:true}],'KestrelField',x.now+2),false);assert.equal(x.store.db.prepare('SELECT visibility FROM social_visibility').get()?.visibility,'VISIBLE_RESTRICTED');
 observeComment(x.store,row,[],'KestrelField',x.now+3);assert.equal(x.store.db.prepare('SELECT visibility FROM social_visibility').get()?.visibility,'NOT_OBSERVED');
 x.store.db.prepare("UPDATE social_replies SET status='VERIFICATION_EXPIRED'").run();assert.equal(observeComment(x.store,row,[comment()],'KestrelField',x.now+4),true);assert.equal(x.store.db.prepare('SELECT status FROM social_replies').get()?.status,'VERIFICATION_EXPIRED');
 }finally{x.close();}});
test('anonymous reconciliation discovers follow-ups on visible failed comments without reposting them',async()=>{const x=fixture();try{
 const incoming={id:'incoming',parent_id:'comment',content:'How do durable request identifiers survive queue retries when the result is missing?',author:{name:'Other'},created_at:new Date(x.now-100).toISOString()};let writes=0;
 const fake=async(url:any,init:any)=>{if(String(url).includes('/comments?')){assert.equal(init.headers.Authorization,undefined);return new Response(JSON.stringify({comments:[{...comment(),replies:[incoming]}]}));}if(String(url).endsWith('/agents/status'))return new Response(JSON.stringify({status:'claimed'}));if(String(url).endsWith('/comments')){writes++;assert.equal(JSON.parse(init.body).parent_id,'incoming');return new Response(JSON.stringify({comment:{id:'followup'}}));}return new Response(JSON.stringify({post:{id:'post',title:'Queue retries',content:body,author:{name:'Other'}}}));};
 const generated='Durable request identifiers should be retained through queue retries and linked to result records at the receiver. Before sending again, query the receiver for that identifier and reconcile the durable result. This separates a missing response from an unexecuted request.';
 const gen=async()=>({text:decision(generated),provider:'ollama',model:'test'});
 const observed=await runSocialCycle(x.store,x.path,fake as typeof fetch,x.now,gen);assert.equal(observed.status,'PUBLISHED',JSON.stringify(observed));assert.equal(writes,1);assert.equal(x.store.db.prepare("SELECT status FROM social_replies WHERE id='root'").get()?.status,'VERIFICATION_FAILED');assert.equal(x.store.db.prepare("SELECT visibility FROM social_visibility WHERE reply_id='root'").get()?.visibility,'VISIBLE');
 await runSocialCycle(x.store,x.path,fake as typeof fetch,x.now+3600001,gen);assert.equal(writes,1);
 }finally{x.close();}});
test('failed public reads preserve last visibility but expose current uncertainty',async()=>{const x=fixture();try{
 observeComment(x.store,x.store.db.prepare('SELECT * FROM social_replies').get(),[comment()],'KestrelField',x.now-600001);
 const fake=async()=>new Response('unavailable',{status:503});assert.equal((await scanFollowups(x.store,x.path,fake as typeof fetch,x.now)).failures,1);const row=x.store.db.prepare('SELECT * FROM social_visibility').get()!;assert.equal(row.last_visible_at,x.now-600001);assert.equal(row.visibility,'UNKNOWN');assert.equal(row.error_code,'public_thread_read_failed');assert.equal(x.store.db.prepare('SELECT status FROM social_replies').get()?.status,'VERIFICATION_FAILED');
 }finally{x.close();}});

function decision(replyText:string){return JSON.stringify({action:"help",need:"Understand reliable queue retries and durable results.",evidence:body.slice(0,80),reason:"Offer a concrete mechanism addressing the source constraint.",body:replyText});}
