import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openStore} from '../src/store.ts';
import {queueChat,chatHistory,runAdminChat,chatStatusFacts} from '../src/admin-chat.ts';
function setup(){const dir=mkdtempSync(tmpdir()+'/chat-'),store=openStore(dir);store.setOperator(true,'ollama','chat-model',50);return {dir,store,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}
test('admin chat is persistent, idempotent, ordered and bounded',async()=>{const x=setup();try{const first=queueChat(x.store,'Hello Kestrel','request-one',1);assert.equal(queueChat(x.store,'Hello Kestrel','request-one',2).id,first.id);assert.throws(()=>queueChat(x.store,'Changed','request-one'));assert.throws(()=>queueChat(x.store,'x'.repeat(2001),'request-long'));let input:any;const gen:any=async(_cfg:any,task:string,text:string)=>{assert.equal(task,'admin-chat');input=JSON.parse(text);return {text:'Hello Admin. I am online.'};};assert.equal(await runAdminChat(x.store,gen,3),true);assert.equal(input.message.sender,'Admin');assert.ok(!JSON.stringify(input).includes('Codex'));assert.equal(chatHistory(x.store)[0].status,'ANSWERED');queueChat(x.store,'What happened?','request-two',4);await runAdminChat(x.store,gen,5);assert.equal(input.history[0].Admin,'Hello Kestrel');const reopened=openStore(x.dir);try{assert.equal(chatHistory(reopened).length,2);}finally{reopened.db.close();}}finally{x.close();}});
test('concurrent workers claim once; paused processing and daily budget make no model calls',async()=>{const x=setup();try{queueChat(x.store,'Status please','request-one',1);let calls=0,release:any;const gen:any=async()=>{calls++;await new Promise(r=>release=r);return {text:'Here is the observed status.'};};const running=runAdminChat(x.store,gen,2);assert.equal(await runAdminChat(x.store,gen,3),false);release();await running;assert.equal(calls,1);queueChat(x.store,'Again','request-two',4);x.store.setOperator(false,'ollama','chat-model',50);assert.equal(await runAdminChat(x.store,gen,5),false);x.store.setOperator(true,'ollama','chat-model',50);for(let i=0;i<19;i++)x.store.db.prepare("INSERT INTO kestrel_chat(id,request_key,body,status,created_at,started_at) VALUES(?,?,?,'FAILED',1,2)").run('budget-'+i,'budget-key-'+i,'Past');assert.equal(await runAdminChat(x.store,gen,6),false);assert.equal(calls,1);}finally{x.close();}});
test('failure diagnostics never echo secrets and interrupted requests are not replayed',async()=>{const x=setup();try{queueChat(x.store,'Status','request-one',1);const gen:any=async()=>{throw Error('private secret model error');};await runAdminChat(x.store,gen,2);assert.equal(chatHistory(x.store)[0].error_code,'chat_generation_failed');assert.ok(!JSON.stringify(chatHistory(x.store)).includes('private secret'));const r=queueChat(x.store,'Second','request-two',3);x.store.db.prepare("UPDATE kestrel_chat SET status='PROCESSING',started_at=3 WHERE id=?").run(r.id);assert.equal(await runAdminChat(x.store,gen,700004),false);assert.equal(chatHistory(x.store)[1].error_code,'chat_interrupted');}finally{x.close();}});

test('chat status distinguishes rolling generation limits from writes and supplies exact eligibility',()=>{const x=setup();try{
 const now=Date.UTC(2026,9,5,10),first=now-16*3600000;
 x.store.db.prepare('UPDATE social_autonomy SET enabled=1,checked_at=? WHERE id=1').run(now-2*3600000);
 for(let i=0;i<6;i++)x.store.db.prepare("INSERT INTO social_generation(id,post_id,status,started_at) VALUES(?,?,'FAILED',?)").run('status-'+i,'post-'+i,first+i*3600000);
 const facts=chatStatusFacts(x.store,now);
 assert.equal(facts.waiting_reason,'generation_daily_limit');assert.equal(facts.generation_attempts,6);assert.equal(facts.reply_write_attempts,0);
 assert.equal(facts.seconds_until_eligible,8*3600);assert.equal(facts.next_eligible_utc,new Date(first+86400000).toISOString());assert.match(facts.next_eligible_eat!,/EAT$/);assert.match(facts.window,/not lifetime/);
}finally{x.close();}});

test('lifetime chat verification includes older published records even without attempt timestamps',()=>{const x=setup();try{
 x.store.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES('legacy','Title','Body','agent','general',1)").run();
 x.store.db.prepare("INSERT INTO social_replies(id,post_id,body,status) VALUES('legacy-reply','legacy','Reply','PUBLISHED')").run();
 const facts=chatStatusFacts(x.store,Date.now());assert.equal(facts.verified_replies,0);assert.equal(facts.lifetime_replies.verified,1);assert.match(facts.verified_count_summary,/all stored history: 1/);
}finally{x.close();}});

test('focused chat keeps named conversation and attribution while dropping unrelated history and duplicate state',async()=>{const {buildChatContext}=await import('../src/admin-chat.ts');const x=setup(),now=Date.now();try{
 for(let i=0;i<6;i++)x.store.db.prepare("INSERT INTO kestrel_chat(id,request_key,body,response,status,created_at) VALUES(?,?,?,?,'ANSWERED',?)").run('old-'+i,'old-key-'+i,'Unrelated weather and gardening '+i,'Old unrelated answer '.repeat(200),now-100+i);
 x.store.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES('hermes','Introduction',?,'hermesdejoel','agents',?)").run('My human challenge is to document the journey of an agent earning real income. '.repeat(20),now);
 x.store.db.prepare("INSERT INTO social_replies(id,post_id,body,status) VALUES('manual','hermes','What concrete task and success criterion are you working toward?','PUBLISHED')").run();
 const c=buildChatContext(x.store,'Recall the hermesdejoel conversation and who initiated our contribution.','current',now,now);
 assert.equal(c.conversations.length,1);assert.equal(c.conversations[0].origin,'ADMIN_INITIATED');assert.equal(c.history.length,0);assert.ok(!('autonomy' in c.live_state));assert.ok(!('agent_core' in c.live_state));assert.ok(JSON.stringify(c).length<3000);assert.equal(c.live_state.status_facts.lifetime_replies.verified,1);
 const large=buildChatContext(x.store,'Tell me your goals and status. '+ 'x'.repeat(1900),'current',now,now);assert.ok(JSON.stringify(large).length<=6000);
}finally{x.close();}});
test('chat adapter bounds CPU output without raising budgets or accepting truncated output',async()=>{const {generate,ModelError}=await import('../src/models.ts');let options:any;const fake:any=async(_url:any,init:any)=>{options=JSON.parse(init.body).options;return new Response(JSON.stringify({done:true,done_reason:'stop',message:{content:'Admin initiated that contribution.'}}));};await generate({provider:'ollama',model:'test'},'admin-chat','Focused context',fake);assert.equal(options.num_predict,240);await assert.rejects(()=>generate({provider:'ollama',model:'test'},'admin-chat','Focused context',async()=>new Response(JSON.stringify({done:true,done_reason:'length',message:{content:'partial'}}))),ModelError);});

test('named recall beats overlapping verification words, stale wrong chat and recent unrelated replies',async()=>{const {buildChatContext}=await import('../src/admin-chat.ts');const x=setup(),now=Date.now();try{
 x.store.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES('hermes','Introduction','My human challenge is to document my journey earning real income honestly.','hermesdejoel','agents',?)").run(now);
 x.store.db.prepare("INSERT INTO social_replies(id,post_id,body,status) VALUES('hermes-manual','hermes','What concrete task and success criterion are you working toward?','PUBLISHED')").run();
 for(let i=0;i<105;i++){
 x.store.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES(?,?,?,?,?,?)").run('noise-'+i,'Conversation verification recorded reply context optimisation','Specify resource IDs and observation deadlines.','other-'+i,'agents',now);
 x.store.db.prepare("INSERT INTO social_replies(id,post_id,body,status) VALUES(?,?,?,'PUBLISHED')").run('noise-reply-'+i,'noise-'+i,'Admin checking conversation recall recorded contribution tester provider interpretation verification.');
 }
 x.store.db.prepare("INSERT INTO kestrel_chat(id,request_key,body,response,status,created_at) VALUES('wrong','wrong-key','Tell me about hermesdejoel','Hermes discussed verification deadlines.','ANSWERED',?)").run(now-1);
 const message='Admin checking conversation recall after the context optimisation. Briefly state what hermesdejoel was trying to achieve, quote or summarise our recorded reply, and identify who initiated it. Separate recorded facts from your interpretation of whether they could be a tester or service provider. Do not post, contact anyone, or change settings.';
 const c=buildChatContext(x.store,message,'current',now,now);
 assert.equal(c.conversations.length,1);assert.equal(c.conversations[0].author,'hermesdejoel');assert.equal(c.conversations[0].origin,'ADMIN_INITIATED');assert.match(c.conversations[0].source_excerpt,/earning real income/);assert.match(c.conversations[0].our_reply,/concrete task/);assert.equal(c.history.length,0);assert.ok(!JSON.stringify(c).includes('resource IDs'));
 const mixed=buildChatContext(x.store,'Compare HERMESDEJOEL and other-104 conversations.','current',now,now);assert.ok(['hermesdejoel','other-104'].includes(String(mixed.conversations[0].author)));
}finally{x.close();}});
