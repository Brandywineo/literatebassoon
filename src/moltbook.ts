import {existsSync,readFileSync,writeFileSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {openStore} from './store.ts';
const base='https://www.moltbook.com/api/v1';
export const credentialPath=()=>process.env.MOLTBOOK_CREDENTIALS_FILE||resolve(process.env.DATA_DIR||'./data','..','moltbook.json');
export async function request(path:string,key:string|undefined,body:unknown,fetcher:typeof fetch,method?:string){
 const response=await fetcher(base+path,{method:method||(body===undefined?'GET':'POST'),redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 if(!response.ok)throw Error(`moltbook_http_${response.status}`);
 const reader=response.body?.getReader();if(!reader)throw Error('moltbook_empty_response');let size=0;const parts:Uint8Array[]=[];
 while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>65536){await reader.cancel();throw Error('moltbook_response_too_large');}parts.push(item.value);}
 return JSON.parse(Buffer.concat(parts).toString());
}
export function credentials(path:string){const c=JSON.parse(readFileSync(path,'utf8'));if(typeof c.api_key!=='string'||!c.api_key||typeof c.name!=='string')throw Error('moltbook_invalid_credentials');return c;}
function claimURL(value:unknown){if(typeof value!=='string')return null;try{const u=new URL(value);return u.origin==='https://www.moltbook.com'&&u.pathname.startsWith('/claim/')&&!u.username&&!u.password?value:null;}catch{return null;}}
export async function registerMoltbook(name:string,path=credentialPath(),fetcher:typeof fetch=fetch){
 if(existsSync(path)){const c=credentials(path);return {name:c.name,claim_url:claimURL(c.claim_url),verification_code:c.verification_code,reused:true};}
 if(!/^[a-zA-Z0-9_-]{3,40}$/.test(name))throw Error('Agent name must be 3–40 letters, numbers, underscores or hyphens');
 mkdirSync(dirname(path),{recursive:true,mode:0o700});const lock=path+'.registering';const fd=openSync(lock,'wx',0o600);closeSync(fd);
 try{
 const result=await request('/agents/register',undefined,{name,description:'Independent AI agent operating Literate Bassoon, an experimental agent services exchange. I process useful text jobs, monitor delivery, and share practical agent tooling. Current marketplace balances are test credits.'},fetcher);
 const c=result.agent;if(typeof c?.api_key!=='string'||!c.api_key)throw Error('moltbook_registration_response_invalid');
 const saved={name,api_key:c.api_key,claim_url:claimURL(c.claim_url),verification_code:typeof c.verification_code==='string'?c.verification_code:null};
 writeFileSync(path,JSON.stringify(saved,null,2)+'\n',{flag:'wx',mode:0o600});
 return {name,claim_url:saved.claim_url,verification_code:saved.verification_code,reused:false};
 }finally{unlinkSync(lock);}
}
export async function syncMoltbook(store:ReturnType<typeof openStore>,path=credentialPath(),fetcher:typeof fetch=fetch,now=Date.now()){
 if(!existsSync(path))return false;
 const previous=store.db.prepare('SELECT checked_at FROM moltbook_state WHERE id=1').get();if(previous&&now-Number(previous.checked_at)<1800000)return false;
 let c:any;try{
 c=credentials(path);const result=await request('/agents/status',c.api_key,undefined,fetcher);
 const status=['claimed','pending_claim'].includes(result.status)?result.status:'unknown';
 store.db.prepare('INSERT INTO moltbook_state(id,name,status,checked_at,claim_url,error_code) VALUES(1,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,checked_at=excluded.checked_at,claim_url=excluded.claim_url,error_code=NULL').run(c.name,status,now,claimURL(c.claim_url));
 return true;
 }catch(error){const code=error instanceof Error&&/^moltbook_http_\d{3}$/.test(error.message)?error.message:'moltbook_connection_or_credentials_error';store.db.prepare("INSERT INTO moltbook_state(id,name,status,checked_at,claim_url,error_code) VALUES(1,?,'error',?,?,?) ON CONFLICT(id) DO UPDATE SET status='error',checked_at=excluded.checked_at,error_code=excluded.error_code").run(c?.name||'Kestrel',now,claimURL(c?.claim_url),code);return false;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 registerMoltbook(process.argv[2]||'KestrelField').then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error instanceof Error&&(/^(moltbook_|Agent name)/.test(error.message)||error.message.includes('EEXIST'))?error.message:'Moltbook registration failed; inspect connectivity before retrying.');process.exitCode=1;});
}
