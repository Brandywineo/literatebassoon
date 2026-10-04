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
