import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openStore} from '../src/store.ts';
import {normalizeContribution,privateDraft,validateContributionHistory} from '../src/social-quality.ts';
import {learnFromOutcomes,retrieveMemory} from '../src/memory.ts';

test('format repair preserves every proposition and repeated questions remain rejected',()=>{
 const dir=mkdtempSync(tmpdir()+'/draft-');const store=openStore(dir+'/db');try{
 const text='Answer: Use a separate reader to verify checkpoints. Benefit: detects shared failures. Limitation: needs extra storage. Ask: Which independent observer checks the latest state?';
 const repaired=normalizeContribution(text);
 assert.equal(repaired,'Use a separate reader to verify checkpoints. detects shared failures. needs extra storage. Which independent observer checks the latest state?');
 assert.equal(normalizeContribution(repaired),repaired);
 assert.doesNotThrow(()=>validateContributionHistory(store,'A separate observer helps. Limitation: it requires extra storage.'));
 assert.throws(()=>validateContributionHistory(store,'Ask: Which independent observer checks the latest state?'),/template/);
 store.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES('p','Post','Body','Alice','agents',1)").run();
 store.db.prepare("INSERT INTO social_replies(id,post_id,body,status,attempted_at) VALUES('r','p',?,'PUBLISHED',1)").run(repaired);
 assert.throws(()=>validateContributionHistory(store,normalizeContribution('Answer: Independent credentials reduce correlated faults. Ask: Which independent observer checks the latest state?')),/previous_question/);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('private output redacts configured keys and is bounded',()=>{
 const old=process.env.OPENAI_API_KEY;try{process.env.OPENAI_API_KEY='secret-test-value';assert.equal(privateDraft('secret-test-value sk-abcdefghijklmnop'),'[REDACTED] [REDACTED]');assert.equal(privateDraft('x'.repeat(9000)).length,8000);}finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
test('recent failure guidance supersedes frequent stale lessons and wording refresh preserves counts',()=>{
 const dir=mkdtempSync(tmpdir()+'/draft-');const store=openStore(dir+'/db');try{
 for(const [kind,n,time] of [['reply_too_short',100,1],['reply_too_long',99,2],['reply_near_copy',98,3],['reply_template_residue',5,100]])store.db.prepare('INSERT INTO kestrel_lessons(kind,lesson,evidence_count,updated_at) VALUES(?,?,?,?)').run(kind,'old wording',n,time);
 learnFromOutcomes(store,101);
 const row=store.db.prepare("SELECT * FROM kestrel_lessons WHERE kind='reply_template_residue'").get()!;assert.equal(row.evidence_count,5);assert.equal(row.updated_at,100);assert.match(String(row.lesson),/template labels/);
 assert.match(retrieveMemory(store,'test','Independent agent checkpoint storage',102,'',1200),/template labels/);
 assert.ok(store.db.prepare('PRAGMA table_info(social_generation)').all().some(r=>r.name==='raw_draft'));
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
