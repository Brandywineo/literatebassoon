import type { openStore } from './store.ts';
type Store=ReturnType<typeof openStore>;
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
  const snapshot={checked_at:now,queue:{queued:Number(queue.queued),oldest_seconds:Math.round(Number(queue.oldest_seconds))},runs:{attempts:Number(runs.attempts),completed:Number(runs.completed||0),failed:Number(runs.failed||0),running:Number(runs.running||0),average_seconds:runs.average_ms==null?null:Math.round(Number(runs.average_ms)/100)/10},failures,alerts};
  const signature=JSON.stringify({queued:snapshot.queue.queued,runs:snapshot.runs,failures,alerts});
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
