import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openStore} from '../src/store.ts';
import {runAgentCore,coreSnapshot,recoverCore} from '../src/agent-core.ts';
import {backupDatabase,verifyBackup} from '../src/recovery.ts';
const plan={project_id:'agent_onboarding',tools:['inspect_onboarding'],reason:'Investigate registration-to-first-job conversion using observed totals.',next_step:'Propose clearer onboarding if conversion is low; no change has been implemented.'};
function fixture(){const dir=mkdtempSync(tmpdir()+'/core-');const store=openStore(dir+'/data');store.setOperator(true,'ollama','test',50);return {dir,store,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}
test('core acts without Moltbook, verifies evidence and persists budget across restart',async()=>{
 const x=fixture(),now=Date.now();try{let calls=0;const gen=async()=>{calls++;return {text:JSON.stringify(plan),provider:'ollama',model:'test'};};
 assert.equal((await runAgentCore(x.store,gen,now)).completed,true);assert.equal(coreSnapshot(x.store,now).tasks[0].status,'COMPLETED');assert.match(String(coreSnapshot(x.store,now).tasks[0].evidence),/registrations/);
 await runAgentCore(x.store,gen,now+1);assert.equal(calls,1);
 await runAgentCore(x.store,gen,now+3600001);assert.equal(calls,2);
 const reopened=openStore(x.dir+'/data');try{await runAgentCore(reopened,gen,now+7200002);assert.equal(calls,2);assert.equal(coreSnapshot(reopened,now+7200002).waiting_reason,'core_daily_limit');}finally{reopened.db.close();}
 }finally{x.close();}
});
test('core rejects unknown tools, hides provider errors and respects customer priority',async()=>{
 const x=fixture();try{const a=x.store.register('buyer','desc');x.store.submit(a.id,'ai-summary',JSON.stringify({text:'private input'}),'core-priority');let calls=0;const gen=async()=>{calls++;return {text:JSON.stringify({...plan,tools:['run_shell']}),provider:'ollama',model:'test'};};
 assert.equal((await runAgentCore(x.store,gen)).skipped,true);assert.equal(calls,0);x.store.db.prepare("UPDATE jobs SET status='FAILED'").run();assert.equal((await runAgentCore(x.store,gen)).error_code,'core_invalid_plan');assert.ok(!JSON.stringify(coreSnapshot(x.store)).includes('private input'));
 }finally{x.close();}
});
test('stale core task cannot apply a late result after recovery',async()=>{
 const x=fixture(),now=Date.now();try{let finish:any;const waiting=new Promise<any>(r=>{finish=r;});const flight=runAgentCore(x.store,async()=>waiting,now);
 assert.equal(recoverCore(x.store,now+600001),1);finish({text:JSON.stringify(plan),provider:'ollama',model:'test'});assert.equal((await flight).completed,false);assert.equal(coreSnapshot(x.store,now).tasks[0].error_code,'core_interrupted');assert.equal(x.store.db.prepare("SELECT next_step FROM kestrel_projects WHERE id='agent_onboarding'").get()?.next_step,null);
 }finally{x.close();}
});
test('online backup restores balances, core history and uncertain delivery without replay',async()=>{
 const x=fixture(),now=Date.now();try{const a=x.store.register('restore-agent','desc');const credits=x.store.db.prepare('SELECT credits FROM agents WHERE id=?').get(a.id)?.credits;
 await runAgentCore(x.store,async()=>({text:JSON.stringify(plan),provider:'ollama',model:'test'}),now);
 x.store.db.prepare("INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES('p','t','b','a','g',?)").run(now);x.store.db.prepare("INSERT INTO social_replies(id,post_id,body,status,attempted_at) VALUES('uncertain','p','body','UNCERTAIN',?)").run(now);
 const destination=x.dir+'/restored/exchange.sqlite';assert.equal((await backupDatabase(x.dir+'/data/exchange.sqlite',destination)).integrity,'ok');assert.equal(verifyBackup(destination).counts.kestrel_tasks,1);
 const restored=openStore(x.dir+'/restored');try{assert.equal(restored.db.prepare('SELECT credits FROM agents WHERE id=?').get(a.id)?.credits,credits);assert.equal(restored.db.prepare("SELECT status FROM social_replies WHERE id='uncertain'").get()?.status,'UNCERTAIN');let calls=0;await runAgentCore(restored,async()=>{calls++;throw Error('unexpected');},now+1);assert.equal(calls,0);}finally{restored.db.close();}
 }finally{x.close();}
});
