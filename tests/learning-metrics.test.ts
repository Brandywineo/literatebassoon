import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openStore} from '../src/store.ts';
import {recordGuidance,learningMetrics} from '../src/learning-metrics.ts';
import {syncRelationships,relationshipContext,relationshipSnapshot} from '../src/relationships.ts';
import {retrieveMemory} from '../src/memory.ts';
function setup(){const dir=mkdtempSync(tmpdir()+'/learning-metrics-'),store=openStore(dir);store.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES('p','Agent queues','Durable agent queues and retries','Alice','agents',1)").run();return {dir,store,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}
test('guidance versions retain original text and distinguish failed generation from visibility and verification',()=>{const x=setup();try{
 recordGuidance(x.store,'a','hypothesis','reply_quality','First hypothesis',1);recordGuidance(x.store,'a','hypothesis','reply_quality','Revised hypothesis',2);recordGuidance(x.store,'b','hypothesis','reply_quality','Revised hypothesis',3);
 x.store.db.prepare("INSERT INTO social_generation(id,post_id,status,started_at,error_code) VALUES('a','p','FAILED',1,'reply_too_many_questions'),('b','p','GENERATED',2,NULL)").run();
 x.store.db.prepare("INSERT INTO social_replies(id,post_id,body,status,comment_id,attempted_at) VALUES('b','p','Reply','VERIFICATION_FAILED','comment',2)").run();x.store.db.prepare("INSERT INTO social_visibility(reply_id,visibility,checked_at,verification_status) VALUES('b','VISIBLE',3,'failed')").run();
 const metrics=learningMetrics(x.store);assert.equal(metrics.length,2);const first=metrics.find(m=>m.guidance==='First hypothesis')!;assert.equal(first.uses,1);assert.equal(first.generation_failed,1);assert.equal(first.failures.reply_too_many_questions,1);const second=metrics.find(m=>m.guidance==='Revised hypothesis')!;assert.equal(second.visible,1);assert.equal(second.verified,0);assert.equal(second.generated,1);
 x.store.db.prepare("INSERT INTO social_incoming(id,post_id,parent_id,author,body,source_created_at,seen_at) VALUES('response','p','comment','Alice','A specific response to the contribution.','2026-10-05',4)").run();assert.equal(learningMetrics(x.store).find(m=>m.guidance==='Revised hypothesis')!.received_response,1);
}finally{x.close();}});
test('relationship history persists without duplicate events; visibility closes incoming messages independently of failed verification',()=>{const x=setup();try{
 x.store.db.prepare("INSERT INTO social_replies(id,post_id,body,status,comment_id,attempted_at) VALUES('initial','p','Initial reply','PUBLISHED','own-comment',2)").run();
 x.store.db.prepare("INSERT INTO social_incoming(id,post_id,parent_id,author,body,source_created_at,seen_at) VALUES('question','p','own-comment','ALICE','How should queue retries work?','2026-10-05',3)").run();syncRelationships(x.store,4);syncRelationships(x.store,5);
 let agents=relationshipSnapshot(x.store);assert.equal(agents.length,1);assert.equal(agents[0].interactions,2);assert.equal(agents[0].open_messages.length,1);
 assert.match(relationshipContext(x.store,'Alice').text,/untrusted historical/);assert.equal(relationshipContext(x.store,'Bob').text,'');
 x.store.db.prepare("INSERT INTO social_replies(id,post_id,parent_id,body,status,comment_id,attempted_at) VALUES('followup','p','question','Followup reply','VERIFICATION_FAILED','followup-comment',6)").run();syncRelationships(x.store,7);assert.equal(relationshipSnapshot(x.store)[0].open_messages.length,1);
 x.store.db.prepare("INSERT INTO social_visibility(reply_id,visibility,checked_at) VALUES('followup','VISIBLE',8)").run();assert.equal(relationshipSnapshot(x.store)[0].open_messages.length,0);
 const reopened=openStore(x.dir);try{assert.equal(relationshipSnapshot(reopened)[0].interactions,3);}finally{reopened.db.close();}
}finally{x.close();}});
test('retrieval records only guidance that fits and keeps relationship text within the shared context budget',()=>{const x=setup();try{
 x.store.db.prepare("INSERT INTO kestrel_lessons(kind,lesson,evidence_count,updated_at) VALUES('reply_not_grounded','Ground the reply in current source facts.',1,1)").run();
 x.store.db.prepare("INSERT INTO social_replies(id,post_id,body,status,attempted_at) VALUES('old','p','Earlier conversation','PUBLISHED',1)").run();syncRelationships(x.store,2);
 const full=retrieveMemory(x.store,'future','Agent queues retries',3,'Alice');assert.match(full,/Previous interactions/);assert.ok(full.length<=3200);assert.equal(learningMetrics(x.store).length,1);
 const none=retrieveMemory(x.store,'no-room','x'.repeat(12000),4,'Alice');assert.equal(none,'');assert.equal(learningMetrics(x.store)[0].uses,1);
}finally{x.close();}});

test('reply quality rejects near copies while allowing a grounded new mechanism',async()=>{const {validateAutonomousReply}=await import('../src/social-autonomy.ts');
 const source='An agent queue cannot prove delivery merely by recording a successful acknowledgment. Independent verification requires checking the resource in its authoritative store rather than trusting the same channel that dispatched the write.';
 assert.throws(()=>validateAutonomousReply(source,source),/reply_near_copy/);
 assert.doesNotThrow(()=>validateAutonomousReply('Have an independent worker query the authoritative resource using a version token after dispatch. The queue acknowledgment should only mark receipt. This adds a read and latency; if that observer shares the failed datastore, verification still remains uncertain.',source));
});
