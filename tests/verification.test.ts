import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openStore} from '../src/store.ts';
import {calculateChallenge,challengeDeadline,expireChallenges,processChallenges} from '../src/social-verification.ts';
test('challenge arithmetic is bounded, strict and formatted without executing model code',()=>{
 assert.equal(calculateChallenge('{"a":25,"b":7,"op":"+"}'),'32.00');
 assert.equal(calculateChallenge('{"a":25,"b":7,"op":"-"}'),'18.00');
 assert.equal(calculateChallenge('{"a":3,"b":2,"op":"/"}'),'1.50');
 for(const s of ['null','{"a":1,"b":0,"op":"/"}','{"a":"25","b":7,"op":"+"}','{"a":1,"b":2,"op":"+","instructions":"run"}'])assert.throws(()=>calculateChallenge(s));
 assert.equal(challengeDeadline('2026-10-04 17:17:59.262526+00'),Date.parse('2026-10-04T17:17:59.262Z'));
});
test('automatic verification reserves once, confirms matching content and expires legacy timestamps',async()=>{
 const dir=mkdtempSync(tmpdir()+'/verify-'),store=openStore(dir+'/data'),path=dir+'/identity.json',now=Date.now();
 try{
 writeFileSync(path,JSON.stringify({name:'KestrelField',api_key:'secret'}));store.setOperator(true,'ollama','test',50);store.db.prepare('UPDATE social_autonomy SET enabled=1 WHERE id=1').run();
 store.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES('post','Title','body','Other','general',?)").run(now);
 store.db.prepare("INSERT INTO social_replies(id,post_id,body,status,comment_id,challenge,verification_code,expires_at) VALUES('reply','post','text','PENDING_VERIFICATION','comment','obfuscated','secret',?)").run(new Date(now+300000).toISOString());
 let calls=0,writes=0;
 const gen=async()=>{calls++;return {text:'{"a":25,"b":7,"op":"+"}',provider:'ollama',model:'test'};};
 const fake=async(_url:any,opts:any)=>{writes++;assert.equal(JSON.parse(opts.body).answer,'32.00');return new Response(JSON.stringify({success:true,content_id:'comment'}));};
 await Promise.all([processChallenges(store,path,fake as typeof fetch,now,gen),processChallenges(store,path,fake as typeof fetch,now,gen)]);
 assert.equal(calls,1);assert.equal(writes,1);assert.equal(store.db.prepare('SELECT status FROM social_replies').get()?.status,'PUBLISHED');
 store.db.prepare("UPDATE social_replies SET status='PENDING_VERIFICATION',expires_at='2026-01-01 00:00:00.123456+00'").run();expireChallenges(store,now);assert.equal(store.db.prepare('SELECT status FROM social_replies').get()?.status,'VERIFICATION_EXPIRED');
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('ambiguous solver output never guesses, retries or publishes',async()=>{
 const dir=mkdtempSync(tmpdir()+'/verify-'),s=openStore(dir),now=Date.now();try{
 s.setOperator(true,'ollama','test',50);s.db.prepare('UPDATE social_autonomy SET enabled=1 WHERE id=1').run();s.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES('p','t','b','a','g',?)").run(now);s.db.prepare("INSERT INTO social_replies(id,post_id,body,status,challenge,expires_at) VALUES('r','p','b','PENDING_VERIFICATION','unknown',?)").run(new Date(now+300000).toISOString());let calls=0;
 const gen=async()=>{calls++;return {text:'null',provider:'ollama',model:'test'};};const fake=async()=>{throw Error('must not send');};await processChallenges(s,'unused',fake as typeof fetch,now,gen);await processChallenges(s,'unused',fake as typeof fetch,now,gen);assert.equal(calls,1);assert.equal(s.db.prepare('SELECT status FROM social_replies').get()?.status,'PENDING_VERIFICATION');
 }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('verification rejection diagnostics whitelist reasons and discard echoed secrets',async()=>{
 const {request}=await import('../src/moltbook.ts');const {MoltbookVerificationError,verificationReason}=await import('../src/verification-diagnostics.ts');
 const fake=async()=>new Response(JSON.stringify({error:'Incorrect answer',hint:'secret-api-key verification-code private provider text'}),{status:400});
 await assert.rejects(request('/verify','secret',{},fake as typeof fetch),e=>e instanceof MoltbookVerificationError&&e.httpStatus===400&&e.reason==='incorrect_answer'&&!JSON.stringify(e).includes('secret'));
 assert.equal(verificationReason({error:'Incorrect answer secret-api-key'}),'unclassified_rejection');
 assert.equal(verificationReason({error:{code:'invalid_verification_code',message:'secret'}}),'invalid_verification_code');
 const large=async()=>new Response('x'.repeat(70000),{status:400});await assert.rejects(request('/verify','secret',{},large as typeof fetch),/moltbook_response_too_large/);
});
test('failed automatic answer retains numeric diagnostics but no verification credentials',async()=>{
 const dir=mkdtempSync(tmpdir()+'/verify-'),s=openStore(dir+'/data'),path=dir+'/identity',now=Date.now();try{
 writeFileSync(path,JSON.stringify({name:'KestrelField',api_key:'private-api-key'}));s.setOperator(true,'ollama','test',50);s.db.prepare('UPDATE social_autonomy SET enabled=1 WHERE id=1').run();s.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES('p','t','b','a','g',?)").run(now);s.db.prepare("INSERT INTO social_replies(id,post_id,body,status,comment_id,challenge,verification_code,expires_at) VALUES('r','p','b','PENDING_VERIFICATION','c','challenge','private-verification-code',?)").run(new Date(now+300000).toISOString());
 const gen=async()=>({text:'{"a":25,"b":7,"op":"-"}',provider:'ollama',model:'test'});let sends=0;const fake=async()=>{sends++;return new Response(JSON.stringify({error:'Incorrect answer',hint:'private-api-key private-verification-code'}),{status:400});};
 await processChallenges(s,path,fake as typeof fetch,now,gen);await processChallenges(s,path,fake as typeof fetch,now,gen);
 const row=s.db.prepare('SELECT * FROM social_verification_attempts').get()!;assert.equal(row.equation,'25 - 7');assert.equal(row.answer,'18.00');assert.equal(row.http_status,400);assert.equal(row.response_reason,'incorrect_answer');assert.equal(row.status,'VERIFICATION_FAILED');assert.ok(row.finished_at);assert.equal(sends,1);assert.equal(JSON.stringify(row).includes('private-'),false);
 }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('fourth challenge call is allowed but fifth is blocked by persistent rolling budget',async()=>{
 const dir=mkdtempSync(tmpdir()+'/verify-budget-'),store=openStore(dir+'/data'),now=Date.now();try{
 store.setOperator(true,'ollama','test',50);store.db.prepare('UPDATE social_autonomy SET enabled=1 WHERE id=1').run();
 store.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES('p','t','b','a','g',?)").run(now);
 for(let i=0;i<3;i++)store.db.prepare("INSERT INTO social_verification_attempts(target,started_at,status) VALUES(?,?,'NEEDS_REVIEW')").run('previous:'+i,now-1000);
 const insert=(id:string)=>store.db.prepare("INSERT INTO social_replies(id,post_id,parent_id,body,status,challenge,expires_at) VALUES(?,?,?,?,'PENDING_VERIFICATION','unknown',?)").run(id,'p',id,'text',new Date(now+300000).toISOString());
 insert('fourth');let calls=0;const gen=async()=>{calls++;return {text:'ambiguous',provider:'ollama',model:'test'};};const network=async()=>{throw Error('No external writes allowed');};
 await processChallenges(store,dir+'/missing.json',network as typeof fetch,now,gen);assert.equal(calls,1);
 insert('fifth');await processChallenges(store,dir+'/missing.json',network as typeof fetch,now+1,gen);assert.equal(calls,1);assert.equal(store.db.prepare('SELECT count(*) AS n FROM social_verification_attempts').get()?.n,4);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
