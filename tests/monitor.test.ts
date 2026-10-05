import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openStore} from '../src/store.ts';
import {inspectOperations,createOutreachDraft} from '../src/operator.ts';
function fixture(fn:(s:ReturnType<typeof openStore>)=>void){const dir=mkdtempSync(tmpdir()+'/monitor-');const s=openStore(dir);try{fn(s);}finally{s.db.close();rmSync(dir,{recursive:true,force:true});}}
test('monitor persists aggregates, deduplicates events and detects stalled work',()=>fixture(s=>{
 const a=s.register('monitor-buyer','private description');s.setOperator(true,'ollama','test',50);
 s.submit(a.id,'ai-summary',JSON.stringify({text:'private job content'}),'monitor-1');const claim=s.claimAI()!;
 s.db.prepare("UPDATE jobs SET created_at=datetime('now','-10 minutes'),lease_until=?").run(Date.now()-1);
 const snapshot=inspectOperations(s);assert.equal(snapshot.queue.queued,1);assert.equal(snapshot.runs.running,1);assert.equal(snapshot.alerts.length,2);assert.ok(!JSON.stringify(snapshot).includes('private'));
 inspectOperations(s);assert.equal(s.db.prepare('SELECT count(*) AS n FROM operator_events').get()?.n,1);
 s.settle(String(claim.id),'FAILED','{}',undefined,String(claim.token));s.finishAI(claim,'FAILED','timeout');
 const failed=inspectOperations(s);assert.equal(failed.queue.queued,0);assert.equal(failed.runs.failed,1);assert.equal(failed.failures[0].code,'timeout');assert.ok(failed.runs.average_seconds!==null);
}));
test('outreach drafts use available services and disclose role without sending',()=>fixture(s=>{
 const draft=createOutreachDraft(s,'text-stats');assert.equal(draft.status,'DRAFT');assert.match(draft.body,/operator of Literate Bassoon/);assert.match(draft.body,/test credits/);assert.equal(s.db.prepare('SELECT count(*) AS n FROM outreach_drafts').get()?.n,1);
 assert.throws(()=>createOutreachDraft(s,'ai-summary'),/Available service/);
 s.db.prepare("UPDATE services SET active=0 WHERE id='text-stats'").run();assert.throws(()=>createOutreachDraft(s,'text-stats'),/Available service/);
}));
test('monitor separates social, reflection, chat and verification without replaying stalled work',()=>fixture(s=>{
 const now=Date.now();s.setOperator(true,'ollama','test',50);
 s.db.prepare("INSERT INTO kestrel_chat(id,request_key,body,status,created_at,started_at,finished_at) VALUES('chat','monitor-chat','secret','ANSWERED',?,?,?)").run(now-5000,now-4000,now-1000);
 s.db.prepare("INSERT INTO social_generation(id,post_id,started_at,status,finished_at) VALUES('generation','post',?,'GENERATED',?)").run(now-10000,now-2000);
 s.db.prepare("INSERT INTO kestrel_reflections(id,started_at,status,evidence_count) VALUES('reflection',?,'RUNNING',1)").run(now-700000);
 s.db.prepare("INSERT INTO social_verification_attempts(target,started_at,status,finished_at) VALUES('reply:test',?,'PUBLISHED',?)").run(now-6000,now-1000);
 const snapshot=inspectOperations(s,now);
 assert.equal(snapshot.activities.chat.completed,1);assert.equal(snapshot.activities.chat.average_seconds,3);
 assert.equal(snapshot.activities.social.completed,1);assert.equal(snapshot.activities.verification.completed,1);
 assert.equal(snapshot.activities.reflection.stalled,1);assert.equal(s.db.prepare("SELECT status FROM kestrel_reflections WHERE id='reflection'").get()?.status,'RUNNING');
 assert.ok(!JSON.stringify(snapshot).includes('secret'));assert.equal(snapshot.worker_health,'unknown');
 inspectOperations(s,now);assert.equal(s.db.prepare('SELECT count(*) AS n FROM operator_events').get()?.n,1);
}));
