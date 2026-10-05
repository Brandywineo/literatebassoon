import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openStore} from '../src/store.ts';
import {classifyDiscussion,chooseDiscussion,reservePlan,refreshPlanning,planningSnapshot} from '../src/planning.ts';
function setup(){const dir=mkdtempSync(tmpdir()+'/planning-'),store=openStore(dir);return {store,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}
function source(store:any,id:string,title:string,now:number){store.db.prepare('INSERT INTO social_discussions(id,title,body,author,community,seen_at,full_content,source_created_at) VALUES(?,?,?,?,?,?,1,?)').run(id,title,title+' A detailed discussion with practical examples.',id,'agents',now,new Date(now-1000).toISOString());}
test('planning selects service demand over unrelated newest sources and excludes handled work',()=>{const x=setup(),now=Date.now();try{source(x.store,'weather','Rainfall predictions',now);source(x.store,'workflow','Agent queue retries',now);source(x.store,'demand','Agents need writing and text cleanup',now);assert.equal(chooseDiscussion(x.store,now)?.p.id,'demand');assert.equal(chooseDiscussion(x.store,now)?.goal,'service_demand');x.store.db.prepare("INSERT INTO social_generation(id,post_id,started_at,status) VALUES('old','demand',?,'FAILED')").run(now);assert.equal(chooseDiscussion(x.store,now)?.p.id,'workflow');assert.equal(chooseDiscussion(x.store,now+3600001),null);}finally{x.close();}});
test('planning reconciles actual failure and public visibility without inventing goal success',()=>{const x=setup(),now=Date.now();try{source(x.store,'post','Agent queue retries',now);reservePlan(x.store,'attempt','post','useful_engagement','relevant_agent_workflow_discussion',30,now);x.store.db.prepare("INSERT INTO social_generation(id,post_id,started_at,status,error_code) VALUES('attempt','post',?,'FAILED','reply_too_many_questions')").run(now);refreshPlanning(x.store,now+1);let plan=planningSnapshot(x.store).plans[0];assert.equal(plan.status,'GENERATION_FAILED');assert.equal(plan.error_code,'reply_too_many_questions');x.store.db.prepare("UPDATE social_generation SET status='GENERATED',error_code=NULL WHERE id='attempt'").run();x.store.db.prepare("INSERT INTO social_replies(id,post_id,body,status,attempted_at) VALUES('attempt','post','Reply','VERIFICATION_FAILED',?)").run(now);x.store.db.prepare("INSERT INTO social_visibility(reply_id,visibility,checked_at) VALUES('attempt','VISIBLE',?)").run(now);refreshPlanning(x.store,now+2);plan=planningSnapshot(x.store).plans[0];assert.equal(plan.status,'VERIFICATION_FAILED');assert.equal(plan.visibility,'VISIBLE');const goal=planningSnapshot(x.store).goals.find(g=>g.id==='useful_engagement')!;assert.equal(JSON.parse(String(goal.metrics)).visible,1);assert.ok(!String(goal.metrics).includes('successful'));}finally{x.close();}});

test('service demand requires an explicit request rather than topic mentions, quotes or offers',()=>{
 for(const text of ['Agent memory summaries are lossy authorship. Writing is a judgment.', 'We offer proofreading services for agents.', 'I do not need rewriting help.', '> I need a proofreading service', 'Imagine agents need writing assistance.', '```\nI need text cleanup\n```'])assert.equal(classifyDiscussion(text).demand,false,text);
 for(const text of ['I need a proofreading service for this draft.', 'Can anyone summarize this long report?', 'We are looking for a rewriting tool.', 'Please rewrite this text.'])assert.equal(classifyDiscussion(text).demand,true,text);
});

test('an explicit service request outranks a fresh reliability essay mentioning summaries',()=>{const x=setup(),now=Date.now();try{
 source(x.store,'essay','Agent summaries and writing cannot prove independent verification',now);source(x.store,'request','I need text cleanup for a report',now);
 assert.equal(chooseDiscussion(x.store,now)?.p.id,'request');assert.equal(chooseDiscussion(x.store,now)?.reason,'explicit_text_service_request');
 x.store.db.prepare("DELETE FROM social_discussions WHERE id='request'").run();assert.equal(chooseDiscussion(x.store,now)?.goal,'useful_engagement');
}finally{x.close();}});
