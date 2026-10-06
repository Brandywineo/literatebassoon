import type {openStore} from './store.ts';
type Store=ReturnType<typeof openStore>;
// A service topic is not buying intent. Require an explicit request in the same sentence.
const serviceTopics=/\b(?:summari[sz]\w*|summar(?:y|ies)|rewrit\w*|proofread\w*|text cleanup|writing|edit(?:ing)? text|structured text|json valid\w*)\b/i;
export function classifyDiscussion(text:string){
 const clean=text.slice(0,14000).replace(/```[\s\S]*?```/g,' ').split('\n').filter(line=>!/^\s*>/.test(line)).join('\n').replace(/https?:\/\/\S+/g,' ');
 const sentences=clean.split(/[.!?\n]+/).map(s=>s.trim()).filter(Boolean);
 const request=sentences.find(s=>serviceTopics.test(s)&&! /\b(?:do not|don't|no longer|not looking|without|hypothetical|imagine|for example|suppose|we offer|i offer|try our|use my)\b/i.test(s)&&
 /\b(?:(?:i|we|my agent|our agents?|agents?)\s+(?:really\s+)?(?:need|want|require|am looking for|are looking for|is looking for)|looking for|can (?:someone|anyone|an agent)|could (?:someone|anyone|an agent)|seeking (?:an? |help|a service)|please (?:summari[sz]e|rewrite|proofread)|recommend (?:an? )?(?:service|tool|agent))\b/i.test(s));
 const opportunity=sentences.find(s=>! /\b(?:hypothetical|imagine|suppose|we offer|i offer|not looking|don't want)\b/i.test(s)&&/\b(?:earn(?:ing)?|income|paid work|sell(?:ing)?|test(?:ing|er)?|try|collaborat\w*)\b/i.test(s)&&/\b(?:i|we|my|our|human|looking|seeking|want|need|challenge)\b/i.test(s));
 return {opportunity:Boolean(opportunity),opportunity_excerpt:opportunity?.slice(0,240)||null,demand:Boolean(request),service_topic:serviceTopics.test(clean),request_excerpt:request?.slice(0,240)||null};
}
const reliabilityTopics=/agent|queue|retr(?:y|ies)|idempoten|delegat|workflow|api|memory|context|tool|task/i;
export function chooseDiscussion(store:Store,now=Date.now()){
 const candidates=store.db.prepare(`SELECT d.* FROM social_discussions d WHERE full_content=1 AND seen_at>=? AND source_created_at IS NOT NULL AND julianday(source_created_at)>=julianday(?) AND julianday(source_created_at)<=julianday(?) AND NOT EXISTS(SELECT 1 FROM social_replies r WHERE r.post_id=d.id AND r.parent_id IS NULL) AND NOT EXISTS(SELECT 1 FROM social_generation g WHERE g.post_id=d.id AND g.parent_id IS NULL) ORDER BY source_created_at DESC LIMIT 30`).all(now-3600000,new Date(now-7*86400000).toISOString(),new Date(now+300000).toISOString());
 const ranked=candidates.map(p=>{
  const text=String(p.title)+' '+String(p.body),classification=classifyDiscussion(text),demand=classification.demand,relevant=reliabilityTopics.test(text)||classification.service_topic;
  const goal=demand?'service_demand':classification.opportunity?'tester_opportunity':'useful_engagement';
  const history=store.db.prepare("SELECT count(*) AS attempts,sum(CASE WHEN g.status='FAILED' THEN 1 ELSE 0 END) AS failures FROM kestrel_plans plan JOIN social_generation g ON g.id=plan.id WHERE plan.goal_id=? AND plan.created_at>=?").get(goal,now-7*86400000)!;
  const failures=Number(history.failures||0),attempts=Number(history.attempts||0);
  const author=Number(store.db.prepare('SELECT count(*) AS n FROM social_replies r JOIN social_discussions d ON d.id=r.post_id WHERE d.author=? AND r.attempted_at>=?').get(p.author,now-7*86400000)?.n);
  const age=Math.max(0,(now-Date.parse(String(p.source_created_at)))/3600000);
  const score=(demand?60:classification.opportunity?55:relevant?30:0)+Math.max(0,24-age)-Math.min(author*8,24)-(attempts>=3?Math.round(failures/attempts*12):0);
  return {p,goal,score,reason:demand?'explicit_text_service_request':classification.opportunity?'potential_tester_or_provider':relevant?'relevant_agent_workflow_discussion':'weak_topic_match'};
 }).filter(p=>p.reason!=='weak_topic_match').sort((a,b)=>b.score-a.score||String(a.p.id).localeCompare(String(b.p.id)));
 return ranked[0]||null;
}
export function reservePlan(store:Store,id:string,postId:string,goal:string,reason:string,score:number,now=Date.now()){
 store.db.prepare("INSERT INTO kestrel_plans(id,goal_id,post_id,reason,score,status,created_at) VALUES(?,?,?,?,?,'GENERATING',?)").run(id,goal,postId,reason,score,now);
}
export function refreshPlanning(store:Store,now=Date.now()){
 store.transaction(()=>{
  // Execution outcomes come from persisted records, not the model's claims.
  store.db.prepare(`UPDATE kestrel_plans SET status=CASE WHEN EXISTS(SELECT 1 FROM social_generation g WHERE g.id=kestrel_plans.id AND g.status='FAILED') THEN 'GENERATION_FAILED' WHEN EXISTS(SELECT 1 FROM social_replies r WHERE r.id=kestrel_plans.id) THEN (SELECT r.status FROM social_replies r WHERE r.id=kestrel_plans.id) ELSE status END,error_code=(SELECT g.error_code FROM social_generation g WHERE g.id=kestrel_plans.id),visibility=(SELECT v.visibility FROM social_visibility v WHERE v.reply_id=kestrel_plans.id),updated_at=?`).run(now);
  const metrics:any={
   useful_engagement:{planned:Number(store.db.prepare("SELECT count(*) AS n FROM kestrel_plans WHERE goal_id='useful_engagement'").get()?.n),visible:Number(store.db.prepare("SELECT count(*) AS n FROM kestrel_plans WHERE goal_id='useful_engagement' AND visibility='VISIBLE'").get()?.n)},
   relationships:{incoming_responses:Number(store.db.prepare('SELECT count(*) AS n FROM social_incoming').get()?.n),followups:Number(store.db.prepare("SELECT count(*) AS n FROM kestrel_plans WHERE goal_id='relationships' AND visibility='VISIBLE'").get()?.n)},
   tester_opportunity:{assessed:Number(store.db.prepare("SELECT count(*) AS n FROM kestrel_plans WHERE goal_id='tester_opportunity'").get()?.n),invitations:Number(store.db.prepare("SELECT count(*) AS n FROM kestrel_social_decisions WHERE action='invite'").get()?.n),reported_referrals:Number(store.db.prepare("SELECT count(*) AS n FROM agents WHERE referral='kestrelfield'").get()?.n)},
   service_demand:{planned:Number(store.db.prepare("SELECT count(*) AS n FROM kestrel_plans WHERE goal_id='service_demand'").get()?.n),reported_referrals:Number(store.db.prepare("SELECT count(*) AS n FROM agents WHERE referral='kestrelfield'").get()?.n),completed_referral_jobs:Number(store.db.prepare("SELECT count(*) AS n FROM jobs j JOIN agents a ON a.id=j.buyer_id WHERE a.referral='kestrelfield' AND j.status='COMPLETED'").get()?.n)}
  };
  for(const [id,data] of Object.entries(metrics))store.db.prepare('UPDATE kestrel_goals SET metrics=?,checked_at=? WHERE id=?').run(JSON.stringify(data),now,id);
 });
}
export function planningSnapshot(store:Store){return {decisions:store.db.prepare('SELECT * FROM kestrel_social_decisions ORDER BY created_at DESC LIMIT 50').all(),incidents:store.db.prepare('SELECT * FROM kestrel_incidents ORDER BY created_at DESC LIMIT 50').all(),goals:store.db.prepare('SELECT * FROM kestrel_goals').all(),plans:store.db.prepare('SELECT * FROM kestrel_plans ORDER BY created_at DESC LIMIT 50').all(),waiting:store.db.prepare('SELECT last_reason,next_cycle_at,last_cycle_at FROM social_autonomy WHERE id=1').get()};}
