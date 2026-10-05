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
