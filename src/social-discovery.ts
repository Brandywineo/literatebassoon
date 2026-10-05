import type {openStore} from './store.ts';
import {existsSync} from 'node:fs';
import {request,credentials,credentialPath} from './moltbook.ts';
type Store=ReturnType<typeof openStore>;
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(v);
const topics=/agent|tool|task|queue|memory|api|delegat|workflow|retr(?:y|ies)|context|idempoten|model|summar|writing|collaborat|rate.limit/i;
const queries=['How do agents make delegated tasks and retries reliable?','How do agents preserve memory and context accurately?','Agents collaborating through APIs and useful text tools','Agent workflow failures, result verification and rate limits'];
const communities=['agentops','agents','tools','general'];
const code=(e:unknown)=>e instanceof Error&&/^moltbook_(?:http_\d{3}|response_too_large)$/.test(e.message)?e.message:'source_connection_or_response_error';
export async function discoverDiscussions(store:Store,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now()){
 if(!existsSync(path))return {skipped:true};
 const slot=Math.floor(now/1800000);
 const reserved=store.transaction(()=>{const last=store.db.prepare('SELECT checked_at FROM social_scan WHERE id=1').get();if(last&&now-Number(last.checked_at)<1800000)return false;store.db.prepare("INSERT INTO social_scan(id,checked_at,snapshot) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,error_code=NULL,snapshot=excluded.snapshot,completed_at=NULL").run(now,JSON.stringify({status:'RUNNING',sources:[],fetched:0,considered:0,selected:0,detail_reads:0,accepted:0,rejections:{},samples:[]}));return true;});if(!reserved)return {skipped:true};
 const snapshot:any={status:'COMPLETED',sources:[],fetched:0,considered:0,selected:0,detail_reads:0,accepted:0,rejections:{},samples:[]};
 const reject=(reason:string,p:any,source:string)=>{snapshot.rejections[reason]=(snapshot.rejections[reason]||0)+1;if(snapshot.samples.length<12)snapshot.samples.push({id:identifier(p?.id)?p.id:null,source,reason});};
 const finish=(error:string|null)=>{store.db.prepare('UPDATE social_scan SET completed_at=?,error_code=?,snapshot=? WHERE id=1 AND checked_at=?').run(Date.now(),error,JSON.stringify(snapshot),now);};
 try{
  const c=credentials(path);
  const sources=[{name:'search:reliability',path:'/search?'+new URLSearchParams({q:queries[slot%queries.length],type:'posts',limit:'30'}),key:'results'}, {name:'search:collaboration',path:'/search?'+new URLSearchParams({q:queries[(slot+1)%queries.length],type:'posts',limit:'30'}),key:'results'}, {name:'recent',path:'/posts?sort=new&limit=20',key:'posts'}, {name:'community:'+communities[slot%communities.length],path:'/posts?'+new URLSearchParams({submolt:communities[slot%communities.length],sort:'new',limit:'20'}),key:'posts'}];
  const outcomes=await Promise.allSettled(sources.map(s=>request(s.path,c.api_key,undefined,fetcher,undefined,524288)));
  const buckets:any[][]=[];
  for(let i=0;i<sources.length;i++){const s=sources[i],result=outcomes[i];if(result.status==='rejected'){snapshot.sources.push({name:s.name,fetched:0,error_code:code(result.reason)});buckets.push([]);continue;}const data=result.value;if(data.success===false||!Array.isArray(data[s.key])){snapshot.sources.push({name:s.name,fetched:0,error_code:'invalid_source_shape'});buckets.push([]);continue;}const rows=data[s.key].slice(0,s.key==='results'?30:20);snapshot.sources.push({name:s.name,fetched:rows.length,error_code:null});snapshot.fetched+=rows.length;buckets.push(rows.map((p:any)=>({p,source:s.name})));}
  // Interleave sources so a busy global feed cannot consume every detail slot.
  const candidates:any[]=[];for(let row=0;row<30;row++)for(const bucket of buckets)if(bucket[row])candidates.push(bucket[row]);
  const authors=new Map<string,number>(),seen=new Set<string>(),selected:any[]=[];
  for(const {p,source} of candidates){snapshot.considered++;
   if(!p||(p.type&&p.type!=='post'&&p.type!=='text')||!identifier(p.id)||typeof p.author?.name!=='string'){reject('malformed_candidate',p,source);continue;}
   if(seen.has(p.id)){reject('duplicate_candidate',p,source);continue;}seen.add(p.id);
   if(p.author.name.toLowerCase()===c.name.toLowerCase()){reject('own_post',p,source);continue;}
   if(store.db.prepare('SELECT id FROM social_replies WHERE post_id=? AND parent_id IS NULL').get(p.id)||store.db.prepare('SELECT id FROM social_generation WHERE post_id=? AND parent_id IS NULL').get(p.id)){reject('already_handled',p,source);continue;}
   const date=typeof p.created_at==='string'?Date.parse(p.created_at):NaN;if(Number.isFinite(date)&&(now-date>7*86400000||date>now+300000)){reject('outside_freshness_window',p,source);continue;}
   if(!source.startsWith('search:')&&!topics.test(String(p.title||'')+' '+String(p.content||''))){reject('unrelated_topic',p,source);continue;}
   const author=p.author.name.toLowerCase();if((authors.get(author)||0)>=2){reject('author_limit',p,source);continue;}
   if(selected.length>=6){reject('detail_budget',p,source);continue;}
   authors.set(author,(authors.get(author)||0)+1);selected.push({p,source});
  }
  snapshot.selected=selected.length;let found=0,failed=0;
  const details=await Promise.allSettled(selected.map(({p})=>request('/posts/'+p.id,c.api_key,undefined,fetcher,undefined,131072)));snapshot.detail_reads=selected.length;
  const acceptedAuthors=new Map<string,number>();
  for(let i=0;i<selected.length;i++){const {p:candidate,source}=selected[i];const result=details[i];if(result.status==='rejected'){failed++;reject('detail_'+code(result.reason),candidate,source);continue;}const detail=result.value,p=detail.post;
   if(detail.success===false||p?.id!==candidate.id||typeof p.title!=='string'||typeof p.content!=='string'||typeof p.author?.name!=='string'||p.content.length<20||p.content.length>20000||p.author.name.length>80){failed++;reject('invalid_post_detail',candidate,source);continue;}
   if(p.is_spam===true||p.is_deleted===true){reject('moderated_post',p,source);continue;}
   const author=p.author.name.toLowerCase();if(author===c.name.toLowerCase()){reject('own_post',p,source);continue;}if(p.author.name!==candidate.author.name){reject('author_changed',p,source);continue;}
   if((acceptedAuthors.get(author)||0)>=2){reject('author_limit',p,source);continue;}
   const created=typeof p.created_at==='string'?Date.parse(p.created_at):NaN;if(!Number.isFinite(created)){reject('missing_post_date',p,source);continue;}if(now-created>7*86400000||created>now+300000){reject('outside_freshness_window',p,source);continue;}
   if(!topics.test(p.title+' '+p.content)){reject('unrelated_full_post',p,source);continue;}
   store.db.prepare('INSERT INTO social_discussions(id,title,body,author,community,seen_at,full_content,source_created_at) VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,author=excluded.author,community=excluded.community,seen_at=excluded.seen_at,full_content=1,source_created_at=excluded.source_created_at').run(p.id,p.title.slice(0,300),p.content,p.author.name,String(p.submolt?.name||candidate.submolt?.name||'general').slice(0,80),now,p.created_at);acceptedAuthors.set(author,(acceptedAuthors.get(author)||0)+1);found++;
  }
  snapshot.accepted=found;
  const protectedPosts="SELECT post_id FROM social_replies UNION SELECT post_id FROM social_incoming UNION SELECT post_id FROM social_generation";
  store.db.exec('DELETE FROM social_discussions WHERE id NOT IN ('+protectedPosts+') AND id NOT IN (SELECT id FROM social_discussions ORDER BY seen_at DESC LIMIT 100)');
  const sourceFailures=snapshot.sources.filter((s:any)=>s.error_code).length;
  snapshot.status=sourceFailures===sources.length?'FAILED':sourceFailures||failed?'PARTIAL':'COMPLETED';
  finish(sourceFailures===sources.length?'all_discovery_sources_failed':sourceFailures||failed?'discovery_partial_failure':null);
  return {found,detail_failures:failed};
 }catch(e){snapshot.status='FAILED';const error=code(e);finish(error);return {error_code:error};}
}
