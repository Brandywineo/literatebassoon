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
