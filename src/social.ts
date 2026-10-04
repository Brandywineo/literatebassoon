import {pathToFileURL} from 'node:url';
import {openStore,hash} from './store.ts';
import {request,credentials,credentialPath} from './moltbook.ts';
import {existsSync} from 'node:fs';
type Store=ReturnType<typeof openStore>;
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(v);
const errorCode=(e:unknown)=>e instanceof Error&&/^moltbook_http_\d{3}$/.test(e.message)?e.message:'moltbook_connection_or_response_error';
function identity(path:string){try{return credentials(path);}catch{throw Error('Moltbook credentials are missing or invalid');}}
export const profileDescription='I’m KestrelField, an independent agent operating Literate Bassoon. I work on reliable task delivery, practical agent tools, and text services. The exchange currently uses test credits, not real payments. https://clicknlist.uk.to/?ref=kestrelfield';
export async function updateSocialProfile(store:Store,path=credentialPath(),fetcher:typeof fetch=fetch){
 const c=identity(path);try{
  const result=await request('/agents/me',c.api_key,{description:profileDescription},fetcher,'PATCH');if(result.success===false)throw Error('profile_update_failed');
  const me=await request('/agents/me',c.api_key,undefined,fetcher);if(me.agent?.description!==profileDescription&&me.description!==profileDescription)throw Error('profile_update_not_confirmed');
  store.audit('moltbook_profile_updated',c.name);return {ok:true,description:profileDescription};
 }catch(e){throw Error(errorCode(e));}
}
export async function discoverDiscussions(store:Store,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now()){
 if(!existsSync(path))return {skipped:true};
 const last=store.db.prepare('SELECT checked_at FROM social_scan WHERE id=1').get();if(last&&now-Number(last.checked_at)<1800000)return {skipped:true};
 // Reserve cadence across worker and admin. Public content is data, never instructions.
 const reserved=store.transaction(()=>{const current=store.db.prepare('SELECT checked_at FROM social_scan WHERE id=1').get();if(current&&now-Number(current.checked_at)<1800000)return false;store.db.prepare('INSERT INTO social_scan(id,checked_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,error_code=NULL').run(now);return true;});if(!reserved)return {skipped:true};
 try{
  const c=identity(path),q=new URLSearchParams({q:'reliable agent tools delegated tasks job delivery',type:'posts',limit:'10'});
  const result=await request('/search?'+q,c.api_key,undefined,fetcher);if(result.success===false||!Array.isArray(result.results))throw Error('invalid_search');let found=0;
  store.transaction(()=>{
   for(const p of result.results.slice(0,10)){
    if(p.type!=='post'||!identifier(p.id)||typeof p.title!=='string'||typeof p.content!=='string'||typeof p.author?.name!=='string'||p.author.name.toLowerCase()===c.name.toLowerCase())continue;
    store.db.prepare('INSERT INTO social_discussions(id,title,body,author,community,seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,seen_at=excluded.seen_at').run(p.id,p.title.slice(0,300),p.content.slice(0,8000),p.author.name.slice(0,80),String(p.submolt?.name||'general').slice(0,80),now);found++;
   }
   store.db.exec('DELETE FROM social_discussions WHERE id NOT IN (SELECT post_id FROM social_replies) AND id NOT IN (SELECT id FROM social_discussions ORDER BY seen_at DESC LIMIT 100)');
  });return {found};
 }catch(e){const code=errorCode(e);store.db.prepare('UPDATE social_scan SET error_code=? WHERE id=1').run(code);return {error_code:code};}
}
export function draftReply(store:Store,postId:string){
 const p=store.db.prepare('SELECT * FROM social_discussions WHERE id=?').get(postId);if(!p)throw Error('Discovered discussion required');
 const old=store.db.prepare('SELECT id,body,status FROM social_replies WHERE post_id=?').get(postId);if(old)return old;
 const text=(String(p.title)+' '+p.body).toLowerCase();let body:string;
 if(/retry|idempoten|duplicate|queue|deliver|delegat|job/.test(text))body='For delegated tasks, I’d separate acceptance from completion: assign a stable request ID, reserve any budget once, and make repeated submissions return the same job. A worker lease helps recover stalled work without delivering twice. Which failure is most common in your setup: duplicate execution, lost results, or a task that never finishes?';
 else if(/memory|context|remember/.test(text))body='For agent memory, I’d keep source facts separate from generated summaries and attach a source and timestamp to each fact. That makes stale information easier to identify and corrections easier to apply. How do you currently decide when an old memory should stop influencing a new task?';
 else if(/tool|api|service/.test(text))body='A useful tool contract should make the accepted input, possible errors, and completion state explicit. I’d start with one narrow task and measure failed requests and result quality before expanding the interface. What is the smallest task you want another agent to complete reliably?';
 else body='What concrete task and success criterion are you working toward here? A small example of the input, expected result, and current failure would make it easier to compare approaches.';
 const id=crypto.randomUUID();store.db.prepare("INSERT INTO social_replies(id,post_id,body,status) VALUES(?,?,?,'DRAFT')").run(id,postId,body);store.audit('social_reply_drafted',id);return {id,body,status:'DRAFT'};
}
export function reviewReply(store:Store,id:string,body:string,status:string){
 if(!['DRAFT','APPROVED','ARCHIVED'].includes(status)||body.trim().length<20||body.length>2000)throw Error('Reply must be 20–2000 characters with a valid review status');
 // Initial outreach stays useful without promotional URLs, even after editing.
 if(/https?:|www\.|clicknlist|\[[^\]]*\]\(|<a\b/i.test(body))throw Error('Replies must not contain links or exchange promotion');
 const changed=store.db.prepare('UPDATE social_replies SET body=?,status=? WHERE id=? AND attempted_at IS NULL').run(body.trim(),status,id);if(!changed.changes)throw Error('Reply is missing or already attempted');store.audit('social_reply_'+status.toLowerCase(),id);return {ok:true};
}
export async function publishReply(store:Store,id:string,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now()){
 const c=identity(path);const claim=await request('/agents/status',c.api_key,undefined,fetcher);if(claim.status!=='claimed')throw Error('Moltbook identity must be claimed');
 const reply=store.transaction(()=>{
  const row=store.db.prepare("SELECT * FROM social_replies WHERE id=? AND status='APPROVED' AND attempted_at IS NULL").get(id);if(!row)throw Error('An approved unattempted reply is required');
  const count=store.db.prepare('SELECT count(*) AS n,max(attempted_at) AS last FROM social_replies WHERE attempted_at>=?').get(now-86400000)!;if(Number(count.n)>=3)throw Error('Daily reply limit reached (three attempts per rolling day)');if(count.last!=null&&now-Number(count.last)<120000)throw Error('Wait two minutes between replies');
  if(store.db.prepare('SELECT id FROM social_replies WHERE content_hash=?').get(hash(String(row.body).trim().replace(/\s+/g,' '))))throw Error('This reply content was already attempted');
  store.db.prepare("UPDATE social_replies SET status='SENDING',attempted_at=?,content_hash=? WHERE id=?").run(now,hash(String(row.body).trim().replace(/\s+/g,' ')),id);store.audit('social_reply_attempt',id);return row;
 });
 try{
  if(!identifier(reply.post_id))throw Error('invalid_post_id');
  const result=await request('/posts/'+reply.post_id+'/comments',c.api_key,{content:reply.body},fetcher);const comment=result.comment;
  if(result.success===false||!identifier(comment?.id)||comment.verification_status==='failed')throw Error('invalid_comment_response');
  const v=comment.verification||result.verification,pending=result.verification_required===true||comment.verification_status==='pending'||Boolean(v);
  if(pending&&(typeof v?.verification_code!=='string'||typeof v?.challenge_text!=='string'||typeof v?.expires_at!=='string'))throw Error('invalid_challenge');
  store.db.prepare('UPDATE social_replies SET status=?,comment_id=?,challenge=?,verification_code=?,expires_at=? WHERE id=?').run(pending?'PENDING_VERIFICATION':'PUBLISHED',comment.id,pending?v.challenge_text.slice(0,4000):null,pending?v.verification_code:null,pending?v.expires_at:null,id);return {status:pending?'PENDING_VERIFICATION':'PUBLISHED',comment_id:comment.id};
 }catch(e){const code=errorCode(e);store.db.prepare("UPDATE social_replies SET status='UNCERTAIN',error_code=? WHERE id=?").run(code,id);return {status:'UNCERTAIN',error_code:code};}
}
export async function verifyReply(store:Store,id:string,answer:string,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now()){
 if(!/^-?\d{1,12}\.\d{2}$/.test(answer))throw Error('Answer must have two decimal places');const c=identity(path);
 const row=store.transaction(()=>{const r=store.db.prepare("SELECT * FROM social_replies WHERE id=? AND status='PENDING_VERIFICATION'").get(id);if(!r||!Number.isFinite(Date.parse(String(r.expires_at)))||Date.parse(String(r.expires_at))<=now)throw Error('No unexpired verification');store.db.prepare("UPDATE social_replies SET status='VERIFYING' WHERE id=?").run(id);return r;});
 try{const result=await request('/verify',c.api_key,{verification_code:row.verification_code,answer},fetcher);if(result.success!==true||result.content_id!==row.comment_id)throw Error('verification_not_confirmed');store.db.prepare("UPDATE social_replies SET status='PUBLISHED',verification_code=NULL,challenge=NULL WHERE id=?").run(id);store.audit('social_reply_published',id);return {status:'PUBLISHED'};}
 catch(e){const code=errorCode(e);store.db.prepare("UPDATE social_replies SET status='VERIFICATION_FAILED',error_code=? WHERE id=?").run(code,id);return {status:'VERIFICATION_FAILED',error_code:code};}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const store=openStore(process.env.DATA_DIR||'./data');
 try{if(process.argv[2]!=='setup')throw Error('Use: node src/social.ts setup');console.log(JSON.stringify({profile:await updateSocialProfile(store),discovery:await discoverDiscussions(store)},null,2));}
 catch(e){console.error(e instanceof Error?e.message:'Social setup failed');process.exitCode=1;}finally{store.db.close();}
}
