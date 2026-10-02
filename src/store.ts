import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function openStore(dir: string) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(`${dir}/exchange.sqlite`);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, credits INTEGER NOT NULL CHECK(credits>=0), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS services(id TEXT PRIMARY KEY, provider_id TEXT REFERENCES agents(id), name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), builtin TEXT, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES agents(id), service_id TEXT NOT NULL REFERENCES services(id), status TEXT NOT NULL, input TEXT NOT NULL, result TEXT, price INTEGER NOT NULL, fee INTEGER NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, UNIQUE(buyer_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id), job_id TEXT REFERENCES jobs(id), amount INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  for (const s of [
    ['json-format','JSON formatter','Validate and pretty-print JSON. Deterministic output, no model required.','Data',2,'json'],
    ['text-stats','Text statistics','Count words, characters and lines in supplied text.','Text',1,'stats'],
    ['sha256','SHA-256 digest','Create a SHA-256 digest of supplied text.','Utilities',1,'hash']
  ]) db.prepare(`INSERT OR IGNORE INTO services(id,name,description,category,price,builtin) VALUES(?,?,?,?,?,?)`).run(...s);
  function transaction<T>(fn:()=>T):T { db.exec('BEGIN IMMEDIATE'); try { const v=fn(); db.exec('COMMIT'); return v; } catch(e) { db.exec('ROLLBACK'); throw e; } }
  function register(name:string, description:string) {
    const token=`lb_${randomBytes(32).toString('hex')}`, id=randomUUID();
    transaction(()=>{ db.prepare(`INSERT INTO agents(id,name,description,token_hash,credits) VALUES(?,?,?,?,100)`).run(id,name,description,hash(token)); db.prepare(`INSERT INTO ledger(id,agent_id,amount,kind) VALUES(?,?,100,?)`).run(randomUUID(),id,'welcome_test_credits'); });
    return {id,name,api_key:token,credits:100,credit_type:'test_only'};
  }
  function submit(buyer:string, service:string, input:string, key:string) {
    return transaction(()=>{
      const previous=db.prepare(`SELECT * FROM jobs WHERE buyer_id=? AND idempotency_key=?`).get(buyer,key);
      if(previous) { if(previous.service_id!==service || previous.input!==input) throw new Error('Idempotency key already used for a different request'); return previous; }
      const s=db.prepare(`SELECT * FROM services WHERE id=? AND active=1`).get(service);
      if(!s) throw new Error('Service not found');
      if(s.provider_id===buyer) throw new Error('You cannot buy your own service');
      const debit=db.prepare(`UPDATE agents SET credits=credits-? WHERE id=? AND credits>=?`).run(s.price,buyer,s.price);
      if(!debit.changes) throw new Error('Insufficient test credits');
      const id=randomUUID(),fee=Math.floor(Number(s.price)*0.1);
      db.prepare(`INSERT INTO jobs(id,buyer_id,service_id,status,input,price,fee,idempotency_key) VALUES(?,?,?,'QUEUED',?,?,?,?)`).run(id,buyer,service,input,s.price,fee,key);
      db.prepare(`INSERT INTO ledger(id,agent_id,job_id,amount,kind) VALUES(?,?,?,?,?)`).run(randomUUID(),buyer,id,-Number(s.price),'reserved');
      return db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id);
    });
  }
  function settle(id:string, status:'COMPLETED'|'FAILED'|'CANCELLED', result:string, actor?:string) {
    return transaction(()=>{
      const job=db.prepare(`SELECT j.*,s.provider_id,s.builtin FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.id=?`).get(id);
      if(!job) throw new Error('Job not found');
      if(actor && (status==='CANCELLED' ? job.buyer_id!==actor : job.provider_id!==actor)) throw new Error('Not authorized for this job');
      if(job.status!=='QUEUED') throw new Error('Job already settled');
      db.prepare(`UPDATE jobs SET status=?,result=?,completed_at=CURRENT_TIMESTAMP WHERE id=?`).run(status,result,id);
      const credit = status==='COMPLETED' ? Number(job.price)-Number(job.fee) : Number(job.price);
      const recipient = status==='COMPLETED' ? job.provider_id : job.buyer_id;
      if(recipient) { db.prepare(`UPDATE agents SET credits=credits+? WHERE id=?`).run(credit,recipient); db.prepare(`INSERT INTO ledger(id,agent_id,job_id,amount,kind) VALUES(?,?,?,?,?)`).run(randomUUID(),recipient,id,credit,status==='COMPLETED'?'earned':'refund'); }
      if(status==='COMPLETED') db.prepare(`INSERT INTO ledger(id,job_id,amount,kind) VALUES(?,?,?,?)`).run(randomUUID(),id,job.provider_id ? Number(job.fee) : Number(job.price),'platform_test_revenue');
      return db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id);
    });
  }
  function tick() {
    const jobs=db.prepare(`SELECT j.*,s.builtin FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.status='QUEUED' AND s.builtin IS NOT NULL LIMIT 20`).all();
    for(const j of jobs) { try {
      const input=JSON.parse(String(j.input)); let result;
      if(j.builtin==='json') result={formatted:JSON.stringify(JSON.parse(input.text),null,2)};
      else if(j.builtin==='hash') result={sha256:hash(input.text)};
      else result={characters:Array.from(input.text).length,words:input.text.trim()?input.text.trim().split(/\s+/u).length:0,lines:input.text.split('\n').length};
      settle(String(j.id),'COMPLETED',JSON.stringify(result));
    } catch(e) { settle(String(j.id),'FAILED',JSON.stringify({error:'Input could not be processed'})); } }
  }
  return {db,register,submit,settle,tick};
}
