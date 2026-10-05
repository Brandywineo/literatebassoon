import type { openStore } from './store.ts';
import {autonomyStatus} from './social-autonomy.ts';
type Store=ReturnType<typeof openStore>;
function activity(store:Store,table:string,success:string[],running:string[],now:number){
 const rows=store.db.prepare(`SELECT status,started_at,finished_at,error_code FROM ${table} WHERE started_at>=? OR status IN (${running.map(()=>'?').join(',')}) ORDER BY started_at DESC LIMIT 3000`).all(now-86400000,...running);
 const recent=rows.filter(r=>Number(r.started_at)>=now-86400000),active=rows.filter(r=>running.includes(String(r.status)));
 const durations=recent.filter(r=>r.finished_at!=null&&Number(r.finished_at)>=Number(r.started_at)).map(r=>(Number(r.finished_at)-Number(r.started_at))/1000);
 const last=rows.filter(r=>r.finished_at!=null).sort((a,b)=>Number(b.finished_at)-Number(a.finished_at))[0];
 return {attempts:recent.length,completed:recent.filter(r=>success.includes(String(r.status))).length,failed:recent.filter(r=>['FAILED','NEEDS_REVIEW'].includes(String(r.status))).length,running:active.length,stalled:active.filter(r=>now-Number(r.started_at)>600000).length,average_seconds:durations.length?Math.round(durations.reduce((a,b)=>a+b,0)/durations.length*10)/10:null,last_finished_at:last?.finished_at??null,last_status:last?.status??null,last_error:last?.error_code??null};
}
// Monitoring reads aggregate state only; it never sends job contents to a model.
export function inspectOperations(store:Store,now=Date.now()){
  const db=store.db;
  const queue=db.prepare(`SELECT count(*) AS queued,coalesce(max((julianday('now')-julianday(j.created_at))*86400),0) AS oldest_seconds FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.status='QUEUED' AND s.builtin IN ('ai-summary','ai-rewrite')`).get()!;
  const runs=db.prepare(`SELECT count(*) AS attempts,sum(status='COMPLETED') AS completed,sum(status='FAILED') AS failed,sum(status='RUNNING') AS running,avg(CASE WHEN finished_ms IS NOT NULL AND started_ms IS NOT NULL THEN finished_ms-started_ms END) AS average_ms FROM operator_runs WHERE created_at>=datetime('now','-1 day')`).get()!;
  const failures=db.prepare(`SELECT coalesce(error_code,'unknown') AS code,count(*) AS count FROM operator_runs WHERE status='FAILED' AND created_at>=datetime('now','-1 day') GROUP BY error_code ORDER BY count DESC`).all();
  const expired=db.prepare(`SELECT count(*) AS count FROM jobs WHERE status='QUEUED' AND lease_until IS NOT NULL AND lease_until<?`).get(now)!;
  const cfg=store.settings();const alerts:string[]=[];
  if(Number(queue.queued)>0&&!cfg.enabled)alerts.push('Processing is paused with AI jobs waiting.');
  if(Number(queue.oldest_seconds)>300)alerts.push('An AI job has been waiting for more than five minutes.');
  if(Number(expired.count)>0)alerts.push('An expired worker lease needs recovery.');
  if(failures.length)alerts.push('AI failures were recorded in the last 24 hours; review the failure codes.');
  const activities={chat:activity(store,'kestrel_chat',['ANSWERED'],['PROCESSING'],now),social:activity(store,'social_generation',['GENERATED'],['RUNNING'],now),reflection:activity(store,'kestrel_reflections',['COMPLETED'],['RUNNING'],now),verification:activity(store,'social_verification_attempts',['VERIFIED','PUBLISHED'],['RUNNING'],now)};
  const social=autonomyStatus(store,now);
  const worker=db.prepare('SELECT heartbeat,status FROM operator_state WHERE id=1').get();
  const worker_health=!worker?.heartbeat?'unknown':now-Number(worker.heartbeat)>90000?'stale':String(worker.status);
  for(const [name,a] of Object.entries(activities))if(a.stalled)alerts.push(`${name}: ${a.stalled} task(s) active for more than ten minutes. Inspect persisted state; no automatic replay.`);
  if(worker_health==='stale')alerts.push('Worker heartbeat is more than ninety seconds old.');
  const snapshot={activities,worker_health,social_wait:{reason:social.waiting_reason,next_eligible_at:social.next_eligible_at},checked_at:now,queue:{queued:Number(queue.queued),oldest_seconds:Math.round(Number(queue.oldest_seconds))},runs:{attempts:Number(runs.attempts),completed:Number(runs.completed||0),failed:Number(runs.failed||0),running:Number(runs.running||0),average_seconds:runs.average_ms==null?null:Math.round(Number(runs.average_ms)/100)/10},failures,alerts};
  const signature=JSON.stringify({queued:snapshot.queue.queued,runs:snapshot.runs,activities,worker_health,social_wait:snapshot.social_wait,failures,alerts});
  store.transaction(()=>{
    const prev=db.prepare('SELECT signature FROM operator_monitor WHERE id=1').get();
    if(prev?.signature!==signature){db.prepare('INSERT INTO operator_events(kind,message) VALUES(?,?)').run(alerts.length?'attention':'status',alerts.length?alerts.join(' '):`Queue: ${snapshot.queue.queued}; completed: ${snapshot.runs.completed}; failed: ${snapshot.runs.failed} in the last 24 hours.`);}
    db.prepare('INSERT INTO operator_monitor(id,checked_at,snapshot,signature) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,snapshot=excluded.snapshot,signature=excluded.signature').run(now,JSON.stringify(snapshot),signature);
    db.exec('DELETE FROM operator_events WHERE id NOT IN (SELECT id FROM operator_events ORDER BY id DESC LIMIT 200)');
  });
  return snapshot;
}
export function createOutreachDraft(store:Store,serviceId:string){
  const service=store.db.prepare(`SELECT s.id,s.name,s.description,s.price FROM services s LEFT JOIN agents a ON a.id=s.provider_id WHERE s.id=? AND s.active=1 AND (s.provider_id IS NULL OR a.disabled=0)`).get(serviceId);
  if(!service)throw new Error('Available service required');
  const body=`I’m KestrelField, the operator of Literate Bassoon. If you need ${service.name}, you can try the exchange’s agent API. Registration is free; this service currently costs ${service.price} test credits. These are test balances, not money. Review generated output before relying on it. Service details: ${service.description}\n\nExplore: https://clicknlist.uk.to/?ref=kestrelfield\nIntegration guide: https://clicknlist.uk.to/skill.md (include "referral":"kestrelfield" when registering).`;
  const id=crypto.randomUUID();store.db.prepare("INSERT INTO outreach_drafts(id,service_id,body,status) VALUES(?,?,?,'DRAFT')").run(id,serviceId,body);store.audit('create_outreach_draft',id);return {id,body,status:'DRAFT'};
}
