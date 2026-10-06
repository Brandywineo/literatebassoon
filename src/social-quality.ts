import type {openStore} from './store.ts';
type Store=ReturnType<typeof openStore>;
const tokens=(s:string)=>s.toLowerCase().match(/[a-z0-9]+/g)||[];
const stop=new Set('the and that this with from have your should would could when what how does for into are can will its our you during even'.split(' '));
export function similarContribution(a:string,b:string){
 const contribution=(s:string)=>s.replace(/\n\nI operate Literate Bassoon\.[^\n]*/g,'');
 const at=tokens(contribution(a)),bt=tokens(contribution(b)),grams=(t:string[])=>new Set(t.slice(0,-2).map((_,i)=>t.slice(i,i+3).join(' ')));
 const ag=grams(at),bg=grams(bt),overlap=[...ag].filter(g=>bg.has(g)).length/Math.max(1,Math.min(ag.size,bg.size));
 const aw=new Set(at.filter(w=>w.length>3&&!stop.has(w))),bw=new Set(bt.filter(w=>w.length>3&&!stop.has(w))),common=[...aw].filter(w=>bw.has(w)).length;
 return (ag.size>=12&&bg.size>=12&&overlap>=0.55)||(aw.size>=12&&bw.size>=12&&common/Math.min(aw.size,bw.size)>=0.86&&common/Math.max(aw.size,bw.size)>=0.70);
}
export function validateContributionHistory(store:Store,body:string,thread:{body:string}[]=[],id=''){
 if(/(?:^|[.!]\s*)(?:ask|question|answer|limitation|benefit):/i.test(body))throw Error('reply_template_residue');
 const history=store.db.prepare('SELECT body FROM social_replies WHERE id<>? AND attempted_at IS NOT NULL ORDER BY attempted_at DESC LIMIT 100').all(id);
 if(history.some(r=>similarContribution(body,String(r.body))))throw Error('reply_repeats_own_contribution');
 // A near-verbatim repeat of an existing answer adds no new contribution.
 if(thread.some(r=>similarContribution(body,r.body)))throw Error('reply_repeats_thread_answer');
 const questionWords=(text:string)=>tokens(text).filter(w=>w.length>3&&!stop.has(w)).map(w=>w.length>5?w.replace(/(?:ing|ed|s)$/,''):w);
 const question=body.match(/[^.!?]+\?/g)?.[0];
 if(question){const q=questionWords(question);
  if(q.length>=5&&history.some(r=>String(r.body).match(/[^.!?]+\?/g)?.some(old=>{const words=new Set(questionWords(old));return q.filter(w=>words.has(w)).length/q.length>=0.8;})))throw Error('reply_repeats_previous_question');
 }
}
