import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openStore, hash } from './store.ts';

const store=openStore(process.env.DATA_DIR || './data');
const operator=process.env.OPERATOR_NAME || 'Kestrel';
const assets=new Map(['/','/app.js','/style.css','/skill.md'].map(path=>[path,readFileSync(fileURLToPath(new URL(`../public/${path==='/'?'index.html':path.slice(1)}`,import.meta.url)))]));
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
    const url=new URL(req.url||'/', 'http://localhost'), path=url.pathname, method=req.method;
    limit(req.socket.remoteAddress||'unknown','api',180);
    if(method==='GET'&&assets.has(path)) {res.writeHead(200,{'Content-Type':path==='/'?'text/html; charset=utf-8':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/markdown; charset=utf-8'});res.end(assets.get(path));return;}
    if(method==='GET'&&path==='/api/health') return send(res,200,{status:'ok',operator,credit_type:'test_only'});
    if(method==='GET'&&path==='/api/services') return send(res,200,{services:store.db.prepare(`SELECT s.id,s.name,s.description,s.category,s.price,s.builtin,a.name AS provider FROM services s LEFT JOIN agents a ON a.id=s.provider_id WHERE active=1 ORDER BY s.builtin DESC,s.name LIMIT 200`).all()});
    if(method==='GET'&&path==='/api/stats') return send(res,200,{agents:store.db.prepare(`SELECT count(*) AS n FROM agents`).get()?.n,services:store.db.prepare(`SELECT count(*) AS n FROM services WHERE active=1`).get()?.n,completed_jobs:store.db.prepare(`SELECT count(*) AS n FROM jobs WHERE status='COMPLETED'`).get()?.n,operator});
    if(method==='POST'&&path==='/api/agents/register') {
      limit(req.socket.remoteAddress||'unknown','register',5); const b=await body(req);const name=str(b.name,3,40,'Name');if(!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Name may contain letters, numbers, underscores and hyphens');
      return send(res,201,store.register(name,str(b.description||'Independent agent',1,500,'Description')));
    }
    const token=req.headers.authorization?.replace(/^Bearer /,'');
    const agent=token?store.db.prepare(`SELECT id,name,description,credits,created_at FROM agents WHERE token_hash=?`).get(hash(token)):undefined;
    if(!agent) return send(res,401,{error:'A valid Bearer API key is required'});
    if(method==='GET'&&path==='/api/me') return send(res,200,{...agent,credit_type:'test_only',ledger:store.db.prepare(`SELECT amount,kind,job_id,created_at FROM ledger WHERE agent_id=? ORDER BY rowid DESC LIMIT 100`).all()});
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
