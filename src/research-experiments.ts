import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
export const recipes=['memory_conflicts','idempotency_replay','text_fact_preservation','field_stripping'];
export function experiment(recipe:string,input:any){
 if(!recipes.includes(recipe)||JSON.stringify(input).length>10000)throw Error('experiment_invalid');
 if(recipe==='field_stripping'){
  const {record,allowed_fields,required_fields}=input;
  const fields=(v:any)=>Array.isArray(v)&&v.length<=30&&v.every(k=>typeof k==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(k));
  if(!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).length>30||!fields(Object.keys(record))||!fields(allowed_fields)||!fields(required_fields)||!required_fields.length)throw Error('experiment_invalid');
  const written=Object.fromEntries(Object.entries(record).filter(([k])=>allowed_fields.includes(k)));
  const missing=(r:any)=>required_fields.filter((k:string)=>!Object.hasOwn(r,k));
  const before=missing(record),after=missing(written),stripped=Object.keys(record).filter(k=>!Object.hasOwn(written,k));
  return {recipe,stripped_fields:stripped,missing_before:before,missing_after:after,pre_write_valid:before.length===0,stored_valid:after.length===0,pre_write_validation_missed_loss:before.length===0&&after.length>0,limitation:'Synthetic allowlist write and required-field presence checks only; no external API was called. A pre-write check can miss later data loss; this does not establish a defect in any real API or validator.'};
 }
 if(recipe==='memory_conflicts'){
  const updates=input.updates;if(!Array.isArray(updates)||updates.length<2||updates.length>100||updates.some(x=>!x||typeof x.key!=='string'||typeof x.value!=='string'||x.key.length>100||x.value.length>200))throw Error('experiment_invalid');
  const latest=new Map<string,string>(),first=new Map<string,string>();for(const x of updates){if(!first.has(x.key))first.set(x.key,x.value);latest.set(x.key,x.value);}
  return {recipe,updates:updates.length,keys:latest.size,stale_first_values:[...first].filter(([k,v])=>latest.get(k)!==v).length,latest_values:Object.fromEntries(latest),limitation:'Synthetic supplied update sequence; latest-write selection does not establish factual truth or a real retrieval-model benchmark.'};
 }
 if(recipe==='idempotency_replay'){
  const events=input.events;if(!Array.isArray(events)||events.length<2||events.length>100||events.some(x=>!x||typeof x.key!=='string'||typeof x.payload!=='string'||x.key.length>100||x.payload.length>200))throw Error('experiment_invalid');
  const seen=new Map<string,string>();let duplicates=0,conflicts=0;for(const e of events){if(seen.has(e.key)){if(seen.get(e.key)===e.payload)duplicates++;else conflicts++;}else seen.set(e.key,e.payload);}
  return {recipe,attempts:events.length,accepted_unique:seen.size,duplicate_suppressed:duplicates,changed_payload_rejected:conflicts,limitation:'In-memory sequential simulation only; does not test concurrent workers, external side effects or production delivery.'};
 }
 const cases=input.cases;if(!Array.isArray(cases)||!cases.length||cases.length>20||cases.some(c=>typeof c?.input!=='string'||typeof c?.output!=='string'||c.input.length>1000||c.output.length>1000))throw Error('experiment_invalid');
 const facts=(s:string)=>s.match(/\b\d+(?:[.,:/-]\d+)*(?:%)?\b/g)||[];
 return {recipe,cases:cases.length,results:cases.map((c:any,i:number)=>({case:i+1,missing:facts(c.input).filter(f=>!facts(c.output).includes(f)),added:facts(c.output).filter(f=>!facts(c.input).includes(f))})),limitation:'Lexical numeric comparison of supplied fixtures only; not semantic factuality, not generated model outputs and not proof of preservation.'};
}
export async function runExperiment(recipe:string,input:unknown){
 if(!recipes.includes(recipe)||JSON.stringify(input).length>10000)throw Error('experiment_invalid');
 return new Promise<any>((resolve,reject)=>{const worker=new Worker(new URL('./research-experiments.ts',import.meta.url),{workerData:{recipe,input},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:2}});const timer=setTimeout(()=>{void worker.terminate();reject(Error('experiment_timeout'));},3000);const done=()=>{clearTimeout(timer);void worker.terminate();};worker.once('message',result=>{done();if(result.error)reject(Error('experiment_invalid'));else resolve(result.value);});worker.once('error',()=>{done();reject(Error('experiment_failed'));});worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('experiment_failed'));});});
}
if(!isMainThread){try{parentPort?.postMessage({value:experiment(workerData.recipe,workerData.input)});}catch{parentPort?.postMessage({error:true});}}
