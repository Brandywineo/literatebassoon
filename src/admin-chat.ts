import {coreSnapshot} from './agent-core.ts';
import {planningSnapshot} from './planning.ts';
import type {openStore} from './store.ts';
import {generate,ModelError} from './models.ts';
import {autonomyStatus} from './social-autonomy.ts';
type Store=ReturnType<typeof openStore>;
export function chatHistory(store:Store){return store.db.prepare('SELECT id,request_key,body,status,response,error_code,created_at,finished_at FROM kestrel_chat ORDER BY rowid DESC LIMIT 100').all().reverse();}
export function queueChat(store:Store,body:unknown,key:unknown,now=Date.now()){
 if(typeof body!=='string'||body.trim().length<1||body.length>2000)throw Error('Message must be 1–2000 characters');
 if(typeof key!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(key))throw Error('Valid request key required');
 return store.transaction(()=>{
  const existing=store.db.prepare('SELECT * FROM kestrel_chat WHERE request_key=?').get(key);
  if(existing){if(existing.body!==body.trim())throw Error('Request key already used for a different message');return {id:existing.id,status:existing.status};}
  if(Number(store.db.prepare("SELECT count(*) AS n FROM kestrel_chat WHERE status IN ('QUEUED','PROCESSING')").get()?.n)>=5)throw Error('Chat queue full; wait for Kestrel');
  const id=crypto.randomUUID();store.db.prepare("INSERT INTO kestrel_chat(id,request_key,body,status,created_at) VALUES(?,?,?,'QUEUED',?)").run(id,key,body.trim(),now);return {id,status:'QUEUED'};
 });
}
export function chatStatusFacts(store:Store,now=Date.now()){
 const status=autonomyStatus(store,now),next=status.next_eligible_at;
 const lifetime=store.db.prepare("SELECT count(*) AS attempted,sum(CASE WHEN v.visibility='VISIBLE' THEN 1 ELSE 0 END) AS visible,sum(CASE WHEN r.status='PUBLISHED' OR v.verification_status='verified' THEN 1 ELSE 0 END) AS verified FROM social_replies r LEFT JOIN social_visibility v ON v.reply_id=r.id WHERE r.attempted_at IS NOT NULL OR r.status='PUBLISHED' OR v.verification_status='verified'").get()!;
 return {observed_at:new Date(now).toISOString(),window:'rolling last 24 hours, not lifetime totals',waiting_reason:status.waiting_reason,
 lifetime_replies:{attempted:Number(lifetime.attempted),last_observed_visible:Number(lifetime.visible||0),verified:Number(lifetime.verified||0)},generation_attempts:status.generation_attempts,reply_write_attempts:status.reply_attempts,visible_replies:status.visible_replies,verified_replies:status.verified_replies,
 next_eligible_utc:next==null?null:new Date(next).toISOString(),next_eligible_eat:next==null?null:new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Nairobi',dateStyle:'medium',timeStyle:'medium'}).format(next)+' EAT',
 verified_count_summary:`Verified replies in the rolling last 24 hours: ${status.verified_replies}. Verified replies across all stored history: ${Number(lifetime.verified||0)}. These are separate counts; never substitute the recent count for the lifetime count.`,
 seconds_until_eligible:next==null?null:Math.max(0,Math.ceil((next-now)/1000)),
 interpretation:'Generation attempts and reply writes have separate limits. A 24-hour rolling window does not mean a fresh 24-hour wait. Eligibility is an estimate, not a promise of publication. Zero verified replies describes this window only. Visibility is separate from verification, accuracy and usefulness. A previous verification failure does not prove verification is currently blocked.'};
}
export async function runAdminChat(store:Store,generateText=generate,now=Date.now()){
 const claim=store.transaction(()=>{
  // A crashed request is visibly failed; it is never silently regenerated.
  store.db.prepare("UPDATE kestrel_chat SET status='FAILED',error_code='chat_interrupted',finished_at=? WHERE status='PROCESSING' AND started_at<?").run(now,now-600000);
  const cfg=store.settings();if(!cfg.enabled||store.db.prepare("SELECT id FROM jobs WHERE status='QUEUED' LIMIT 1").get()||store.db.prepare("SELECT id FROM kestrel_chat WHERE status='PROCESSING' LIMIT 1").get())return null;
  const attempts=Number(store.db.prepare('SELECT count(*) AS n FROM kestrel_chat WHERE started_at>=?').get(now-86400000)?.n);
  if(attempts>=20)return null;
  const row=store.db.prepare("SELECT * FROM kestrel_chat WHERE status='QUEUED' ORDER BY rowid LIMIT 1").get();if(!row)return null;
  store.db.prepare("UPDATE kestrel_chat SET status='PROCESSING',started_at=? WHERE id=? AND status='QUEUED'").run(now,row.id);return {row,cfg};
 });if(!claim)return false;
 try{
  const {row,cfg}=claim;
  const state={agent_core:{projects:coreSnapshot(store,now).projects,waiting_reason:coreSnapshot(store,now).waiting_reason,tasks:coreSnapshot(store,now).tasks.slice(0,2).map(t=>({project:t.project_id,status:t.status,error:t.error_code,plan:t.plan?String(t.plan).slice(0,900):null}))},status_facts:chatStatusFacts(store,now),goals:planningSnapshot(store).goals,observed_at:new Date(now).toISOString(),operator:store.db.prepare('SELECT heartbeat,status FROM operator_state WHERE id=1').get(),autonomy:autonomyStatus(store,now),jobs:store.db.prepare('SELECT status,count(*) AS count FROM jobs GROUP BY status').all(),discovery:store.db.prepare('SELECT checked_at,completed_at,error_code FROM social_scan WHERE id=1').get(),reflections:store.db.prepare('SELECT started_at,status,error_code FROM kestrel_reflections ORDER BY started_at DESC LIMIT 3').all()};
  const history=store.db.prepare("SELECT body,response FROM kestrel_chat WHERE status='ANSWERED' AND created_at<=? AND id<>? ORDER BY rowid DESC LIMIT 6").all(row.created_at,row.id).reverse().map(r=>({Admin:String(r.body).slice(0,500),Kestrel:String(r.response).slice(0,600)}));
  const memory=store.db.prepare("SELECT i.topic,i.lesson FROM kestrel_insights i LEFT JOIN kestrel_insight_checks c ON c.topic=i.topic WHERE c.status IS NULL OR c.status<>'CONTRADICTED' ORDER BY i.updated_at DESC LIMIT 3").all();
  const context={live_state:state,fallible_memory:memory,history,message:{sender:'Admin',body:row.body}};
  let input=JSON.stringify(context);while(input.length>12000&&context.history.length){context.history.shift();input=JSON.stringify(context);}while(input.length>12000&&context.fallible_memory.length){context.fallible_memory.pop();input=JSON.stringify(context);}if(input.length>12000)throw Error('chat_context_too_large');
  const result=await generateText({provider:cfg.provider,model:cfg.model,ollamaUrl:process.env.OLLAMA_URL,openaiKey:process.env.OPENAI_API_KEY},'admin-chat',input);
  if(!result.text.trim()||result.text.length>6000)throw Error('invalid_chat_response');
  store.db.prepare("UPDATE kestrel_chat SET status='ANSWERED',response=?,finished_at=? WHERE id=? AND status='PROCESSING'").run(result.text,Date.now(),row.id);return true;
 }catch(error){const code=error instanceof ModelError&&/^(?:http_\d{3}|empty_response|incomplete_response|response_too_large|rate_limit_exceeded|insufficient_quota|invalid_api_key|model_not_found)$/.test(error.message)?'chat_'+error.message:error instanceof Error&&error.name==='TimeoutError'?'chat_timeout':'chat_generation_failed';store.db.prepare("UPDATE kestrel_chat SET status='FAILED',error_code=?,finished_at=? WHERE id=? AND status='PROCESSING'").run(code,Date.now(),claim.row.id);return true;}
}
