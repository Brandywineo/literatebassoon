import type {openStore} from './store.ts';
import {request,credentials,credentialPath} from './moltbook.ts';
type Store=ReturnType<typeof openStore>;
export function recordObservation(store:Store,target:string,surface:string,item:any,matched:boolean,now:number){
 const state=!item?'NOT_OBSERVED':!matched?'MISMATCH':item.is_deleted===true?'DELETED':item.is_spam===true?'SPAM':item.is_spam===false?'CLEAR':'UNKNOWN';
 const visibility=!item?'NOT_OBSERVED':!matched?'MISMATCH':item.is_deleted===true?'DELETED':'PRESENT';
 const verification=matched&&['pending','verified','failed'].includes(item?.verification_status)?item.verification_status:null;
 store.transaction(()=>{
  const old=store.db.prepare('SELECT * FROM social_observations WHERE target=? AND surface=?').get(target,surface);
  if(!old||old.moderation!==state||old.visibility!==visibility||old.verification_status!==verification)store.db.prepare('INSERT INTO social_observation_history(target,surface,moderation,visibility,verification_status,observed_at) VALUES(?,?,?,?,?,?)').run(target,surface,state,visibility,verification,now);
  store.db.prepare(`INSERT INTO social_observations(target,surface,moderation,visibility,verification_status,checked_at,first_spam_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(target,surface) DO UPDATE SET moderation=excluded.moderation,visibility=excluded.visibility,verification_status=excluded.verification_status,checked_at=excluded.checked_at,first_spam_at=COALESCE(social_observations.first_spam_at,excluded.first_spam_at)`).run(target,surface,state,visibility,verification,now,state==='SPAM'?now:null);
  if(state==='SPAM')store.db.prepare('INSERT OR IGNORE INTO kestrel_incidents(id,source,code,observation,created_at) VALUES(?,?,?,?,?)').run('moderation:'+target,target,'moltbook_spam_observed','Moltbook explicitly marked this content as spam. Delivery and verification may still have succeeded. The cause is unknown; do not infer that links or challenge arithmetic caused it.',now);
 });
 return {moderation:state,visibility,verification};
}
export function moderationPolicy(store:Store,now=Date.now()){
 const rows=store.db.prepare('SELECT target,min(first_spam_at) AS first_at FROM social_observations WHERE first_spam_at IS NOT NULL GROUP BY target ORDER BY first_at DESC').all();
 const recent=rows.filter(r=>now-Number(r.first_at)<86400000);
 const cooldown_until=Math.max(0,...rows.map(r=>{const at=Number(r.first_at),repeated=rows.some(other=>other.target!==r.target&&Number(other.first_at)<=at&&at-Number(other.first_at)<86400000);return at+(repeated?86400000:6*3600000);}));
 return {restricted_items:rows.length,recent_restrictions:recent.length,cooldown_until:cooldown_until>now?cooldown_until:null,promotion_allowed:!rows.some(r=>now-Number(r.first_at)<7*86400000),reason:cooldown_until>now?'moderation_cooldown':null};
}
export function assertModerationAllowsWrite(store:Store,body:string,now:number){
 const policy=moderationPolicy(store,now);
 if(policy.cooldown_until)throw Error('moderation_cooldown');
 if(!policy.promotion_allowed&&/literate bassoon|test credits|exchange link|clicknlist/i.test(body))throw Error('moderation_promotion_cooldown');
}
export async function reconcileProfileAndPosts(store:Store,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now()){
 const reserved=store.transaction(()=>{const row=store.db.prepare('SELECT checked_at FROM social_reconciliation WHERE id=1').get()!;if(now-Number(row.checked_at)<1800000)return false;store.db.prepare('UPDATE social_reconciliation SET checked_at=?,error_code=NULL WHERE id=1').run(now);return true;});if(!reserved)return {skipped:true};
 let failures=0;
 try{
  const c=credentials(path);
  try{const profile=await request('/agents/profile?'+new URLSearchParams({name:c.name}),c.api_key,undefined,fetcher);
  if(profile.success===false||profile.agent?.name?.toLowerCase()!==c.name.toLowerCase()||!Array.isArray(profile.recentComments))throw Error('invalid_profile');
  for(const row of store.db.prepare('SELECT id,comment_id,post_id,body FROM social_replies WHERE comment_id IS NOT NULL ORDER BY attempted_at DESC LIMIT 30').all()){
   const item=profile.recentComments.find((i:any)=>i.id===row.comment_id);
   recordObservation(store,'reply:'+row.id,'profile_api',item,Boolean(item&&item.content===row.body&&item.post?.id===row.post_id),now);
  }
  }catch{failures++;}
  const posts=store.db.prepare('SELECT p.draft_id,p.post_id,p.title,d.body FROM moltbook_publications p JOIN outreach_drafts d ON d.id=p.draft_id WHERE p.post_id IS NOT NULL ORDER BY p.attempted_at DESC LIMIT 5').all();
  for(const row of posts){try{const result=await request('/posts/'+row.post_id,c.api_key,undefined,fetcher),p=result.post;if(result.success===false)throw Error('invalid_post');recordObservation(store,'post:'+row.draft_id,'post_api',p,Boolean(p&&p.id===row.post_id&&p.title===row.title&&p.content===row.body&&p.author?.name?.toLowerCase()===c.name.toLowerCase()),now);}catch{failures++;}}
 }catch{failures++;}
 store.db.prepare('UPDATE social_reconciliation SET error_code=? WHERE id=1').run(failures?'observation_reads_failed_'+failures:null);
 return {failures};
}
