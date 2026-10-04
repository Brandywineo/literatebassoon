import type {openStore} from './store.ts';
import {request,credentials,credentialPath} from './moltbook.ts';
type Store=ReturnType<typeof openStore>;
const valid=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(v);
// The API returns a nested tree; nesting is data, never instructions or URLs.
export function flattenComments(tree:unknown){
 if(!Array.isArray(tree))throw Error('invalid_comment_tree');
 const result:any[]=[],stack=tree.slice(0,200).map(comment=>({comment,parent:null as string|null,depth:0}));
 while(stack.length&&result.length<200){const {comment:c,parent,depth}=stack.shift()!;if(!c||!valid(c.id))continue;
  const parentId=c.parent_id??parent;result.push({...c,parent_id:parentId});
  if(depth<8&&Array.isArray(c.replies))stack.unshift(...c.replies.slice(0,200-result.length).map((comment:any)=>({comment,parent:c.id,depth:depth+1})));
 }return result;
}
export async function readThread(postId:string,path:string,fetcher:typeof fetch,publicRead=true){
 if(!valid(postId))throw Error('invalid_post_id');
 const c=credentials(path),comments:any[]=[];let cursor:string|undefined;
 for(let page=0;page<2;page++){
  const query=new URLSearchParams({sort:'new',limit:'35',...(cursor?{cursor}:{})});
  const result=await request('/posts/'+postId+'/comments?'+query,publicRead?undefined:c.api_key,undefined,fetcher);
  if(result.success===false)throw Error('invalid_comment_response');comments.push(...flattenComments(result.comments));
  if(result.has_more!==true)break;
  if(typeof result.next_cursor!=='string'||result.next_cursor.length>500)throw Error('invalid_comment_cursor');cursor=result.next_cursor;
 }return comments.slice(0,400);
}
// Visibility is an independent observation; it never rewrites verification history.
export function observeComment(store:Store,row:any,comments:any[],name:string,now:number){
 const comment=comments.find(c=>c.id===row.comment_id);
 let visibility='NOT_OBSERVED',error:string|null=null,verification:string|null=null;
 if(comment){
  if(typeof comment.author?.name!=='string'||comment.author.name.toLowerCase()!==name.toLowerCase()||comment.content!==row.body||(comment.parent_id??null)!==(row.parent_id??null)){
   visibility='MISMATCH';error='public_comment_identity_or_content_mismatch';
  }else{
   visibility=comment.is_deleted===true?'DELETED':comment.is_spam===true?'VISIBLE_RESTRICTED':'VISIBLE';
   verification=['pending','verified','failed'].includes(comment.verification_status)?comment.verification_status:null;
  }
 }
 store.db.prepare(`INSERT INTO social_visibility(reply_id,visibility,checked_at,last_visible_at,verification_status,error_code) VALUES(?,?,?,?,?,?) ON CONFLICT(reply_id) DO UPDATE SET visibility=excluded.visibility,checked_at=excluded.checked_at,last_visible_at=COALESCE(excluded.last_visible_at,social_visibility.last_visible_at),verification_status=excluded.verification_status,error_code=excluded.error_code`).run(row.id,visibility,now,visibility==='VISIBLE'||visibility==='VISIBLE_RESTRICTED'?now:null,verification,error);
 return visibility==='VISIBLE';
}
export async function scanFollowups(store:Store,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now()){
 const cfg=store.db.prepare('SELECT enabled FROM social_autonomy WHERE id=1').get();if(!cfg?.enabled||!store.settings().enabled)return {skipped:true};
 const reserved=store.transaction(()=>{const row=store.db.prepare('SELECT checked_at FROM social_thread_scan WHERE id=1').get()!;if(now-Number(row.checked_at)<600000)return false;store.db.prepare('UPDATE social_thread_scan SET checked_at=?,error_code=NULL,threads_read=0 WHERE id=1').run(now);return true;});if(!reserved)return {skipped:true};
 let read=0,found=0;
 try{
  const own=store.db.prepare("SELECT id,post_id,parent_id,body,status,comment_id,attempted_at FROM social_replies WHERE comment_id IS NOT NULL AND attempted_at>=? ORDER BY attempted_at DESC LIMIT 30").all(now-7*86400000);
  const posts=[...new Set(own.map(r=>String(r.post_id)))].slice(0,5),c=credentials(path);let failures=0;
  for(const postId of posts){try{
   const comments=await readThread(postId,path,fetcher,true);read++;
   const visible=own.filter(r=>r.post_id===postId&&observeComment(store,r,comments,c.name,now));
   for(const incoming of comments){
    const parent=visible.find(r=>r.comment_id===incoming.parent_id);
    if(!parent||typeof incoming.content!=='string'||incoming.content.length<20||incoming.content.length>6000||typeof incoming.author?.name!=='string'||incoming.author.name.toLowerCase()===c.name.toLowerCase()||incoming.is_spam||incoming.is_deleted)continue;
    const created=Date.parse(incoming.created_at);if(!Number.isFinite(created)||created<Number(parent.attempted_at)||created>now+300000||now-created>7*86400000)continue;
    store.db.prepare('INSERT INTO social_incoming(id,post_id,parent_id,author,body,source_created_at,seen_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,seen_at=excluded.seen_at').run(incoming.id,postId,incoming.parent_id,incoming.author.name.slice(0,80),incoming.content,incoming.created_at,now);found++;
   }
  }catch{failures++;for(const r of own.filter(r=>r.post_id===postId))store.db.prepare(`INSERT INTO social_visibility(reply_id,visibility,checked_at,error_code) VALUES(?,'UNKNOWN',?,'public_thread_read_failed') ON CONFLICT(reply_id) DO UPDATE SET visibility='UNKNOWN',checked_at=excluded.checked_at,error_code=excluded.error_code`).run(r.id,now);}}
  store.db.prepare('UPDATE social_thread_scan SET threads_read=?,error_code=? WHERE id=1').run(read,failures?'thread_reads_failed_'+failures:null);
  store.db.exec('DELETE FROM social_incoming WHERE id NOT IN (SELECT parent_id FROM social_replies WHERE parent_id IS NOT NULL) AND id NOT IN (SELECT id FROM social_incoming ORDER BY seen_at DESC LIMIT 100)');
  return {threads_read:read,found,failures};
 }catch{store.db.prepare("UPDATE social_thread_scan SET error_code='thread_scan_failed',threads_read=? WHERE id=1").run(read);return {error_code:'thread_scan_failed'};}
}
