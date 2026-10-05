import {createHash} from 'node:crypto';
import type {openStore} from './store.ts';
type Store=ReturnType<typeof openStore>;
export const guidanceVersion=(text:string)=>createHash('sha256').update(text).digest('hex').slice(0,16);
export function recordGuidance(store:Store,replyId:string,type:string,key:string,text:string,now:number){
 store.db.prepare('INSERT OR IGNORE INTO kestrel_guidance_usage(reply_id,type,key,version,guidance,created_at) VALUES(?,?,?,?,?,?)').run(replyId,type,key,guidanceVersion(text),text.slice(0,600),now);
}
// Correlation only: no experimental control, no inferred usefulness or causal improvement.
export function learningMetrics(store:Store){
 const rows=store.db.prepare(`SELECT u.*,g.status AS generation_status,g.error_code,r.status AS reply_status,v.visibility,v.verification_status,
 EXISTS(SELECT 1 FROM social_incoming i WHERE i.parent_id=r.comment_id) AS received_response
 FROM kestrel_guidance_usage u LEFT JOIN social_generation g ON g.id=u.reply_id LEFT JOIN social_replies r ON r.id=u.reply_id LEFT JOIN social_visibility v ON v.reply_id=u.reply_id ORDER BY u.created_at DESC LIMIT 3000`).all();
 const groups=new Map<string,any>();
 for(const r of rows){const id=r.type+':'+r.key+':'+r.version;let m=groups.get(id);if(!m){m={type:r.type,key:r.key,version:r.version,guidance:r.guidance,uses:0,generation_failed:0,generated:0,published:0,visible:0,verified:0,received_response:0,pending:0,failures:{} as Record<string,number>};groups.set(id,m);}m.uses++;
 if(r.generation_status==='FAILED'){m.generation_failed++;const code=String(r.error_code||'unknown');m.failures[code]=(m.failures[code]||0)+1;}
 else if(r.generation_status==='GENERATED')m.generated++;
 else m.pending++;
 if(r.reply_status==='PUBLISHED')m.published++;
 if(r.visibility==='VISIBLE')m.visible++;
 if(r.reply_status==='PUBLISHED'||r.verification_status==='verified')m.verified++;
 if(r.received_response)m.received_response++;
 }
 return [...groups.values()];
}
