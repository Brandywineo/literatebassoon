import {socialLimits} from './social-policy.ts';
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
// Conservative source checks: supported written numbers are parsed longest-first,
// so "thirty five" cannot be silently reduced to five. Unsupported phonetics defer.
const small=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const tens=['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
const numberWords=new Map<string,number>();
for(let n=0;n<100;n++)numberWords.set(n<20?small[n]:tens[Math.floor(n/10)]+(n%10?small[n%10]:''),n);
for(let n=100;n<1000;n++){
 const prefix=small[Math.floor(n/100)]+'hundred',rest=n%100;
 const suffix=rest?(rest<20?small[rest]:tens[Math.floor(rest/10)]+(rest%10?small[rest%10]:'')):'';
 numberWords.set(prefix+suffix,n);if(rest)numberWords.set(prefix+'and'+suffix,n);
}
const syllables=[...small,...tens.filter(Boolean),'hundred','and'].sort((a,b)=>b.length-a.length);
const spelling=new RegExp(syllables.join('|'),'g');
const wordPattern=[...numberWords.keys()].sort((a,b)=>b.length-a.length).map(word=>(word.match(spelling)||[]).join('\\s*')).join('|');
export function challengeSourceFacts(source:string){
 if(source.length>2000)throw Error('challenge_ambiguous');
 // Collapse punctuation and spacing in written words, but retain numeric separators.
 const normalized=source.toLowerCase().replace(/[^a-z0-9.\s]/g,'');
 // Unknown number-like spellings are not permission to extract only their suffix.
 if(/\b[a-z]*(?:enty|irty|orty|ifty|ixty|eventy|ighty|inety|teen|hundred)\b/g.test(normalized.replace(new RegExp('\\b(?:'+syllables.join('|')+')\\b','g'),'')))throw Error('challenge_ambiguous');
 if(/-\s*\d|\d\s*%/.test(source))throw Error('challenge_ambiguous');
 const quantities=[...normalized.matchAll(new RegExp('\\b(?:'+wordPattern+'|[0-9]+(?:\\.[0-9]+)?)\\b','g'))].map(m=>numberWords.get(m[0].replace(/\s/g,''))??Number(m[0]));
 if(quantities.length!==2||quantities.some(n=>!Number.isFinite(n)||n>1e8))throw Error('challenge_ambiguous');
 const operations=new Set<string>();
 if(/\b(?:plus|added|addition|increas\w*|gains?|combined|sum)\b/.test(normalized))operations.add('+');
 if(/\b(?:minus|subtract\w*|decreas\w*|loses?|lost|reduces?|remaining|remains?|slows?)\b/.test(normalized))operations.add('-');
 if(/\b(?:multipl\w*|product|times|each)\b|\bmass\b.*\bacceleration\b|\bacceleration\b.*\bmass\b/.test(normalized))operations.add('*');
 if(/\b(?:divid\w*|quotient)\b|\bsplit\b.*\bequal\w*\b|\bequally\b.*\bsplit\b/.test(normalized))operations.add('/');
 if(!operations.size&&/\btotal\b/.test(normalized))operations.add('+');
 if(operations.size!==1||/\b(?:increases?|decreases?|reduces?|slows?)\s+to\b/.test(normalized))throw Error('challenge_ambiguous');
 return {quantities,operation:[...operations][0]};
}
export function groundedChallenge(raw:string,source:string){
 const facts=challengeSourceFacts(source),r=JSON.parse(raw);
 const answer=calculateChallenge(raw);
 if(r.a!==facts.quantities[0]||r.b!==facts.quantities[1])throw Error('challenge_operand_mismatch');
 if(r.op!==facts.operation)throw Error('challenge_operation_mismatch');
 return {answer,expression:r};
}
export async function processChallenges(store:Store,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now(),generateText=generate){
 expireChallenges(store,now);
 const cfg=store.settings();if(!cfg.enabled||!store.db.prepare('SELECT enabled FROM social_autonomy WHERE id=1').get()?.enabled)return;
 // One persistent attempt per content item, at most four solver calls per rolling day.
 const reserved=store.transaction(()=>{
  if(Number(store.db.prepare('SELECT count(*) AS n FROM social_verification_attempts WHERE started_at>=?').get(now-86400000)?.n)>=socialLimits.verification_attempts)return null;
  for(const [table,key,kind] of [['social_replies','id','reply'],['moltbook_publications','draft_id','post']]){
   const row=store.db.prepare(`SELECT * FROM ${table} WHERE status='PENDING_VERIFICATION' AND NOT EXISTS(SELECT 1 FROM social_verification_attempts WHERE target=?||${key}) LIMIT 1`).get(kind+':');
   if(!row)continue;
   const target=kind+':'+row[key];
   if(challengeDeadline(row.expires_at)-now<75000){store.db.prepare('INSERT INTO social_verification_attempts(target,started_at,status,error_code) VALUES(?,?,?,?)').run(target,now,'DEFERRED','insufficient_verification_time');continue;}
   store.db.prepare('INSERT INTO social_verification_attempts(target,started_at,status,error_code) VALUES(?,?,?,NULL)').run(target,now,'RUNNING');
   store.db.prepare(`UPDATE ${table} SET status='SOLVING' WHERE ${key}=?`).run(row[key]);
   return {row,table,key,kind,target};
  }
  return null;
 });
 if(!reserved)return;
 const {row,table,key,kind,target}=reserved;
 try{
  const facts=challengeSourceFacts(String(row.challenge));
  const out=await generateText({provider:cfg.provider,model:cfg.model,ollamaUrl:process.env.OLLAMA_URL,openaiKey:process.env.OPENAI_API_KEY},'social-verification',JSON.stringify({challenge:String(row.challenge),source_quantities:facts.quantities,source_operation:facts.operation}),fetcher);
  const {answer,expression}=groundedChallenge(out.text,String(row.challenge));
  store.db.prepare('UPDATE social_verification_attempts SET equation=?,answer=? WHERE target=?').run(`${expression.a} ${expression.op} ${expression.b}`,answer,target);
  store.db.prepare(`UPDATE ${table} SET status='PENDING_VERIFICATION' WHERE ${key}=? AND status='SOLVING'`).run(row[key]);
  const current=Date.now();expireChallenges(store,current);
  if(!store.settings().enabled||!store.db.prepare('SELECT enabled FROM social_autonomy WHERE id=1').get()?.enabled)throw Error('verification_paused');
  if(challengeDeadline(row.expires_at)<=current)throw Error('verification_expired');
  const result=kind==='reply'?await verifyReply(store,String(row[key]),answer,path,fetcher,current):await verifyPublication(store,String(row[key]),answer,path,fetcher,current);
  store.db.prepare('UPDATE social_verification_attempts SET status=?,finished_at=? WHERE target=?').run(result.status,Date.now(),target);
  store.audit('social_automatic_verification',target+':'+result.status);
 }catch(e){
  store.db.prepare(`UPDATE ${table} SET status='PENDING_VERIFICATION',error_code='automatic_verification_needs_review' WHERE ${key}=? AND status='SOLVING'`).run(row[key]);
  expireChallenges(store,Date.now());
  store.db.prepare("UPDATE social_verification_attempts SET status='NEEDS_REVIEW',error_code=?,finished_at=? WHERE target=?").run(e instanceof Error&&['verification_paused','verification_expired','challenge_ambiguous','challenge_operand_mismatch','challenge_operation_mismatch'].includes(e.message)?e.message:'solver_or_response_failed',Date.now(),target);
 }
}
