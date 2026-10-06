import type {openStore} from './store.ts';
import {generate,ModelError} from './models.ts';
import {hash} from './store.ts';
type Store=ReturnType<typeof openStore>;
export const coreTools=[{id:'inspect_health',effect:'read',description:'Read worker heartbeat, queue and service availability'},{id:'inspect_jobs',effect:'read',description:'Aggregate job outcomes without customer inputs or results'},{id:'inspect_onboarding',effect:'read',description:'Measure registrations and first-job conversion without account details'}];
export function coreEvidence(store:Store,tool:string,now=Date.now()){
 const db=store.db;
 if(tool==='inspect_health')return {observed_at:now,worker:db.prepare('SELECT heartbeat,status FROM operator_state WHERE id=1').get(),queued:Number(db.prepare("SELECT count(*) AS n FROM jobs WHERE status='QUEUED'").get()?.n),services:db.prepare('SELECT active,count(*) AS count FROM services GROUP BY active').all()};
 if(tool==='inspect_jobs')return {observed_at:now,outcomes:db.prepare('SELECT status,count(*) AS count FROM jobs GROUP BY status').all(),failures:db.prepare("SELECT error_code,count(*) AS count FROM operator_runs WHERE status='FAILED' GROUP BY error_code LIMIT 20").all()};
 if(tool==='inspect_onboarding')return {observed_at:now,registrations:Number(db.prepare('SELECT count(*) AS n FROM agents').get()?.n),agents_with_jobs:Number(db.prepare('SELECT count(DISTINCT buyer_id) AS n FROM jobs').get()?.n),completed:Number(db.prepare("SELECT count(*) AS n FROM jobs WHERE status='COMPLETED'").get()?.n)};
 throw Error('core_unknown_tool');
}
const projectTools:Record<string,string[]>={exchange_health:['inspect_health','inspect_jobs'],customer_delivery:['inspect_jobs'],agent_onboarding:['inspect_onboarding']};
function stableEvidence(tool:string,evidence:any,now:number){
 if(tool==='inspect_health')return {queued:evidence.queued,services:evidence.services,worker_status:evidence.worker?.status||'unknown',heartbeat_health:evidence.worker?.heartbeat!=null&&now-Number(evidence.worker.heartbeat)<90000?'fresh':'stale'};
 const {observed_at,...data}=evidence;return data;
}
function fingerprint(store:Store,project:string,now:number){return hash(JSON.stringify(Object.fromEntries((projectTools[project]||[]).map(t=>[t,stableEvidence(t,coreEvidence(store,t,now),now)]))));}
export function eligibleProjects(store:Store,now=Date.now()){
 return store.db.prepare('SELECT * FROM kestrel_projects ORDER BY updated_at,id').all().filter(p=>{
  const previous=store.db.prepare("SELECT inspection_fingerprint,evidence,started_at FROM kestrel_tasks WHERE project_id=? AND status='COMPLETED' ORDER BY started_at DESC LIMIT 1").get(p.id);
  if(!previous)return true;
  let previousHash=previous.inspection_fingerprint;
  if(!previousHash&&previous.evidence){try{const evidence=JSON.parse(String(previous.evidence)),tools=projectTools[String(p.id)]||[];if(tools.every(t=>evidence[t]))previousHash=hash(JSON.stringify(Object.fromEntries(tools.map(t=>[t,stableEvidence(t,evidence[t],Number(previous.started_at))]))));}catch{}}
  return previousHash!==fingerprint(store,String(p.id),now);
 });
}
export function recoverCore(store:Store,now=Date.now()){
 const changed=store.db.prepare("UPDATE kestrel_tasks SET status='FAILED',error_code='core_interrupted',finished_at=? WHERE status='RUNNING' AND started_at<?").run(now,now-600000).changes;
 for(const t of store.db.prepare("SELECT id,error_code FROM kestrel_tasks WHERE status='FAILED' AND error_code='core_interrupted' ORDER BY started_at DESC LIMIT 30").all())store.db.prepare('INSERT OR IGNORE INTO kestrel_experience(id,source,kind,observation,observed_at) VALUES(?,?,?,?,?)').run('core:'+t.id,'agent-core','core_inspection_failed',JSON.stringify({code:t.error_code}),now);
 return changed;
}
export function coreSnapshot(store:Store,now=Date.now()){
 const attempts=store.db.prepare('SELECT count(*) AS n,max(started_at) AS last,min(started_at) AS first FROM kestrel_tasks WHERE started_at>=?').get(now-86400000)!;
 const eligible=eligibleProjects(store,now);
 const cfg=store.settings(),running=store.db.prepare("SELECT id FROM kestrel_tasks WHERE status='RUNNING' LIMIT 1").get();
 const next=Math.max(Number(attempts.n)>=2?Number(attempts.first)+86400000:0,attempts.last?Number(attempts.last)+3600000:0);
 return {eligible_project_ids:eligible.map(p=>p.id),tools:coreTools,projects:store.db.prepare('SELECT * FROM kestrel_projects ORDER BY updated_at DESC').all(),tasks:store.db.prepare('SELECT * FROM kestrel_tasks ORDER BY started_at DESC LIMIT 30').all(),limits:{model_calls:2,window_hours:24,minimum_interval_minutes:60},waiting_reason:!cfg.enabled?'model_processing_paused':running?'task_running':Number(attempts.n)>=2?'core_daily_limit':next>now?'core_cooldown':!eligible.length?'no_changed_evidence':'eligible',next_eligible_at:next>now?next:null};
}
export async function runAgentCore(store:Store,generateText=generate,now=Date.now()){
 recoverCore(store,now);
 const claim=store.transaction(()=>{
  const cfg=store.settings(),state=coreSnapshot(store,now);
  if(state.waiting_reason!=='eligible'||store.db.prepare("SELECT id FROM jobs WHERE status='QUEUED' LIMIT 1").get())return null;
  const id=crypto.randomUUID();store.db.prepare("INSERT INTO kestrel_tasks(id,status,started_at) VALUES(?,'RUNNING',?)").run(id,now);return {id,cfg,state};
 });if(!claim)return {skipped:true};
 try{
  const observations=Object.fromEntries(coreTools.map(t=>[t.id,coreEvidence(store,t.id,now)]));
  const lessons=store.db.prepare("SELECT topic,lesson FROM kestrel_insights i WHERE NOT EXISTS(SELECT 1 FROM kestrel_insight_checks c WHERE c.topic=i.topic AND c.status='CONTRADICTED') LIMIT 4").all();
  const prior=claim.state.tasks.slice(0,3).map(t=>({project:t.project_id,status:t.status,error:t.error_code,plan:t.plan?String(t.plan).slice(0,1200):null}));
  const eligible=claim.state.projects.filter(p=>claim.state.eligible_project_ids.includes(p.id));
  const input=JSON.stringify({projects:eligible.map(p=>({...p,required_tools:projectTools[String(p.id)]})),eligible_project_ids:claim.state.eligible_project_ids,observation_limitations:'Aggregate historic failures do not prove current degradation or causation. Repeated unchanged observations are not progress.',tools:coreTools,observations,prior,fallible_lessons:lessons});if(input.length>12000)throw Error('core_context_limit');
  const result=await generateText({provider:claim.cfg.provider,model:claim.cfg.model,ollamaUrl:process.env.OLLAMA_URL,openaiKey:process.env.OPENAI_API_KEY},'agent-plan',input);
  let plan:any;try{plan=JSON.parse(result.text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1'));}catch{throw Error('core_invalid_plan');}
  if(!plan||Object.keys(plan).sort().join(',')!=='next_step,project_id,reason,tools'||!claim.state.eligible_project_ids.includes(plan.project_id)||!Array.isArray(plan.tools)||!plan.tools.length||plan.tools.length>3||new Set(plan.tools).size!==plan.tools.length||!plan.tools.every((t:unknown)=>coreTools.some(tool=>tool.id===t))||!(projectTools[plan.project_id]||[]).every(t=>plan.tools.includes(t))||![plan.reason,plan.next_step].every(t=>typeof t==='string'&&t.length>=10&&t.length<=600))throw Error('core_invalid_plan');
  // The model selects work. Only registered tools execute; prose never becomes code.
  const evidence=Object.fromEntries(plan.tools.map((t:string)=>[t,coreEvidence(store,t,Date.now())]));
  const serialized=JSON.stringify(evidence),digest=hash(serialized),finished=Date.now();
  const completed=store.transaction(()=>{
   if(!store.settings().enabled||store.db.prepare('SELECT status FROM kestrel_tasks WHERE id=?').get(claim.id)?.status!=='RUNNING')return false;
   store.db.prepare("UPDATE kestrel_tasks SET project_id=?,plan=?,evidence=?,evidence_hash=?,inspection_fingerprint=?,status='COMPLETED',finished_at=? WHERE id=? AND status='RUNNING'").run(plan.project_id,JSON.stringify(plan),serialized,digest,fingerprint(store,plan.project_id,finished),finished,claim.id);
   const saved=store.db.prepare('SELECT evidence,evidence_hash FROM kestrel_tasks WHERE id=?').get(claim.id)!;if(hash(String(saved.evidence))!==saved.evidence_hash)throw Error('core_evidence_mismatch');
   store.db.prepare('UPDATE kestrel_projects SET next_step=?,updated_at=? WHERE id=?').run(plan.next_step,finished,plan.project_id);
   store.db.prepare('INSERT OR IGNORE INTO kestrel_experience(id,source,kind,observation,observed_at) VALUES(?,?,?,?,?)').run('core:'+claim.id,'agent-core','core_inspection_completed',JSON.stringify({project:plan.project_id,tools:plan.tools,evidence_hash:digest,limitation:'Inspection completed; proposed improvements are not implemented.'}),finished);
   return true;
  });
  if(!completed)store.db.prepare("UPDATE kestrel_tasks SET status='FAILED',error_code='core_paused',finished_at=? WHERE id=? AND status='RUNNING'").run(finished,claim.id);
  return {completed,id:claim.id};
 }catch(e){const code=e instanceof Error&&['core_context_limit','core_invalid_plan','core_evidence_mismatch'].includes(e.message)?e.message:e instanceof ModelError?'core_model_failed':'core_execution_failed';store.db.prepare("UPDATE kestrel_tasks SET status='FAILED',error_code=?,finished_at=? WHERE id=? AND status='RUNNING'").run(code,Date.now(),claim.id);store.db.prepare('INSERT OR IGNORE INTO kestrel_experience(id,source,kind,observation,observed_at) VALUES(?,?,?,?,?)').run('core:'+claim.id,'agent-core','core_inspection_failed',JSON.stringify({code}),Date.now());return {error_code:code};}
}
