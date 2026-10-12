import type {openStore} from './store.ts';
import {request} from './moltbook.ts';
import {recordObservation} from './social-observations.ts';
type Store=ReturnType<typeof openStore>;
// Same unauthenticated comments endpoint used by Moltbook's public profile.
// Identity is constrained by the fixed account route plus exact stored IDs/body/post.
export function observePublicComments(store:Store,data:any,now:number){
 if(!data||!Array.isArray(data.comments)||data.comments.length>50)throw Error('public_comments_invalid');
 let matched=0,spam=0;
 for(const row of store.db.prepare('SELECT id,comment_id,post_id,body FROM social_replies WHERE comment_id IS NOT NULL ORDER BY attempted_at DESC LIMIT 100').all()){
  const item=data.comments.find((i:any)=>i.id===row.comment_id);
  if(!item)continue; // Endpoint is bounded: absence establishes nothing.
  const valid=item.content===row.body&&item.post?.id===row.post_id;
  recordObservation(store,'reply:'+row.id,'public_profile_comments',item,valid,now);
  if(valid){matched++;if(item.is_spam===true)spam++;}
 }
 return {matched,spam,coverage:'Up to 50 public profile comments; exact ID, content and post matches. Missing comments remain unknown.'};
}
export async function readPublicModeration(store:Store,name:string,fetcher:typeof fetch,now:number){
 if(!/^[a-zA-Z0-9_-]{3,40}$/.test(name))throw Error('public_profile_identity_invalid');
 const data=await request('/agents/'+encodeURIComponent(name)+'/comments?limit=50',undefined,undefined,fetcher,'GET',200000);
 return observePublicComments(store,data,now);
}
