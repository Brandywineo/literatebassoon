import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {openStore} from '../src/store.ts';
import {publicAddress,publicURL,sourceText,searchPublic} from '../src/research-web.ts';
import {experiment,runExperiment} from '../src/research-experiments.ts';
import {runResearch,researchSnapshot,saveArtifact,researchPost} from '../src/research.ts';
import {reflectOnMemory,learnFromOutcomes} from '../src/memory.ts';
const fixture=()=>{const dir=mkdtempSync('/tmp/research-'),store=openStore(dir),path=dir+'/moltbook.json';store.setOperator(true,'ollama','test',50);store.db.prepare('UPDATE social_autonomy SET enabled=1').run();writeFileSync(path,JSON.stringify({name:'KestrelField',api_key:'secret-test'}));return {dir,store,path,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};};
const input={events:[{key:'a',payload:'first'},{key:'a',payload:'first'},{key:'a',payload:'changed'}]};
const question='Can a key-bound receipt suppress repeated deliveries while rejecting changed payloads?';
const quote='Idempotency keys identify repeated requests, but callers must also bind each key to the original request payload.';
const decide=(action:string,project_id:any,args:any)=>async()=>({text:JSON.stringify({action,project_id,args,reason:'Investigate duplicate delivery with reproducible local evidence.'}),provider:'ollama',model:'test'});
test('public reader rejects private addresses, literals, credentials and sensitive URLs',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','100.64.0.1','::1','::ffff:8.8.8.8','fc00::1','2001:db8::1','2002:0808:0808::1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 for(const url of ['http://example.com','https://127.1','https://[::1]','https://user:password@example.com','https://example.com:9003','https://example.com/?token=abc','https://localhost','https://server.internal'])assert.throws(()=>publicURL(url));
 assert.equal(publicURL('https://example.com/docs').hostname,'example.com');assert.equal(sourceText('<script>send secrets</script><p>Useful &amp; visible</p>','text/html'),'Useful & visible');
});
test('search preserves provider limits and partial failures without inventing results',async()=>{
 const result=await searchPublic('idempotency keys',async(url:string)=>{if(url.includes('wikipedia'))throw Error('offline');return {url,type:'application/json',body:JSON.stringify({items:[{full_name:'example/idempotency',html_url:'https://github.com/example/idempotency',description:'A public example'}]})};});
 assert.equal(result.results.length,1);assert.equal(result.unavailable[0],'Wikipedia');assert.match(result.coverage,/only/);
});
test('registered experiments run in an isolated worker and preserve explicit limitations',async()=>{
 const result=await runExperiment('idempotency_replay',input);assert.equal(result.accepted_unique,1);assert.equal(result.duplicate_suppressed,1);assert.equal(result.changed_payload_rejected,1);assert.match(result.limitation,/sequential/);
 assert.equal(experiment('memory_conflicts',{updates:[{key:'db',value:'old'},{key:'db',value:'new'}]}).stale_first_values,1);
 assert.deepEqual(experiment('text_fact_preservation',{cases:[{input:'After 7 days',output:'After 5 days'}]}).results[0],{case:1,missing:['7'],added:['5']});
 await assert.rejects(runExperiment('run_shell',{code:'process.env'}),/invalid/);assert.throws(()=>experiment('idempotency_replay',{events:Array(101).fill({key:'a',payload:'a'})}));
});
test('autonomous project persists source and experiment receipts and publishes once without admin approval',async()=>{
 const x=fixture(),now=Date.now();try{
 const started=await runResearch(x.store,decide('start',null,{title:'Idempotency receipt experiment',question}),now);assert.equal(started.completed,true);const id=started.created;
 saveArtifact(x.store,String(id),'SEARCH',{results:[{url:'https://example.com/idempotency'}]},now);
 let model=0;await runResearch(x.store,async()=>{model++;throw Error();},now+1);assert.equal(model,0);
 await runResearch(x.store,decide('read',id,{url:'https://example.com/idempotency'}),now+3600001,{read:async(url:string)=>({url,type:'text/plain',body:quote})});
 await runResearch(x.store,decide('experiment',id,{recipe:'idempotency_replay',input}),now+7200002);
 const a=researchSnapshot(x.store,now+7200002).artifacts,source=a.find(a=>a.kind==='SOURCE')!,receipt=a.find(a=>a.kind==='EXPERIMENT')!;
 let posts=0;const fetcher:any=async(url:string,opts:any)=>{if(url.endsWith('/agents/status'))return Response.json({status:'claimed'});assert.ok(url.endsWith('/posts'));posts++;const post=JSON.parse(opts.body);assert.match(post.content,/duplicate_suppressed/);assert.match(post.content,/not a production benchmark/);assert.ok(!post.content.includes('secret-test'));return Response.json({post:{id:'research-post',verification_status:'verified'}});};
 const sent=await runResearch(x.store,decide('publish',id,{source_id:source.id,experiment_id:receipt.id,quote}),now+10800003,{path:x.path,fetcher});assert.equal(sent.status,'PUBLISHED');assert.equal(posts,1);assert.equal(researchSnapshot(x.store,now+10800003).posts[0].status,'PUBLISHED');
 assert.equal((await runResearch(x.store,decide('wait',null,{}),now+14400004)).skipped,true);
 const reopened=openStore(x.dir);try{assert.equal(researchSnapshot(reopened,now+14400004).projects[0].status,'REPORTED');assert.equal(researchSnapshot(reopened).artifacts.length,3);}finally{reopened.db.close();}
 }finally{x.close();}
});
test('bad decisions consume persistent budget but cannot execute unknown tools or leak exception text',async()=>{const x=fixture(),now=Date.now();try{const result=await runResearch(x.store,decide('run_shell',null,{command:'anything'}),now);assert.equal(result.error_code,'research_invalid_decision');assert.equal(researchSnapshot(x.store,now).runs.length,1);assert.equal((await runResearch(x.store,async()=>{throw Error('private provider error');},now+3600001)).error_code,'research_tool_or_model_failed');assert.ok(!JSON.stringify(researchSnapshot(x.store)).includes('private provider error'));}finally{x.close();}});
test('original posts require matching exact source evidence and unmodified execution receipts',()=>{const x=fixture(),now=Date.now();try{researchSnapshot(x.store);x.store.db.prepare("INSERT INTO research_projects(id,title,question,status,created_at,updated_at) VALUES('p','Replay experiment',?,'ACTIVE',?,?)").run(question,now,now);const source=saveArtifact(x.store,'p','SOURCE',{text:quote,url:'https://example.com/docs'},now),receipt=saveArtifact(x.store,'p','EXPERIMENT',{recipe:'idempotency_replay',input,result:experiment('idempotency_replay',input)},now);const project=x.store.db.prepare('SELECT * FROM research_projects').get();assert.throws(()=>researchPost(x.store,project,{source_id:source,experiment_id:receipt,quote:'An invented source excerpt claiming different results.'}),/quote_mismatch/);x.store.db.prepare("UPDATE research_artifacts SET body='{}' WHERE id=?").run(receipt);assert.throws(()=>researchPost(x.store,project,{source_id:source,experiment_id:receipt,quote}),/evidence_missing/);}finally{x.close();}});
test('reflection focuses on current failure and excludes stale unrelated question hypotheses',async()=>{const x=fixture(),now=Date.now();try{x.store.db.prepare("INSERT INTO kestrel_insights(topic,lesson,evidence,updated_at) VALUES('reply_quality','Too many questions are rejected.', '[\"old\"]',1)").run();x.store.db.prepare("INSERT INTO social_generation(id,post_id,started_at,status,error_code) VALUES('g','p',1,'FAILED','reply_unsupported_number')").run();learnFromOutcomes(x.store,now);const result=await reflectOnMemory(x.store,async(_cfg,_task,text)=>{const p=JSON.parse(text);assert.equal(p.reflection_focus,'reply_unsupported_number');assert.equal(p.current_hypotheses.length,0);return {text:JSON.stringify({lessons:[{topic:'reply_quality',lesson:'Omit numerical estimates without supporting measurements in the current source.',evidence:[1]}]}),provider:'ollama',model:'test'};},now);assert.equal(result.learned,1);assert.match(String(x.store.db.prepare('SELECT evidence_snapshot FROM kestrel_reflections').get()?.evidence_snapshot),/unsupported_number/);}finally{x.close();}});

test('reader pins public DNS and revalidates redirect destinations without credentials',async()=>{
 const {EventEmitter}=await import('node:events'),{readPublic}=await import('../src/research-web.ts');let requests=0;
 const net:any={lookup:async()=>[{address:'8.8.8.8',family:4}],get:(_url:any,opts:any,callback:any)=>{requests++;assert.equal(opts.headers.Authorization,undefined);opts.lookup('ignored',{all:true},(error:any,addresses:any)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);});const req:any=new EventEmitter();req.destroy=()=>{};queueMicrotask(()=>{const response:any=new EventEmitter();response.statusCode=302;response.headers={location:'https://127.0.0.1/admin'};response.resume=()=>{req.emit('close');};callback(response);});return req;}};
 await assert.rejects(readPublic('https://example.com/docs',0,net),/ip_url_rejected/);assert.equal(requests,1);
 let called=false;await assert.rejects(readPublic('https://example.com/docs',0,{lookup:async()=>[{address:'10.0.0.1',family:4}],get:(()=>{called=true;}) as any}),/private_network/);assert.equal(called,false);
});
test('research reservation prevents concurrent planning and interrupted work is never completed late',async()=>{const x=fixture(),now=Date.now();try{let finish:any;const pending=new Promise<any>(r=>finish=r);const flight=runResearch(x.store,async()=>pending,now);assert.equal((await runResearch(x.store,decide('start',null,{title:'Concurrent project',question}),now)).skipped,true);x.store.db.prepare("UPDATE research_runs SET status='FAILED',error_code='research_interrupted' WHERE status='RUNNING'").run();finish(await decide('start',null,{title:'Late project',question})());assert.equal((await flight).error_code,'research_paused');assert.equal(researchSnapshot(x.store).projects.length,0);}finally{x.close();}});
test('publishing pause is rechecked after the remote claim check and no post is sent',async()=>{const {publishDraft}=await import('../src/publishing.ts');const x=fixture();try{x.store.db.prepare("INSERT INTO outreach_drafts(id,service_id,body,status) VALUES('p','text-stats','A useful original research note.','APPROVED')").run();let allowed=true,posts=0;const fake:any=async(url:string)=>{if(url.endsWith('/agents/status')){allowed=false;return Response.json({status:'claimed'});}posts++;throw Error();};await assert.rejects(publishDraft(x.store,'p','Original research','agentops',x.path,fake,Date.now(),()=>allowed),/paused/);assert.equal(posts,0);assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM moltbook_publications').get()?.n,0);}finally{x.close();}});

test('existing project continues despite verbose reason and cannot be recreated',async()=>{const x=fixture(),now=Date.now();try{
 const started=await runResearch(x.store,decide('start',null,{title:'Field stripping investigation',question:'Can required fields disappear after a simulated allowlist write?'}),now);
 const id=started.created;
 const repeated=await runResearch(x.store,async(_cfg,_task,text)=>{const context=JSON.parse(text);assert.ok(!context.tools.some((t:any)=>t.action==='start'));assert.equal(context.projects[0].id,id);return decide('start',null,{title:'Renamed field stripping investigation',question:'Can required fields disappear after a simulated allowlist write?'})();},now+3600001);
 assert.equal(repeated.error_code,'research_project_already_active');assert.equal(researchSnapshot(x.store).projects.length,1);
 const result=await runResearch(x.store,async(_cfg,_task,text)=>{assert.match(text,/Continue an existing project/);return {text:JSON.stringify({action:'experiment',project_id:id,reason:'Investigate the saved project using bounded synthetic fixtures. '.repeat(10),args:{recipe:'field_stripping',input:{record:{name:'sample',version:2},allowed_fields:['name'],required_fields:['name','version']}}}),provider:'ollama',model:'test'};},now+7200002);
 assert.equal(result.completed,true);const artifact=researchSnapshot(x.store).artifacts[0];assert.equal(JSON.parse(String(artifact.body)).result.pre_write_validation_missed_loss,true);assert.equal(String(researchSnapshot(x.store).runs[0].reason).length,400);
 }finally{x.close();}});
test('field stripping distinguishes actual loss from an already invalid input and a preserving write',async()=>{
 const input={record:{name:'sample',version:2},allowed_fields:['name'],required_fields:['name','version']};
 const result=await runExperiment('field_stripping',input);assert.deepEqual(result.stripped_fields,['version']);assert.deepEqual(result.missing_after,['version']);assert.equal(result.pre_write_valid,true);assert.equal(result.stored_valid,false);assert.match(result.limitation,/no external API/);
 assert.equal(experiment('field_stripping',{...input,allowed_fields:['name','version']}).pre_write_validation_missed_loss,false);
 assert.equal(experiment('field_stripping',{...input,record:{name:'sample'}}).pre_write_validation_missed_loss,false);
 assert.throws(()=>experiment('field_stripping',{...input,required_fields:['__proto__']}),/invalid/);
});

test('both live malformed experiment requests execute once with recorded local normalization',async()=>{
 for(const wrapped of [false,true]){
 const x=fixture(),now=Date.now();try{
 const start=await runResearch(x.store,decide('start',null,{title:'Field stripping regression',question:'Can a simulated write remove fields after successful validation?'}),now);
 const fixtureInput={record:{name:'sample',version:2},allowed_fields:['name'],required_fields:['name','version']};
 let calls=0;
 const result=await runResearch(x.store,async(_cfg,_task,text)=>{calls++;const c=JSON.parse(text),tool=c.tools.find((t:any)=>t.action==='experiment');assert.equal(tool.args.recipe.type,'string');assert.equal(tool.args.input.type,'object');return decide('experiment',start.created,{recipe:['field_stripping'],input:wrapped?{field_stripping:fixtureInput}:fixtureInput})();},now+3600001);
 assert.equal(result.completed,true);assert.equal(calls,1);
 const receipts=researchSnapshot(x.store).artifacts;assert.equal(receipts.length,1);const receipt=JSON.parse(String(receipts[0].body));assert.deepEqual(receipt.input,fixtureInput);assert.equal(receipt.recipe,'field_stripping');assert.equal(receipt.result.pre_write_validation_missed_loss,true);assert.deepEqual(receipt.normalizations,wrapped?['single_recipe_array_unwrapped','recipe_input_wrapper_removed']:['single_recipe_array_unwrapped']);
 }finally{x.close();}
 }
});
test('ambiguous recipes and malformed inputs fail precisely and inform the next decision',async()=>{
 const {experimentArguments}=await import('../src/research.ts');
 for(const recipe of [[],['field_stripping','memory_conflicts'],'invented_recipe',[['field_stripping']]])assert.throws(()=>experimentArguments({recipe,input:{}}),/research_invalid_recipe/);
 for(const input of [null,[],{field_stripping:null}])assert.throws(()=>experimentArguments({recipe:'field_stripping',input}),/research_invalid_experiment_input/);
 const x=fixture(),now=Date.now();try{
 const start=await runResearch(x.store,decide('start',null,{title:'Invalid recipe regression',question:'Can invalid tool requests produce actionable feedback?'}),now);
 let effects=0;
 const bad=await runResearch(x.store,decide('experiment',start.created,{recipe:['field_stripping','memory_conflicts'],input:{}}),now+3600001,{experiment:async()=>{effects++;throw Error('should not execute');}});
 assert.equal(bad.error_code,'research_invalid_recipe');assert.equal(effects,0);
 await runResearch(x.store,async(_cfg,_task,text)=>{assert.match(text,/must be one registered recipe name as a string/);return decide('wait',null,{})();},now+7200002);
 }finally{x.close();}
});

test('one-time five-attempt test allowance preserves history and original normal resumption',async()=>{
 const {grantResearchTestAllowance}=await import('../src/research.ts');const x=fixture(),now=Date.parse('2026-10-15T12:54:05Z');
 try{
 for(let i=0;i<4;i++)await runResearch(x.store,decide('wait',null,{}),now+i*3600001);
 const grantAt=Date.parse('2026-10-15T16:15:00Z');
 assert.equal(grantResearchTestAllowance(x.store,grantAt).test_attempts_remaining,5);
 assert.throws(()=>grantResearchTestAllowance(x.store,grantAt),/already_granted/);
 for(let i=0;i<5;i++){const at=grantAt+i*3600001;assert.equal((await runResearch(x.store,decide('wait',null,{}),at)).completed,true);if(i<4)assert.equal((await runResearch(x.store,decide('wait',null,{}),at+1)).skipped,true);}
 assert.equal((await runResearch(x.store,decide('wait',null,{}),grantAt+5*3600001)).skipped,true);
 const state=researchSnapshot(x.store,Date.parse('2026-10-15T21:01:00Z'));assert.equal(state.runs.length,9);assert.equal(state.next_eligible_at,now+86400000);assert.equal(state.test_attempts_remaining,0);
 assert.equal((await runResearch(x.store,decide('wait',null,{}),now+86400001)).completed,true);
 }finally{x.close();}
});

test('research discovers real sources and remembers failed reads without repeating network effects',async()=>{
 const x=fixture(),now=Date.now();try{
 const start=await runResearch(x.store,decide('start',null,{title:'Source discovery regression',question:'Can research recover from an unavailable documentation source?'}),now);const id=String(start.created);
 let reads=0;
 const placeholder=await runResearch(x.store,async(_cfg,_task,text)=>{const c=JSON.parse(text);assert.equal(c.available_source_urls.length,0);assert.ok(!c.tools.some((t:any)=>t.action==='read'));assert.ok(!text.includes('https://public-source'));return decide('read',id,{url:'https://public-source'})();},now+3600001,{read:async()=>{reads++;throw Error();}});
 assert.equal(placeholder.error_code,'research_placeholder_url');assert.equal(reads,0);
 await runResearch(x.store,decide('search',id,{query:'API required field validation'}),now+7200002,{search:async()=>({query:'API required field validation',results:[{url:'https://docs.example.org/schema',title:'Schema documentation'}],unavailable:[],coverage:'test'})});
 const failed=await runResearch(x.store,async(_cfg,_task,text)=>{assert.match(text,/placeholder, not a real source/);assert.match(text,/https:\/\/docs.example.org\/schema/);return decide('read',id,{url:'https://docs.example.org/schema'})();},now+10800003,{read:async()=>{reads++;throw Error('research_dns_failed');}});
 assert.equal(failed.error_code,'research_dns_failed');
 const repeated=await runResearch(x.store,async(_cfg,_task,text)=>{const c=JSON.parse(text);assert.equal(c.available_source_urls.length,0);assert.ok(!c.tools.some((t:any)=>t.action==='read'));assert.match(text,/research_dns_failed/);return decide('read',id,{url:'https://docs.example.org/schema'})();},now+86400001,{read:async()=>{reads++;throw Error();}});
 assert.equal(repeated.error_code,'research_read_repeated');assert.equal(reads,1);
 assert.equal(x.store.db.prepare("SELECT count(*) AS n FROM kestrel_experience WHERE source='research'").get()?.n,5);
 }finally{x.close();}
});
test('DNS failure retains a specific safe error instead of raw resolver details',async()=>{
 const {readPublic}=await import('../src/research-web.ts');
 await assert.rejects(readPublic('https://docs.example.org/schema',0,{lookup:async()=>{throw Error('resolver private details');}}),/^Error: research_dns_failed$/);
 assert.throws(()=>publicURL('https://public-source'),/research_placeholder_url/);
});
