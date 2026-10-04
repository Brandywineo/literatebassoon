import {initMoney,reserveMoney,settleMoney,asset} from './payments.ts';
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
  db.exec('BEGIN IMMEDIATE');
  function column(table:string,name:string,definition:string) {
    if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  column('agents','referral','TEXT');
  column('agents','disabled','INTEGER NOT NULL DEFAULT 0');
  column('jobs','claim_token','TEXT');
  column('jobs','lease_until','INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS operator_settings(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, provider TEXT NOT NULL DEFAULT 'ollama', model TEXT NOT NULL DEFAULT '', daily_limit INTEGER NOT NULL DEFAULT 50);
    INSERT OR IGNORE INTO operator_settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS operator_runs(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),provider TEXT,model TEXT,status TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS operator_state(id INTEGER PRIMARY KEY CHECK(id=1),heartbeat INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'offline');
    INSERT OR IGNORE INTO operator_state(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS admin_audit(id TEXT PRIMARY KEY,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  column('operator_runs','error_code','TEXT');
  column('operator_runs','started_ms','INTEGER');
  column('operator_runs','finished_ms','INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS operator_monitor(id INTEGER PRIMARY KEY CHECK(id=1),checked_at INTEGER NOT NULL,snapshot TEXT NOT NULL,signature TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_events(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS outreach_drafts(id TEXT PRIMARY KEY,service_id TEXT NOT NULL REFERENCES services(id),body TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  db.exec(`CREATE TABLE IF NOT EXISTS moltbook_state(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL,status TEXT NOT NULL,checked_at INTEGER NOT NULL,claim_url TEXT,error_code TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS moltbook_publications(draft_id TEXT PRIMARY KEY REFERENCES outreach_drafts(id),content_hash TEXT UNIQUE NOT NULL,title TEXT NOT NULL,submolt TEXT NOT NULL,status TEXT NOT NULL,attempted_at INTEGER NOT NULL,post_id TEXT,challenge TEXT,verification_code TEXT,expires_at TEXT,error_code TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS social_scan(id INTEGER PRIMARY KEY CHECK(id=1),checked_at INTEGER NOT NULL,error_code TEXT);
    CREATE TABLE IF NOT EXISTS social_discussions(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,author TEXT NOT NULL,community TEXT NOT NULL,seen_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS social_replies(id TEXT PRIMARY KEY,post_id TEXT UNIQUE NOT NULL REFERENCES social_discussions(id),body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'DRAFT',created_at TEXT DEFAULT CURRENT_TIMESTAMP,attempted_at INTEGER,content_hash TEXT,comment_id TEXT,challenge TEXT,verification_code TEXT,expires_at TEXT,error_code TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS social_reply_content ON social_replies(content_hash) WHERE content_hash IS NOT NULL;`);
  db.exec(`CREATE TABLE IF NOT EXISTS social_autonomy(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,checked_at INTEGER NOT NULL DEFAULT 0,error_code TEXT); INSERT OR IGNORE INTO social_autonomy(id) VALUES(1); CREATE TABLE IF NOT EXISTS social_generation(id TEXT PRIMARY KEY,post_id TEXT NOT NULL,started_at INTEGER NOT NULL,status TEXT NOT NULL,error_code TEXT);`);
  if(!db.prepare('PRAGMA table_info(social_replies)').all().some(c=>c.name==='parent_id')) {
    db.exec(`CREATE TABLE social_replies_next(id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES social_discussions(id),body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'DRAFT',created_at TEXT DEFAULT CURRENT_TIMESTAMP,attempted_at INTEGER,content_hash TEXT,comment_id TEXT,challenge TEXT,verification_code TEXT,expires_at TEXT,error_code TEXT,parent_id TEXT);
      INSERT INTO social_replies_next(id,post_id,body,status,created_at,attempted_at,content_hash,comment_id,challenge,verification_code,expires_at,error_code) SELECT id,post_id,body,status,created_at,attempted_at,content_hash,comment_id,challenge,verification_code,expires_at,error_code FROM social_replies;
      DROP TABLE social_replies; ALTER TABLE social_replies_next RENAME TO social_replies;
      CREATE UNIQUE INDEX social_reply_content ON social_replies(content_hash) WHERE content_hash IS NOT NULL;
      CREATE UNIQUE INDEX social_reply_root ON social_replies(post_id) WHERE parent_id IS NULL;
      CREATE UNIQUE INDEX social_reply_parent ON social_replies(parent_id) WHERE parent_id IS NOT NULL;`);
  }
  column('social_generation','parent_id','TEXT');
  column('social_autonomy','last_cycle_at','INTEGER NOT NULL DEFAULT 0');
  column('social_autonomy','last_reason','TEXT');
  column('social_autonomy','next_cycle_at','INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS social_thread_scan(id INTEGER PRIMARY KEY CHECK(id=1),checked_at INTEGER NOT NULL DEFAULT 0,error_code TEXT,threads_read INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO social_thread_scan(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS social_incoming(id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES social_discussions(id),parent_id TEXT NOT NULL,author TEXT NOT NULL,body TEXT NOT NULL,source_created_at TEXT NOT NULL,seen_at INTEGER NOT NULL);`);
  column('social_scan','snapshot','TEXT');
  column('social_scan','completed_at','INTEGER');
  column('social_discussions','full_content','INTEGER NOT NULL DEFAULT 0');
  column('social_discussions','source_created_at','TEXT');
  for(const [id,name,description,builtin] of [
    ['ai-summary','Kestrel · summarize text','Summarize supplied text using the configured AI model. Inputs may be sent to OpenAI if selected by the operator; check AI output.','ai-summary'],
    ['ai-rewrite','Kestrel · improve writing','Rewrite supplied text for clarity while preserving its meaning. Inputs may be sent to OpenAI if selected by the operator.','ai-rewrite']
  ]) db.prepare(`INSERT OR IGNORE INTO services(id,name,description,category,price,builtin,active) VALUES(?,?,?,'AI',5,?,0)`).run(id,name,description,builtin);
  for (const s of [
    ['json-format','JSON formatter','Validate and pretty-print JSON. Deterministic output, no model required.','Data',2,'json'],
    ['text-stats','Text statistics','Count words, characters and lines in supplied text.','Text',1,'stats'],
    ['sha256','SHA-256 digest','Create a SHA-256 digest of supplied text.','Utilities',1,'hash']
  ]) db.prepare(`INSERT OR IGNORE INTO services(id,name,description,category,price,builtin) VALUES(?,?,?,?,?,?)`).run(...s);
  initMoney(db);
  db.exec('COMMIT');
  function transaction<T>(fn:()=>T):T { db.exec('BEGIN IMMEDIATE'); try { const v=fn(); db.exec('COMMIT'); return v; } catch(e) { db.exec('ROLLBACK'); throw e; } }
  function register(name:string, description:string, referral:string|null=null) {
    if(referral!==null&&!/^[a-zA-Z0-9_-]{1,64}$/.test(referral))throw Error('Invalid referral source');
    const token=`lb_${randomBytes(32).toString('hex')}`, id=randomUUID();
    transaction(()=>{ db.prepare(`INSERT INTO agents(id,name,description,token_hash,credits,referral) VALUES(?,?,?,?,100,?)`).run(id,name,description,hash(token),referral); db.prepare(`INSERT INTO ledger(id,agent_id,amount,kind) VALUES(?,?,100,?)`).run(randomUUID(),id,'welcome_test_credits'); });
    return {id,name,api_key:token,credits:100,credit_type:'test_only'};
  }
  function submit(buyer:string, service:string, input:string, key:string, paymentAsset:string|null=null,expectedAmount:string|null=null) {
    return transaction(()=>{
      const previous=db.prepare(`SELECT * FROM jobs WHERE buyer_id=? AND idempotency_key=?`).get(buyer,key);
      if(previous) { if(previous.service_id!==service || previous.input!==input || (previous.money_asset||null)!==paymentAsset || paymentAsset&&previous.money_amount!==expectedAmount) throw new Error('Idempotency key already used for a different request'); return previous; }
      if(!db.prepare('SELECT id FROM agents WHERE id=? AND disabled=0').get(buyer)) throw new Error('Agent is suspended');
      const s=db.prepare(`SELECT * FROM services WHERE id=? AND active=1`).get(service);
      if(!s) throw new Error('Service not found');
      if(s.provider_id && !db.prepare('SELECT id FROM agents WHERE id=? AND disabled=0').get(s.provider_id)) throw new Error('Provider is suspended');
      if(String(s.builtin).startsWith('ai-')) {
        const cfg=settings();
        if(!cfg.enabled) throw new Error('Kestrel is paused');
        const used=db.prepare("SELECT count(*) AS n FROM operator_runs WHERE date(created_at)=date('now')").get()!;
        const waiting=db.prepare("SELECT count(*) AS n FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.status='QUEUED' AND s.builtin IN ('ai-summary','ai-rewrite') AND j.claim_token IS NULL").get()!;
        if(Number(used.n)+Number(waiting.n)>=Number(cfg.daily_limit)) throw new Error('Kestrel daily capacity is reached; try again tomorrow');
        if(JSON.parse(input).text.length>12000) throw new Error('AI input exceeds 12000 characters');
      }
      if(s.provider_id===buyer) throw new Error('You cannot buy your own service');
      const id=randomUUID(),fee=Math.floor(Number(s.price)*0.1);
      let money:{amount:string;fee:string}|undefined;
      if(paymentAsset){if(process.env.PAYMENTS_ALLOW_LIVE!=='1'||!db.prepare('SELECT enabled FROM money_settings WHERE id=1').get()?.enabled)throw Error('Real payments are paused');const quote=db.prepare('SELECT amount FROM money_prices WHERE service_id=? AND asset=?').get(service,paymentAsset);if(!quote||expectedAmount!==quote.amount)throw Error('Paid price changed; fetch services and accept the current price');money=reserveMoney(db,buyer,service,asset(paymentAsset),id);}
      else {const debit=db.prepare(`UPDATE agents SET credits=credits-? WHERE id=? AND credits>=?`).run(s.price,buyer,s.price);if(!debit.changes)throw Error('Insufficient test credits');}
      db.prepare(`INSERT INTO jobs(id,buyer_id,service_id,status,input,price,fee,idempotency_key,money_asset,money_amount,money_fee) VALUES(?,?,?,'QUEUED',?,?,?,?,?,?,?)`).run(id,buyer,service,input,paymentAsset?0:s.price,paymentAsset?0:fee,key,paymentAsset,money?.amount||null,money?.fee||null);
      if(!paymentAsset)db.prepare(`INSERT INTO ledger(id,agent_id,job_id,amount,kind) VALUES(?,?,?,?,?)`).run(randomUUID(),buyer,id,-Number(s.price),'reserved');
      return db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id);
    });
  }
  function settle(id:string, status:'COMPLETED'|'FAILED'|'CANCELLED', result:string, actor?:string, claim?:string) {
    return transaction(()=>{
      const job=db.prepare(`SELECT j.*,s.provider_id,s.builtin FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.id=?`).get(id);
      if(!job) throw new Error('Job not found');
      if(actor && (status==='CANCELLED' ? job.buyer_id!==actor : job.provider_id!==actor)) throw new Error('Not authorized for this job');
      if(claim && job.claim_token!==claim) throw new Error('Worker lease lost');
      if(job.status!=='QUEUED') throw new Error('Job already settled');
      db.prepare(`UPDATE jobs SET status=?,result=?,completed_at=CURRENT_TIMESTAMP WHERE id=?`).run(status,result,id);
      if(job.money_asset){settleMoney(db,job,status);return db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id);}
      const credit = status==='COMPLETED' ? Number(job.price)-Number(job.fee) : Number(job.price);
      const recipient = status==='COMPLETED' ? job.provider_id : job.buyer_id;
      if(recipient) { db.prepare(`UPDATE agents SET credits=credits+? WHERE id=?`).run(credit,recipient); db.prepare(`INSERT INTO ledger(id,agent_id,job_id,amount,kind) VALUES(?,?,?,?,?)`).run(randomUUID(),recipient,id,credit,status==='COMPLETED'?'earned':'refund'); }
      if(status==='COMPLETED') db.prepare(`INSERT INTO ledger(id,job_id,amount,kind) VALUES(?,?,?,?)`).run(randomUUID(),id,job.provider_id ? Number(job.fee) : Number(job.price),'platform_test_revenue');
      return db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id);
    });
  }
  function tick() {
    const jobs=db.prepare(`SELECT j.*,s.builtin FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.status='QUEUED' AND s.builtin IN ('json','stats','hash') LIMIT 20`).all();
    for(const j of jobs) { try {
      const input=JSON.parse(String(j.input)); let result;
      if(j.builtin==='json') result={formatted:JSON.stringify(JSON.parse(input.text),null,2)};
      else if(j.builtin==='hash') result={sha256:hash(input.text)};
      else result={characters:Array.from(input.text).length,words:input.text.trim()?input.text.trim().split(/\s+/u).length:0,lines:input.text.split('\n').length};
      settle(String(j.id),'COMPLETED',JSON.stringify(result));
    } catch(e) { settle(String(j.id),'FAILED',JSON.stringify({error:'Input could not be processed'})); } }
  }
  function audit(action:string,target:string){db.prepare('INSERT INTO admin_audit(id,action,target) VALUES(?,?,?)').run(randomUUID(),action,target);}
  function settings(){return db.prepare('SELECT * FROM operator_settings WHERE id=1').get()!;}
  function claimAI(){return transaction(()=>{
    const cfg=settings();if(!cfg.enabled || !cfg.model) return undefined;
    const today=db.prepare("SELECT count(*) AS n FROM operator_runs WHERE date(created_at)=date('now')").get()!;
    if(Number(today.n)>=Number(cfg.daily_limit)) return undefined;
    const job=db.prepare(`SELECT j.*,s.builtin FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.status='QUEUED' AND s.builtin IN ('ai-summary','ai-rewrite') AND (j.lease_until IS NULL OR j.lease_until<?) ORDER BY j.rowid LIMIT 1`).get(Date.now());
    if(!job)return undefined;const token=randomUUID(),run=randomUUID();
    db.prepare('UPDATE jobs SET claim_token=?,lease_until=? WHERE id=?').run(token,Date.now()+300000,job.id);
    db.prepare("INSERT INTO operator_runs(id,job_id,provider,model,status,started_ms) VALUES(?,?,?,?,'RUNNING',?)").run(run,job.id,cfg.provider,cfg.model,Date.now());
    return {...job,token,run,provider:String(cfg.provider),model:String(cfg.model)};
  });}
  function finishAI(job:any,status:'COMPLETED'|'FAILED',errorCode:string|null=null){return transaction(()=>{
    db.prepare('UPDATE operator_runs SET status=?,error_code=?,finished_ms=? WHERE id=?').run(status,errorCode,Date.now(),job.run);
  });}
  function setOperator(enabled:boolean,provider:string,model:string,dailyLimit:number){transaction(()=>{
    db.prepare('UPDATE operator_settings SET enabled=?,provider=?,model=?,daily_limit=? WHERE id=1').run(enabled?1:0,provider,model,dailyLimit);
    db.prepare("UPDATE services SET active=? WHERE builtin IN ('ai-summary','ai-rewrite')").run(enabled?1:0);
    audit('operator_settings',JSON.stringify({enabled,provider,model,dailyLimit}));
  });}
  return {db,register,submit,settle,tick,transaction,audit,settings,claimAI,finishAI,setOperator};
}
