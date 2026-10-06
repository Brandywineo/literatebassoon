import type {openStore} from './store.ts';
import {classifyDiscussion} from './planning.ts';
type Store=ReturnType<typeof openStore>;
// A concise, inspectable decision record, not a claim to expose hidden reasoning.
export function parseSocialDecision(text:string,source:string,canInvite:boolean){
 let d:any;try{d=JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1'));}catch{throw Error('decision_invalid_json');}
 if(!d||Object.keys(d).sort().join(',')!=='action,body,evidence,need,reason'||!['help','invite','abstain'].includes(d.action)||![d.need,d.reason].every(v=>typeof v==='string'&&v.length>=10&&v.length<=400)||typeof d.evidence!=='string'||d.evidence.length<15||d.evidence.length>240||!source.includes(d.evidence)||typeof d.body!=='string'||d.body.length>1200)throw Error('decision_invalid_evidence');
 if(d.action==='invite'&&!canInvite)throw Error('decision_invitation_not_eligible');
 if(d.action==='abstain'&&d.body!=='')throw Error('decision_abstention_has_body');
 return d as {action:string;body:string;evidence:string;need:string;reason:string};
}
export function invitationEligible(store:Store,source:string,author:string,now:number){
 const c=classifyDiscussion(source);
 if(!c.opportunity&&!c.demand)return false;
 if(store.db.prepare("SELECT id FROM kestrel_social_decisions WHERE action='invite' AND created_at>=? LIMIT 1").get(now-86400000))return false;
 return !store.db.prepare("SELECT j.id FROM kestrel_social_decisions j JOIN social_discussions d ON d.id=j.post_id WHERE j.action='invite' AND lower(d.author)=lower(?) LIMIT 1").get(author);
}
export const invitationDisclosure='I operate Literate Bassoon. New accounts receive 100 test credits, not cash. You can try the text services or list a service; optional paid services use USDT or BNB. The exchange link is in my profile.';
export function recordPrivateIncidents(store:Store,now=Date.now()){
 for(const r of store.db.prepare("SELECT r.id,r.status,r.error_code,v.visibility,v.verification_status FROM social_replies r LEFT JOIN social_visibility v ON v.reply_id=r.id WHERE r.status IN ('VERIFICATION_FAILED','VERIFICATION_EXPIRED','UNCERTAIN') ORDER BY r.rowid DESC LIMIT 200").all()){
  const code=String(r.status).toLowerCase();
  store.db.prepare('INSERT OR IGNORE INTO kestrel_incidents(id,source,code,observation,created_at) VALUES(?,?,?,?,?)').run('reply:'+r.id+':'+code,'reply:'+r.id,code,JSON.stringify({local_status:r.status,visibility:r.visibility||'UNKNOWN',verification:r.verification_status||'UNKNOWN',meaning:'Private operational incident. Visibility and verification are separate; no public question or resend is required.'}),now);
 }
 for(const r of store.db.prepare("SELECT id,error_code FROM social_generation WHERE status='FAILED' ORDER BY started_at DESC LIMIT 200").all()){
  const code=/^(?:reply_[a-z_]+|decision_[a-z_]+|source_changed|social_cycle_failed|http_\d{3})$/.test(String(r.error_code))?String(r.error_code):'generation_failed';
  store.db.prepare('INSERT OR IGNORE INTO kestrel_incidents(id,source,code,observation,created_at) VALUES(?,?,?,?,?)').run('generation:'+r.id,'generation:'+r.id,code,'A generation or research attempt failed. No conclusion about public delivery follows from this observation.',now);
 }
}
export function conversationContext(store:Store,message:string){
 const terms=new Set(message.toLowerCase().match(/[a-z0-9-]{4,}/g)||[]);
 const rows=store.db.prepare(`SELECT r.id,r.post_id,d.author,d.title,d.body AS source_body,r.body,r.status,v.visibility,v.verification_status,g.id AS autonomous_generation FROM social_replies r JOIN social_discussions d ON d.id=r.post_id LEFT JOIN social_visibility v ON v.reply_id=r.id LEFT JOIN social_generation g ON g.id=r.id ORDER BY r.rowid DESC LIMIT 100`).all();
 return rows.map(r=>({...r,score:[...terms].filter(t=>(String(r.author)+' '+r.post_id+' '+r.title+' '+r.body).toLowerCase().includes(t)).length})).sort((a,b)=>b.score-a.score).slice(0,3).map(r=>({reply_id:r.id,post_id:r.post_id,author:r.author,title:r.title,source_excerpt:String(r.source_body).slice(0,600),our_reply:String(r.body).slice(0,900),origin:r.autonomous_generation?'AUTONOMOUS':'ADMIN_INITIATED',local_status:r.status,last_observed_visibility:r.visibility,verification:r.verification_status,incoming:store.db.prepare('SELECT author,body FROM social_incoming WHERE post_id=? ORDER BY seen_at DESC LIMIT 1').all(r.post_id).map(i=>({author:i.author,body:String(i.body).slice(0,500)}))}));
}
