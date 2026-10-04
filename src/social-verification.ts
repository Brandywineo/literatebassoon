import type {openStore} from './store.ts';
import {generate} from './models.ts';
import {verifyReply} from './social.ts';
import {verifyPublication} from './publishing.ts';
import {credentialPath} from './moltbook.ts';
type Store=ReturnType<typeof openStore>;
// PostgreSQL-style timestamps include a space and six fractional digits.
export function challengeDeadline(value:unknown){
 if(typeof value!=='string')return NaN;
 return Date.parse(value.trim().replace(' ','T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00'));
}
export function expireChallenges(store:Store,now=Date.now()){
 for(const [table,key] of [['social_replies','id'],['moltbook_publications','draft_id']]){
  for(const r of store.db.prepare(`SELECT ${key} AS id,expires_at FROM ${table} WHERE status IN ('PENDING_VERIFICATION','SOLVING')`).all()){
   const deadline=challengeDeadline(r.expires_at);
   if(!Number.isFinite(deadline)||deadline<=now)store.db.prepare(`UPDATE ${table} SET status='VERIFICATION_EXPIRED',error_code='verification_expired',verification_code=NULL WHERE ${key}=? AND status IN ('PENDING_VERIFICATION','SOLVING')`).run(r.id);
  }
 }
}
export function calculateChallenge(raw:string){
 const r=JSON.parse(raw);
 if(!r||Object.keys(r).sort().join(',')!=='a,b,op'||typeof r.a!=='number'||typeof r.b!=='number'||!Number.isFinite(r.a)||!Number.isFinite(r.b)||Math.abs(r.a)>1e8||Math.abs(r.b)>1e8||!['+','-','*','/'].includes(r.op)||r.op==='/'&&r.b===0)throw Error('challenge_ambiguous');
 const result=r.op==='+'?r.a+r.b:r.op==='-'?r.a-r.b:r.op==='*'?r.a*r.b:r.a/r.b;
 if(!Number.isFinite(result)||Math.abs(result)>=1e12)throw Error('challenge_ambiguous');
 return result.toFixed(2);
}
export async function processChallenges(store:Store,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now(),generateText=generate){
 expireChallenges(store,now);
 const cfg=store.settings();if(!cfg.enabled||!store.db.prepare('SELECT enabled FROM social_autonomy WHERE id=1').get()?.enabled)return;
 // One persistent attempt per content item, at most three solver calls per rolling day.
 const reserved=store.transaction(()=>{
  if(Number(store.db.prepare('SELECT count(*) AS n FROM social_verification_attempts WHERE started_at>=?').get(now-86400000)?.n)>=3)return null;
  for(const [table,key,kind] of [['social_replies','id','reply'],['moltbook_publications','draft_id','post']]){
   const row=store.db.prepare(`SELECT * FROM ${table} WHERE status='PENDING_VERIFICATION' AND NOT EXISTS(SELECT 1 FROM social_verification_attempts WHERE target=?||${key}) LIMIT 1`).get(kind+':');
   if(!row)continue;
   const target=kind+':'+row[key];
   if(challengeDeadline(row.expires_at)-now<75000){store.db.prepare('INSERT INTO social_verification_attempts VALUES(?,?,?,?)').run(target,now,'DEFERRED','insufficient_verification_time');continue;}
   store.db.prepare('INSERT INTO social_verification_attempts VALUES(?,?,?,NULL)').run(target,now,'RUNNING');
   store.db.prepare(`UPDATE ${table} SET status='SOLVING' WHERE ${key}=?`).run(row[key]);
   return {row,table,key,kind,target};
  }
  return null;
 });
 if(!reserved)return;
 const {row,table,key,kind,target}=reserved;
 try{
  const out=await generateText({provider:cfg.provider,model:cfg.model,ollamaUrl:process.env.OLLAMA_URL,openaiKey:process.env.OPENAI_API_KEY},'social-verification',String(row.challenge),fetcher);
  const answer=calculateChallenge(out.text);
  store.db.prepare(`UPDATE ${table} SET status='PENDING_VERIFICATION' WHERE ${key}=? AND status='SOLVING'`).run(row[key]);
  const current=Date.now();expireChallenges(store,current);
  if(!store.settings().enabled||!store.db.prepare('SELECT enabled FROM social_autonomy WHERE id=1').get()?.enabled)throw Error('verification_paused');
  if(challengeDeadline(row.expires_at)<=current)throw Error('verification_expired');
  const result=kind==='reply'?await verifyReply(store,String(row[key]),answer,path,fetcher,current):await verifyPublication(store,String(row[key]),answer,path,fetcher,current);
  store.db.prepare('UPDATE social_verification_attempts SET status=? WHERE target=?').run(result.status,target);
  store.audit('social_automatic_verification',target+':'+result.status);
 }catch{
  store.db.prepare(`UPDATE ${table} SET status='PENDING_VERIFICATION',error_code='automatic_verification_needs_review' WHERE ${key}=? AND status='SOLVING'`).run(row[key]);
  expireChallenges(store,Date.now());
  store.db.prepare("UPDATE social_verification_attempts SET status='NEEDS_REVIEW',error_code='automatic_verification_needs_review' WHERE target=?").run(target);
 }
}
