import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store.ts';
import { runOne } from '../src/worker.ts';
import { generate } from '../src/models.ts';
async function fixture(fn:(s:ReturnType<typeof openStore>)=>Promise<void>){const dir=mkdtempSync(tmpdir()+'/operator-'),s=openStore(dir);try{await fn(s);}finally{s.db.close();rmSync(dir,{recursive:true,force:true});}}
test('existing database migrates without resetting balances',async()=>fixture(async s=>{const a=s.register('buyer','test');s.submit(a.id,'text-stats','{"text":"hi"}','request-1');const other=openStore((s.db as any).location().replace('/exchange.sqlite',''));other.db.close();assert.equal(s.db.prepare('SELECT credits FROM agents WHERE id=?').get(a.id)?.credits,99);}));
test('AI listings start disabled; worker completes configured jobs',async()=>fixture(async s=>{const a=s.register('buyer','test');assert.throws(()=>s.submit(a.id,'ai-summary','{"text":"hello"}','request-1'));s.setOperator(true,'ollama','test-model',50);const job=s.submit(a.id,'ai-summary','{"text":"hello"}','request-1');s.tick();assert.equal(s.db.prepare('SELECT status FROM jobs WHERE id=?').get(job?.id)?.status,'QUEUED');await runOne(s,async(c,t,input)=>{assert.equal(input,'hello');assert.equal(c.model,'test-model');return {text:'summary',provider:c.provider,model:c.model};});assert.equal(s.db.prepare('SELECT status FROM jobs WHERE id=?').get(job?.id)?.status,'COMPLETED');assert.equal(s.db.prepare('SELECT credits FROM agents WHERE id=?').get(a.id)?.credits,95);}));
test('model failures refund once and daily request caps stop calls',async()=>fixture(async s=>{const a=s.register('buyer','test');s.setOperator(true,'ollama','test',1);s.submit(a.id,'ai-summary','{"text":"hello"}','request-1');await runOne(s,async()=>{throw Error('secret provider error');});assert.equal(s.db.prepare('SELECT credits FROM agents WHERE id=?').get(a.id)?.credits,100);assert.throws(()=>s.submit(a.id,'ai-summary','{"text":"hello"}','request-2'));assert.equal(await runOne(s,async()=>{throw Error('must not call');}),false);}));
test('leases prevent concurrent claims and cancellation defeats late delivery',async()=>fixture(async s=>{const a=s.register('buyer','test');s.setOperator(true,'ollama','test',50);const job=s.submit(a.id,'ai-summary','{"text":"hello"}','request-1');const claim=s.claimAI();assert.ok(claim);assert.equal(s.claimAI(),undefined);s.settle(String(job?.id),'CANCELLED','{}',a.id);assert.throws(()=>s.settle(String(job?.id),'COMPLETED','{}',undefined,String(claim.token)));assert.equal(s.db.prepare('SELECT credits FROM agents WHERE id=?').get(a.id)?.credits,100);}));
test('paused worker makes no calls, and suspended agents cannot submit',async()=>fixture(async s=>{const a=s.register('buyer','test');assert.equal(await runOne(s),false);s.db.prepare('UPDATE agents SET disabled=1 WHERE id=?').run(a.id);assert.throws(()=>s.submit(a.id,'text-stats','{}','request-1'));}));
test('model adapters send bounded nonstreaming requests and parse outputs',async()=>{
 const fake=async(url:any,init:any)=>{const body=JSON.parse(init.body);assert.equal(body.stream,false);assert.equal(body.messages[1].content,'input');return new Response(JSON.stringify({message:{content:'summary'}}));};
 assert.equal((await generate({provider:'ollama',model:'test'},'ai-summary','input',fake as typeof fetch)).text,'summary');
 await assert.rejects(()=>generate({provider:'ollama',model:'test',ollamaUrl:'https://evil.example'},'ai-summary','input',fake as typeof fetch));
 const openai=async(url:any,init:any)=>{assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(init.body);assert.equal(body.store,false);assert.equal(body.max_output_tokens,1200);assert.equal(init.headers.Authorization,'Bearer test-key');return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'result'}]}]}));};
 assert.equal((await generate({provider:'openai',model:'test',openaiKey:'test-key'},'ai-rewrite','input',openai as typeof fetch)).text,'result');
});

test('provider failure diagnostics retain safe codes and hide messages',async()=>{
 const fake=async()=>new Response(JSON.stringify({error:{code:'insufficient_quota',message:'private account information'}}),{status:429});
 await assert.rejects(()=>generate({provider:'openai',model:'test',openaiKey:'secret-key'},'ai-summary','input',fake as typeof fetch),{message:'insufficient_quota'});
 const unknown=async()=>new Response(JSON.stringify({error:{code:'secret-key',message:'private'}}),{status:401});
 await assert.rejects(()=>generate({provider:'openai',model:'test',openaiKey:'secret-key'},'ai-summary','input',unknown as typeof fetch),{message:'http_401'});
});
