import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import {discoverDiscussions,draftReply,reviewReply,publishReply,verifyReply,updateSocialProfile,profileDescription} from './social.ts';
import { publishDraft, verifyPublication, createIntroduction } from './publishing.ts';
import { createOutreachDraft } from './operator.ts';
import { openStore, hash } from './store.ts';

const store=openStore(process.env.DATA_DIR || './data');
const adminKey=process.env.ADMIN_KEY || '';
if(adminKey && adminKey.length<32) throw new Error('ADMIN_KEY must be at least 32 characters');
const operator=process.env.OPERATOR_NAME || 'Kestrel';
const assets=new Map(['/','/app.js','/style.css','/skill.md','/admin','/admin.js'].map(path=>[path,readFileSync(fileURLToPath(new URL(`../public/${path==='/'?'index.html':path==='/admin'?'admin.html':path.slice(1)}`,import.meta.url)))]));
const limits=new Map<string,{count:number;until:number}>();
function limit(ip:string, scope:string, max:number) { const key=scope+ip, now=Date.now(); let entry=limits.get(key); if(!entry||entry.until<now) {entry={count:0,until:now+60000};limits.set(key,entry);} if(++entry.count>max) throw Object.assign(new Error('Too many requests; retry in a minute'),{status:429}); }
setInterval(()=>{for(const [key,v] of limits) if(v.until<Date.now()) limits.delete(key);},60000).unref();
function send(res:ServerResponse,status:number,data:unknown) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req:IncomingMessage) { let size=0; const chunks:Buffer[]=[]; for await (const chunk of req) {size+=chunk.length;if(size>65536) throw Object.assign(new Error('Request exceeds 64 KB'),{status:413});chunks.push(chunk);} try {return JSON.parse(Buffer.concat(chunks).toString());}catch {throw new Error('Expected a JSON request body');} }
function str(v:unknown,min:number,max:number,label:string) {if(typeof v!=='string'||v.length<min||v.length>max) throw new Error(`${label} must be ${min}–${max} characters`);return v;}
function integer(v:unknown) {if(!Number.isSafeInteger(v)||Number(v)<0||Number(v)>10000) throw new Error('Price must be an integer from 0 to 10000');return Number(v);}
const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url=new URL(req.url||'/', 'http://localhost'), path=url.pathname, method=req.method==='HEAD'?'GET':req.method;
    limit(req.socket.remoteAddress||'unknown','api',180);
    if(method==='GET'&&assets.has(path)) {res.writeHead(200,{'Content-Type':(path==='/'||path==='/admin')?'text/html; charset=utf-8':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/markdown; charset=utf-8'});res.end(req.method==='HEAD'?undefined:assets.get(path));return;}
    if(method==='GET'&&path==='/api/health') return send(res,200,{status:'ok',operator,credit_type:'test_only'});
    if(method==='GET'&&path==='/api/services') return send(res,200,{services:store.db.prepare(`SELECT s.id,s.name,s.description,s.category,s.price,s.builtin,a.name AS provider FROM services s LEFT JOIN agents a ON a.id=s.provider_id WHERE active=1 AND (s.provider_id IS NULL OR a.disabled=0) ORDER BY s.builtin DESC,s.name LIMIT 200`).all()});
    if(method==='GET'&&path==='/api/stats') return send(res,200,{agents:store.db.prepare(`SELECT count(*) AS n FROM agents`).get()?.n,services:store.db.prepare(`SELECT count(*) AS n FROM services WHERE active=1`).get()?.n,completed_jobs:store.db.prepare(`SELECT count(*) AS n FROM jobs WHERE status='COMPLETED'`).get()?.n,operator});
    if(method==='POST'&&path==='/api/agents/register') {
      limit(req.socket.remoteAddress||'unknown','register',5); const b=await body(req);const name=str(b.name,3,40,'Name');if(!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Name may contain letters, numbers, underscores and hyphens');
      return send(res,201,store.register(name,str(b.description||'Independent agent',1,500,'Description'),b.referral==null?null:str(b.referral,1,64,'Referral')));
    }
    if(path.startsWith('/api/admin/')) {
      const supplied=req.headers.authorization?.replace(/^Bearer /,'') || '';
      if(!adminKey || !timingSafeEqual(Buffer.from(hash(supplied)),Buffer.from(hash(adminKey)))) return send(res,401,{error:'Admin key required'});
      limit(req.socket.remoteAddress||'unknown','admin',60);
      if(method==='GET'&&path==='/api/admin/overview') return send(res,200,{
        operator:{...store.settings(),...store.db.prepare('SELECT heartbeat,status FROM operator_state WHERE id=1').get(),name:operator,openai_configured:Boolean(process.env.OPENAI_API_KEY)},
        agents:store.db.prepare('SELECT id,name,description,credits,disabled,created_at FROM agents ORDER BY rowid DESC LIMIT 200').all(),
        services:store.db.prepare('SELECT s.*,a.name AS provider FROM services s LEFT JOIN agents a ON a.id=s.provider_id ORDER BY s.rowid DESC LIMIT 200').all(),
        jobs:store.db.prepare('SELECT j.id,j.status,j.price,j.created_at,s.name AS service,a.name AS buyer FROM jobs j JOIN services s ON s.id=j.service_id JOIN agents a ON a.id=j.buyer_id ORDER BY j.rowid DESC LIMIT 100').all(),
        moltbook:store.db.prepare('SELECT name,status,checked_at,claim_url,error_code FROM moltbook_state WHERE id=1').get(),
        monitor:store.db.prepare('SELECT checked_at,snapshot FROM operator_monitor WHERE id=1').get(),
        activity:store.db.prepare('SELECT kind,message,created_at FROM operator_events ORDER BY id DESC LIMIT 30').all(),
        social:{profile_description:profileDescription,scan:store.db.prepare('SELECT checked_at,error_code FROM social_scan WHERE id=1').get(),discussions:store.db.prepare('SELECT * FROM social_discussions ORDER BY seen_at DESC LIMIT 30').all(),replies:store.db.prepare('SELECT id,post_id,body,status,created_at,attempted_at,comment_id,challenge,expires_at,error_code FROM social_replies ORDER BY rowid DESC LIMIT 30').all()},
        referrals:store.db.prepare(`SELECT a.referral,count(DISTINCT a.id) AS registrations,count(DISTINCT CASE WHEN j.status='COMPLETED' THEN j.id END) AS completed_jobs FROM agents a LEFT JOIN jobs j ON j.buyer_id=a.id WHERE a.referral IS NOT NULL GROUP BY a.referral`).all(),
        publications:store.db.prepare('SELECT draft_id,title,submolt,status,attempted_at,post_id,challenge,expires_at,error_code FROM moltbook_publications ORDER BY attempted_at DESC LIMIT 30').all(),
        drafts:store.db.prepare('SELECT id,body,status,created_at FROM outreach_drafts ORDER BY rowid DESC LIMIT 30').all(),
        revenue:store.db.prepare("SELECT coalesce(sum(amount),0) AS credits FROM ledger WHERE kind='platform_test_revenue'").get()?.credits,
        runs:store.db.prepare('SELECT id,job_id,provider,model,status,error_code,created_at,started_ms,finished_ms FROM operator_runs ORDER BY rowid DESC LIMIT 30').all(),
        audit:store.db.prepare('SELECT action,target,created_at FROM admin_audit ORDER BY rowid DESC LIMIT 30').all()
      });
      if(method==='POST'&&path==='/api/admin/operator') {const b=await body(req);if(typeof b.enabled!=='boolean'||!['ollama','openai'].includes(b.provider))throw new Error('Invalid operator settings');const model=str(b.model,0,100,'Model');if(b.enabled&&!model.trim())throw new Error('Configure a model before enabling');if(b.enabled&&b.provider==='openai'&&!process.env.OPENAI_API_KEY)throw new Error('Set OPENAI_API_KEY in the private environment file first');const daily=integer(b.daily_limit);if(daily<1||daily>500)throw new Error('Daily request limit must be 1–500');store.setOperator(b.enabled,b.provider,model,daily);return send(res,200,{ok:true});}
      if(method==='POST'&&path==='/api/admin/drafts'){const b=await body(req);return send(res,201,createOutreachDraft(store,str(b.service_id,1,80,'Service ID')));}
      if(method==='POST'&&path==='/api/admin/social/discover')return send(res,200,await discoverDiscussions(store));
      if(method==='POST'&&path==='/api/admin/social/profile')return send(res,200,await updateSocialProfile(store));
      if(method==='POST'&&path==='/api/admin/social/drafts'){const b=await body(req);return send(res,201,draftReply(store,str(b.post_id,1,100,'Post ID')));}
      const replyMatch=path.match(/^\/api\/admin\/social\/replies\/([^/]+)(?:\/(publish|verify))?$/);
      if(method==='POST'&&replyMatch){const b=await body(req);return send(res,200,replyMatch[2]==='publish'?await publishReply(store,replyMatch[1]):replyMatch[2]==='verify'?await verifyReply(store,replyMatch[1],str(b.answer,4,40,'Answer')):reviewReply(store,replyMatch[1],str(b.body,20,2000,'Reply'),str(b.status,1,20,'Status')));}
      if(method==='POST'&&path==='/api/admin/introduction')return send(res,201,createIntroduction(store));
      const publicationMatch=path.match(/^\/api\/admin\/drafts\/([^/]+)\/(publish|verify)$/);
      if(method==='POST'&&publicationMatch){const b=await body(req);return send(res,200,publicationMatch[2]==='publish'?await publishDraft(store,publicationMatch[1],str(b.title,3,200,'Title'),str(b.submolt||'general',1,40,'Submolt')):await verifyPublication(store,publicationMatch[1],str(b.answer,4,40,'Answer')));}
      const draftMatch=path.match(/^\/api\/admin\/drafts\/([^/]+)$/);
      if(method==='POST'&&draftMatch){const b=await body(req);if(!['APPROVED','ARCHIVED'].includes(b.status))throw new Error('Draft status must be APPROVED or ARCHIVED');store.transaction(()=>{const changed=store.db.prepare('UPDATE outreach_drafts SET status=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM moltbook_publications WHERE draft_id=outreach_drafts.id)').run(b.status,draftMatch[1]);if(!changed.changes)throw new Error('Draft not found');store.audit('outreach_draft_'+b.status.toLowerCase(),draftMatch[1]);});return send(res,200,{ok:true});}
      const adminMatch=path.match(/^\/api\/admin\/(agents|services|jobs)\/([^/]+)$/);
      if(method==='POST'&&adminMatch){const b=await body(req),[,kind,id]=adminMatch;store.transaction(()=>{
        if(kind==='agents'){if(typeof b.disabled!=='boolean')throw new Error('disabled must be boolean');const changed=store.db.prepare('UPDATE agents SET disabled=? WHERE id=?').run(b.disabled?1:0,id);if(!changed.changes)throw new Error('Agent not found');store.audit(b.disabled?'suspend_agent':'restore_agent',id);}
        else if(kind==='services'){if(typeof b.active!=='boolean')throw new Error('active must be boolean');const service=store.db.prepare('SELECT builtin FROM services WHERE id=?').get(id);if(!service)throw new Error('Service not found');if(String(service.builtin).startsWith('ai-'))throw new Error('Use operator settings for AI services');store.db.prepare('UPDATE services SET active=? WHERE id=?').run(b.active?1:0,id);store.audit(b.active?'enable_service':'disable_service',id);}
        else {throw new Error('Use the refund endpoint');}
      });return send(res,200,{ok:true});}
      const refund=path.match(/^\/api\/admin\/refund\/([^/]+)$/);
      if(method==='POST'&&refund){store.settle(refund[1],'FAILED',JSON.stringify({error:'Refunded by administrator'}));store.audit('refund_job',refund[1]);return send(res,200,{ok:true});}
      return send(res,404,{error:'Admin endpoint not found'});
    }
    const token=req.headers.authorization?.replace(/^Bearer /,'');
    const agent=token?store.db.prepare(`SELECT id,name,description,credits,created_at FROM agents WHERE token_hash=? AND disabled=0`).get(hash(token)):undefined;
    if(!agent) return send(res,401,{error:'A valid Bearer API key is required'});
    if(method==='GET'&&path==='/api/me') return send(res,200,{...agent,credit_type:'test_only',ledger:store.db.prepare(`SELECT amount,kind,job_id,created_at FROM ledger WHERE agent_id=? ORDER BY rowid DESC LIMIT 100`).all(agent.id)});
    if(method==='POST'&&path==='/api/services') {const b=await body(req),id=crypto.randomUUID();store.db.prepare(`INSERT INTO services(id,provider_id,name,description,category,price) VALUES(?,?,?,?,?,?)`).run(id,agent.id,str(b.name,3,80,'Name'),str(b.description,10,1000,'Description'),str(b.category||'Other',1,40,'Category'),integer(b.price));return send(res,201,{id});}
    if(method==='GET'&&path==='/api/jobs') return send(res,200,{jobs:store.db.prepare(`SELECT j.*,s.name AS service_name,a.name AS buyer_name,s.provider_id FROM jobs j JOIN services s ON s.id=j.service_id JOIN agents a ON a.id=j.buyer_id WHERE j.buyer_id=? OR s.provider_id=? ORDER BY j.rowid DESC LIMIT 100`).all(agent.id,agent.id)});
    if(method==='POST'&&path==='/api/jobs') {const b=await body(req),key=str(req.headers['idempotency-key'],8,100,'Idempotency-Key');const text=str(b.input?.text,0,40000,'Input text');return send(res,201,store.submit(String(agent.id),str(b.service_id,1,80,'Service ID'),JSON.stringify({text}),key));}
    const match=path.match(/^\/api\/jobs\/([^/]+)\/(complete|fail|cancel)$/);
    if(method==='POST'&&match) {const b=await body(req);const status=match[2]==='complete'?'COMPLETED':match[2]==='fail'?'FAILED':'CANCELLED';return send(res,200,store.settle(match[1],status,JSON.stringify(b.result??{message:'Cancelled'}),String(agent.id)));}
    return send(res,404,{error:'Endpoint not found'});
  }catch(e:any) {const message=e.message||'Request failed';const status=e.status||(message.includes('UNIQUE')?409:message.includes('Not authorized')?403:400);send(res,status,{error:message.includes('UNIQUE')?'Agent name is already registered':message});}
});
const timer=setInterval(()=>store.tick(),1000);timer.unref();
server.listen(Number(process.env.PORT||9003),process.env.HOST||'127.0.0.1',()=>console.log(`Literate Bassoon listening on ${process.env.HOST||'127.0.0.1'}:${process.env.PORT||9003}; ${operator} processes built-in jobs`));
function stop(){clearInterval(timer);server.close(()=>{store.db.close();process.exit(0);});}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
