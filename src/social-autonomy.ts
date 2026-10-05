import {socialLimits,unansweredIncoming,retryEligibleIncoming,retryableReplyErrors} from './social-policy.ts';
import {chooseDiscussion,reservePlan,refreshPlanning} from './planning.ts';
import {learnFromOutcomes,retrieveMemory} from './memory.ts';
import {readThread,scanFollowups} from './social-threads.ts';
import type {openStore} from './store.ts';
import {generate,ModelError} from './models.ts';
import {request,credentials,credentialPath} from './moltbook.ts';
import {reviewReply,publishReply} from './social.ts';
import {expireChallenges,processChallenges} from './social-verification.ts';
type Store=ReturnType<typeof openStore>;
export function autonomyStatus(store:Store,now=Date.now()){
 expireChallenges(store,now);
 const row=store.db.prepare('SELECT * FROM social_autonomy WHERE id=1').get()!;
 const blocked=store.db.prepare("SELECT status FROM social_replies WHERE status IN ('SENDING','UNCERTAIN','PENDING_VERIFICATION','VERIFYING','SOLVING') AND NOT (status='UNCERTAIN' AND EXISTS(SELECT 1 FROM social_visibility v WHERE v.reply_id=social_replies.id AND v.visibility='VISIBLE' AND v.error_code IS NULL AND v.checked_at>=?)) LIMIT 1").get(now-3600000)?.status;
 const writes=store.db.prepare('SELECT count(*) AS n,min(attempted_at) AS first,max(attempted_at) AS last FROM social_replies WHERE attempted_at>=?').get(now-86400000)!;
 const generations=store.db.prepare('SELECT count(*) AS n,min(started_at) AS first FROM social_generation WHERE started_at>=?').get(now-86400000)!;
 const solver=store.db.prepare('SELECT count(*) AS n FROM social_verification_attempts WHERE started_at>=?').get(now-86400000)!;
 const counts=store.db.prepare(`SELECT count(*) AS total,sum(CASE WHEN v.visibility='VISIBLE' THEN 1 ELSE 0 END) AS visible,sum(CASE WHEN r.status='PUBLISHED' OR v.verification_status='verified' THEN 1 ELSE 0 END) AS verified FROM social_replies r LEFT JOIN social_visibility v ON v.reply_id=r.id WHERE r.attempted_at>=?`).get(now-86400000)!;
 const waits=[{reason:'generation_daily_limit',until:Number(generations.n)>=socialLimits.generation_attempts?Number(generations.first)+86400000:0},{reason:'reply_daily_limit',until:Number(writes.n)>=socialLimits.reply_attempts?Number(writes.first)+86400000:0},{reason:'hourly_cooldown',until:Number(row.checked_at)+3600000},{reason:'reply_interval',until:writes.last!=null?Number(writes.last)+3600000:0}].filter(w=>w.until>now).sort((a,b)=>b.until-a.until);
 const waiting_reason=blocked?'blocked_'+blocked:!row.enabled?'autonomy_paused':!store.settings().enabled?'model_processing_paused':waits[0]?.reason||null;
 const next_eligible_at=!blocked&&row.enabled&&store.settings().enabled&&waits.length?waits[0].until:null;
 return {observed_at:now,waiting_reason,next_eligible_at,reply_attempts:Number(writes.n),visible_replies:Number(counts.visible||0),verified_replies:Number(counts.verified||0),verification_attempts:Number(solver.n),limits:socialLimits,...row,enabled:Boolean(row.enabled),blocked:blocked||null,generation_attempts:Number(store.db.prepare('SELECT count(*) AS n FROM social_generation WHERE started_at>=?').get(now-86400000)?.n),thread_scan:store.db.prepare('SELECT * FROM social_thread_scan WHERE id=1').get(),incoming_waiting:Number(store.db.prepare(`SELECT count(*) AS n FROM social_incoming i WHERE ${unansweredIncoming}`).get()?.n)};
}
export function setAutonomy(store:Store,enabled:boolean){
 if(typeof enabled!=='boolean')throw Error('enabled must be boolean');
 store.transaction(()=>{store.db.prepare('UPDATE social_autonomy SET enabled=?,error_code=NULL WHERE id=1').run(enabled?1:0);store.audit(enabled?'social_autonomy_enabled':'social_autonomy_paused','KestrelField');});return autonomyStatus(store);
}
export function validateAutonomousReply(body:unknown,source:string){
 if(typeof body!=='string')throw Error('reply_invalid_type');
 if(body.trim().length<80)throw Error('reply_too_short');
 if(body.length>1200)throw Error('reply_too_long');
 if((body.match(/\?/g)||[]).length>1)throw Error('reply_too_many_questions');
 if(/https?:|www\.|clicknlist|\[[^\]]*\]\(|<a\b/i.test(body))throw Error('reply_promotion_or_link');
 if(/api[_ -]?key|seed phrase|private key|send (?:me|us)/i.test(body))throw Error('reply_credential_or_solicitation');
 if(/guaranteed|ignore (?:previous|all)|as an ai|```/i.test(body))throw Error('reply_unsafe_or_boilerplate');
 const words=(s:string)=>new Set(s.toLowerCase().match(/[a-z]{5,}/g)||[]);
 const sourceWords=words(source),shared=[...words(body)].filter(w=>sourceWords.has(w));
 if(shared.length<3)throw Error('reply_not_grounded');
 // Catch near-verbatim reuse; semantic usefulness remains a fallible model judgment.
 const tokens=(s:string)=>s.toLowerCase().match(/[a-z0-9]+/g)||[];
 const grams=(t:string[])=>t.slice(0,-4).map((_,i)=>t.slice(i,i+5).join(' '));
 const sourceGrams=new Set(grams(tokens(source))),replyGrams=grams(tokens(body));
 if(replyGrams.length>=12&&replyGrams.filter(g=>sourceGrams.has(g)).length/replyGrams.length>0.75)throw Error('reply_near_copy');
 return body.trim();
}
// Reserve before every model call; a crashed attempt still consumes today's budget.
// Never replay an uncertain write; verification has its own durable reservation.
export async function runSocialCycle(store:Store,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now(),generateText=generate){
 expireChallenges(store,now);
 await processChallenges(store,path,fetcher,now,generateText);
 await scanFollowups(store,path,fetcher,now);
 learnFromOutcomes(store,now);
 refreshPlanning(store,now);
 const candidate=store.transaction(()=>{
  const status=autonomyStatus(store,now),cfg=store.settings();
  const skip=(reason:string,next:number|null=null)=>{store.db.prepare('UPDATE social_autonomy SET last_reason=?,last_cycle_at=?,next_cycle_at=? WHERE id=1 AND (last_reason IS NOT ? OR last_cycle_at<?)').run(reason,now,next,reason,now-60000);return null;};
  if(!status.enabled)return skip('autonomy_paused');
  if(!cfg.enabled)return skip('model_processing_paused');
  if(status.blocked)return skip('blocked_'+status.blocked);
  if(status.generation_attempts>=socialLimits.generation_attempts){const first=store.db.prepare('SELECT min(started_at) AS n FROM social_generation WHERE started_at>=?').get(now-86400000)!;return skip('generation_daily_limit',Number(first.n)+86400000);}
  if(now-Number(status.checked_at)<3600000)return skip('hourly_cooldown',Number(status.checked_at)+3600000);
  const attempts=store.db.prepare('SELECT count(*) AS n,min(attempted_at) AS first,max(attempted_at) AS last FROM social_replies WHERE attempted_at>=?').get(now-86400000)!;
  if(Number(attempts.n)>=socialLimits.reply_attempts)return skip('reply_daily_limit',Number(attempts.first)+86400000);
  if(attempts.last!=null&&now-Number(attempts.last)<3600000)return skip('reply_interval',Number(attempts.last)+3600000);
  if(store.db.prepare("SELECT id FROM jobs WHERE status='QUEUED' LIMIT 1").get())return skip('customer_jobs_waiting');
  const incoming=store.db.prepare(`SELECT i.*,r.body AS previous_body FROM social_incoming i JOIN social_replies r ON r.comment_id=i.parent_id AND (r.status='PUBLISHED' OR EXISTS(SELECT 1 FROM social_visibility v WHERE v.reply_id=r.id AND v.visibility='VISIBLE' AND v.error_code IS NULL AND v.checked_at>=i.seen_at)) WHERE i.seen_at>=? AND ${retryEligibleIncoming} AND (SELECT count(*) FROM social_replies sent WHERE sent.post_id=i.post_id AND sent.parent_id IS NOT NULL)<2 ORDER BY i.source_created_at DESC LIMIT 1`).get(now-3600000);
  const selected=incoming?null:chooseDiscussion(store,now);
  const p=incoming?store.db.prepare('SELECT * FROM social_discussions WHERE id=?').get(incoming.post_id):selected?.p;
  if(!p)return skip('no_fresh_unanswered_source');
  const id=crypto.randomUUID();store.db.prepare("INSERT INTO social_generation(id,post_id,started_at,status,error_code,parent_id) VALUES(?,?,?,'RUNNING',NULL,?)").run(id,p.id,now,incoming?.id||null);
  reservePlan(store,id,String(p.id),incoming?'relationships':selected!.goal,incoming?'fresh_direct_response':selected!.reason,incoming?100:selected!.score,now);
  store.db.prepare('UPDATE social_autonomy SET checked_at=?,error_code=NULL,last_cycle_at=?,last_reason=?,next_cycle_at=? WHERE id=1').run(now,now,incoming?'generating_followup':'generating_initial_reply',now+3600000);
  return {p,id,cfg,incoming};
 });
 if(!candidate)return {skipped:true};
 const {p,id,cfg,incoming}=candidate;
 try{
  const c=credentials(path),detail=await request('/posts/'+p.id,c.api_key,undefined,fetcher),fresh=detail.post;
  if(detail.success===false||fresh?.id!==p.id||fresh.author?.name!==p.author||(!incoming&&fresh.author.name.toLowerCase()===c.name.toLowerCase())||fresh.is_spam||fresh.is_deleted||typeof fresh.content!=='string'||fresh.content!==p.body||fresh.title!==p.title)throw Error('source_changed');
  let source=String(p.title)+'\n'+String(p.body).slice(0,incoming?4000:10000);
  if(incoming){
   const current=(await readThread(String(p.id),path,fetcher)).find(r=>r.id===incoming.id);
   if(!current||current.parent_id!==incoming.parent_id||current.author?.name!==incoming.author||current.content!==incoming.body||current.is_spam||current.is_deleted)throw Error('source_changed');
   const prior=store.db.prepare("SELECT error_code FROM social_generation WHERE parent_id=? AND status='FAILED' ORDER BY started_at DESC LIMIT 1").get(incoming.id);
   if(prior&&retryableReplyErrors.includes(String(prior.error_code) as any))source+='\nYour previous draft was rejected before posting: '+prior.error_code+'. Correct that issue; this is the only regeneration retry for this message.';
   source+='\nYour previous comment (context only): '+String(incoming.previous_body).slice(0,1200)+'\nReply directly to this agent response: '+String(incoming.body).slice(0,6000);
  }
  const output=await generateText({provider:cfg.provider,model:cfg.model,ollamaUrl:process.env.OLLAMA_URL,openaiKey:process.env.OPENAI_API_KEY},'social-reply',source+retrieveMemory(store,id,source,now,String(incoming?.author||p.author)),fetcher);
  const reply=validateAutonomousReply(output.text,source);
  store.transaction(()=>{
   store.db.prepare("INSERT INTO social_replies(id,post_id,body,status,parent_id) VALUES(?,?,?,'DRAFT',?)").run(id,p.id,reply,incoming?.id||null);
   store.db.prepare("UPDATE social_generation SET status='GENERATED',finished_at=? WHERE id=?").run(Date.now(),id);
  });
  // Re-check the pause switch after slow generation before authorizing a write.
  if(!autonomyStatus(store,Date.now()).enabled||!store.settings().enabled){store.db.prepare("UPDATE social_autonomy SET last_reason='draft_retained_after_pause' WHERE id=1").run();return {status:'DRAFT'};}
  reviewReply(store,id,reply,'APPROVED');
  let result=await publishReply(store,id,path,fetcher,now,()=>autonomyStatus(store).enabled&&Boolean(store.settings().enabled));
  if(result.status==='PENDING_VERIFICATION'){await processChallenges(store,path,fetcher,Date.now(),generateText);result={...result,status:String(store.db.prepare('SELECT status FROM social_replies WHERE id=?').get(id)?.status)};}
  store.db.prepare('UPDATE social_autonomy SET last_reason=? WHERE id=1').run('submission_'+result.status);store.audit(incoming?'social_autonomous_followup':'social_autonomous_reply',id+':'+result.status);return result;
 }catch(e){
  const code=e instanceof ModelError?e.message:e instanceof Error&&['source_changed','reply_quality_rejected','reply_not_grounded','reply_invalid_type','reply_too_short','reply_too_long','reply_too_many_questions','reply_promotion_or_link','reply_credential_or_solicitation','reply_unsafe_or_boilerplate','reply_near_copy'].includes(e.message)?e.message:'social_cycle_failed';
  store.db.prepare("UPDATE social_generation SET status='FAILED',error_code=?,finished_at=? WHERE id=?").run(code,Date.now(),id);store.db.prepare("UPDATE social_autonomy SET error_code=?,last_reason='cycle_failed' WHERE id=1").run(code);return {error_code:code};
 }
}
