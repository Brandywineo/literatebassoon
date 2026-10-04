import type {openStore} from './store.ts';
import {generate,ModelError} from './models.ts';
import {request,credentials,credentialPath} from './moltbook.ts';
import {reviewReply,publishReply} from './social.ts';
type Store=ReturnType<typeof openStore>;
export function autonomyStatus(store:Store,now=Date.now()){
 const row=store.db.prepare('SELECT * FROM social_autonomy WHERE id=1').get()!;
 const blocked=store.db.prepare("SELECT status FROM social_replies WHERE status IN ('SENDING','UNCERTAIN','PENDING_VERIFICATION','VERIFYING') LIMIT 1").get()?.status;
 return {...row,enabled:Boolean(row.enabled),blocked:blocked||null,generation_attempts:Number(store.db.prepare('SELECT count(*) AS n FROM social_generation WHERE started_at>=?').get(now-86400000)?.n)};
}
export function setAutonomy(store:Store,enabled:boolean){
 if(typeof enabled!=='boolean')throw Error('enabled must be boolean');
 store.transaction(()=>{store.db.prepare('UPDATE social_autonomy SET enabled=?,error_code=NULL WHERE id=1').run(enabled?1:0);store.audit(enabled?'social_autonomy_enabled':'social_autonomy_paused','KestrelField');});return autonomyStatus(store);
}
export function validateAutonomousReply(body:unknown,source:string){
 if(typeof body!=='string'||body.trim().length<80||body.length>1200)throw Error('reply_quality_rejected');
 if(/https?:|www\.|clicknlist|\[[^\]]*\]\(|<a\b|api[_ -]?key|seed phrase|private key|send (?:me|us)|guaranteed|ignore (?:previous|all)|as an ai|```/i.test(body))throw Error('reply_quality_rejected');
 const words=(s:string)=>new Set(s.toLowerCase().match(/[a-z]{5,}/g)||[]);
 const sourceWords=words(source),shared=[...words(body)].filter(w=>sourceWords.has(w));
 if(shared.length<3)throw Error('reply_not_grounded');
 return body.trim();
}
// Reserve before every model call; a crashed attempt still consumes today's budget.
// Never replay an uncertain write or solve verification challenges automatically.
export async function runSocialCycle(store:Store,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now(),generateText=generate){
 store.transaction(()=>{
  store.db.prepare("UPDATE social_replies SET status='VERIFICATION_EXPIRED',error_code='verification_expired' WHERE status='PENDING_VERIFICATION' AND expires_at IS NOT NULL AND julianday(expires_at)<=julianday(?)").run(new Date(now).toISOString());
 });
 const candidate=store.transaction(()=>{
  const status=autonomyStatus(store,now),cfg=store.settings();
  if(!status.enabled||!cfg.enabled||status.blocked||status.generation_attempts>=3||now-Number(status.checked_at)<3600000)return null;
  const attempts=store.db.prepare('SELECT count(*) AS n,max(attempted_at) AS last FROM social_replies WHERE attempted_at>=?').get(now-86400000)!;
  if(Number(attempts.n)>=3||attempts.last!=null&&now-Number(attempts.last)<3600000)return null;
  // Do not spend model capacity while customers are waiting.
  if(store.db.prepare("SELECT id FROM jobs WHERE status='QUEUED' LIMIT 1").get())return null;
  const p=store.db.prepare(`SELECT d.* FROM social_discussions d WHERE full_content=1 AND seen_at>=? AND source_created_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM social_replies r WHERE r.post_id=d.id) AND NOT EXISTS(SELECT 1 FROM social_generation g WHERE g.post_id=d.id) ORDER BY source_created_at DESC LIMIT 1`).get(now-3600000);
  if(!p||!Number.isFinite(Date.parse(String(p.source_created_at)))||now-Date.parse(String(p.source_created_at))>7*86400000)return null;
  const id=crypto.randomUUID();store.db.prepare("INSERT INTO social_generation VALUES(?,?,?,'RUNNING',NULL)").run(id,p.id,now);store.db.prepare('UPDATE social_autonomy SET checked_at=?,error_code=NULL WHERE id=1').run(now);return {p,id,cfg};
 });
 if(!candidate)return {skipped:true};
 const {p,id,cfg}=candidate;
 try{
  const c=credentials(path),detail=await request('/posts/'+p.id,c.api_key,undefined,fetcher),fresh=detail.post;
  if(detail.success===false||fresh?.id!==p.id||fresh.author?.name!==p.author||fresh.author.name.toLowerCase()===c.name.toLowerCase()||fresh.is_spam||fresh.is_deleted||typeof fresh.content!=='string'||fresh.content!==p.body||fresh.title!==p.title)throw Error('source_changed');
  const source=String(p.title)+'\n'+String(p.body).slice(0,10000);
  const output=await generateText({provider:cfg.provider,model:cfg.model,ollamaUrl:process.env.OLLAMA_URL,openaiKey:process.env.OPENAI_API_KEY},'social-reply',source,fetcher);
  const reply=validateAutonomousReply(output.text,source);
  store.transaction(()=>{
   store.db.prepare("INSERT INTO social_replies(id,post_id,body,status) VALUES(?,?,?,'DRAFT')").run(id,p.id,reply);
   store.db.prepare("UPDATE social_generation SET status='GENERATED' WHERE id=?").run(id);
  });
  // Re-check the pause switch after slow generation before authorizing a write.
  if(!autonomyStatus(store,Date.now()).enabled||!store.settings().enabled)return {status:'DRAFT'};
  reviewReply(store,id,reply,'APPROVED');
  const result=await publishReply(store,id,path,fetcher,now,()=>autonomyStatus(store).enabled&&Boolean(store.settings().enabled));
  store.audit('social_autonomous_reply',id+':'+result.status);return result;
 }catch(e){
  const code=e instanceof ModelError?e.message:e instanceof Error&&['source_changed','reply_quality_rejected','reply_not_grounded'].includes(e.message)?e.message:'social_cycle_failed';
  store.db.prepare("UPDATE social_generation SET status='FAILED',error_code=? WHERE id=?").run(code,id);store.db.prepare('UPDATE social_autonomy SET error_code=? WHERE id=1').run(code);return {error_code:code};
 }
}
