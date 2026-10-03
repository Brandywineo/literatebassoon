import { openStore } from './store.ts';
import { generate } from './models.ts';
import { pathToFileURL } from 'node:url';

export async function runOne(store:ReturnType<typeof openStore>,generateText=generate){
  const job=store.claimAI();if(!job)return false;
  try {
    const result=await generateText({provider:job.provider,model:job.model,ollamaUrl:process.env.OLLAMA_URL,openaiKey:process.env.OPENAI_API_KEY},String(job.builtin),JSON.parse(String(job.input)).text);
    store.settle(String(job.id),'COMPLETED',JSON.stringify(result),undefined,String(job.token));
    store.finishAI(job,'COMPLETED');
  }catch{
    const row=store.db.prepare('SELECT status,claim_token FROM jobs WHERE id=?').get(job.id);
    if(row?.status==='QUEUED'&&row.claim_token===job.token)store.settle(String(job.id),'FAILED',JSON.stringify({error:'Kestrel could not complete this job. Test credits refunded.'}),undefined,String(job.token));
    store.finishAI(job,'FAILED');
  }
  return true;
}
async function main(){
  const store=openStore(process.env.DATA_DIR||'./data');let stopped=false;
  const heartbeat=(status:string)=>store.db.prepare('UPDATE operator_state SET heartbeat=?,status=? WHERE id=1').run(Date.now(),status);
  const timer=setInterval(()=>heartbeat(store.settings().enabled?'online':'paused'),10000);timer.unref();
  process.on('SIGTERM',()=>{stopped=true;});process.on('SIGINT',()=>{stopped=true;});
  console.log('Kestrel worker started; model processing follows admin settings');
  try {while(!stopped){heartbeat(store.settings().enabled?'online':'paused');await runOne(store);if(!stopped)await new Promise(resolve=>setTimeout(resolve,2000));}}
  finally{clearInterval(timer);heartbeat('offline');store.db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Worker stopped unexpectedly; inspect database access and configuration');process.exit(1);});
