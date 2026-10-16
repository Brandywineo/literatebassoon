import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import https from 'node:https';
export function publicAddress(ip:string){
 if(isIP(ip)===4){const p=ip.split('.').map(Number),a=p[0],b=p[1];return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51)||a===203&&b===0);}
 // Reject mapped, local, special and transition IPv6; permit global unicast only.
 return isIP(ip)===6&&/^[23][0-9a-f]{3}:/i.test(ip)&&!/^2001:(?:db8|0|10|20|2):/i.test(ip)&&!/^2002:/i.test(ip);
}
export function publicURL(raw:string){
 let u:URL;try{u=new URL(raw);}catch{throw Error('research_url_rejected');}if(!u.hostname.includes('.')||/\.(?:example|invalid|test)$/i.test(u.hostname))throw Error('research_placeholder_url');if(raw.length>1500||u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||u.hash||u.search.length>300||/localhost|\.local$|\.internal$|\.localhost$/i.test(u.hostname))throw Error('research_url_rejected');
 if(isIP(u.hostname.replace(/^\[|\]$/g,'')))throw Error('research_ip_url_rejected');
 if(/(?:key|token|secret|password|auth|signature|credential)=/i.test(u.search))throw Error('research_sensitive_url');return u;
}
// DNS is checked AND pinned to the validated address on every redirect. No host credentials.
export async function readPublic(raw:string,redirects=0,network:{lookup?:typeof lookup;get?:typeof https.get}={}):Promise<{url:string;type:string;body:string}>{
 const u=publicURL(raw);let addresses:Awaited<ReturnType<typeof lookup>>|any;let dnsTimer:ReturnType<typeof setTimeout>|undefined;try{addresses=await Promise.race([(network.lookup||lookup)(u.hostname,{all:true}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(Error('research_dns_timeout')),5000);})]);}catch(e){if(e instanceof Error&&e.message==='research_dns_timeout')throw e;throw Error('research_dns_failed');}finally{clearTimeout(dnsTimer);}
 if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw Error('research_private_network');
 return new Promise((resolve,reject)=>{
  const address=addresses[0];const req=(network.get||https.get)(u,{headers:{'User-Agent':'KestrelField research reader/1.0','Accept':'text/html,text/plain,application/json','Accept-Encoding':'identity'},lookup:((_host:any,options:any,callback:any)=>options.all?callback(null,[address]):callback(null,address.address,address.family)) as any},response=>{
   const status=response.statusCode||0;
   if([301,302,303,307,308].includes(status)){response.resume();if(redirects>=3||!response.headers.location)return reject(Error('research_redirect_limit'));readPublic(new URL(response.headers.location,u).href,redirects+1,network).then(resolve,reject);return;}
   const type=String(response.headers['content-type']||'').split(';')[0];if(status!==200||!['text/html','text/plain','text/markdown','application/json'].includes(type)){response.resume();return reject(Error('research_read_unavailable'));}
   let size=0;const parts:Buffer[]=[];response.on('data',part=>{size+=part.length;if(size>524288){response.destroy();reject(Error('research_page_too_large'));}else parts.push(Buffer.from(part));});response.on('end',()=>resolve({url:u.href,type,body:Buffer.concat(parts).toString('utf8')}));response.on('error',()=>reject(Error('research_read_failed')));
  });const deadline=setTimeout(()=>req.destroy(Error('research_read_timeout')),15000);req.once('close',()=>clearTimeout(deadline));req.on('error',()=>{clearTimeout(deadline);reject(Error('research_read_failed'));});
 });
}
export function sourceText(body:string,type:string){
 const decode=(s:string)=>s.replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
 const text=type==='text/html'?decode(body.replace(/<(script|style|nav|header|footer|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ')):body;
 return text.replace(/\s+/g,' ').trim().slice(0,8000);
}
export async function searchPublic(query:string,reader=readPublic){
 if(query.length<5||query.length>180)throw Error('research_query_invalid');
 // No paid search service is required. Coverage is explicitly limited, not general web search.
 const providers=[{name:'Wikipedia',url:'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch='+encodeURIComponent(query)},{name:'GitHub repositories',url:'https://api.github.com/search/repositories?per_page=3&q='+encodeURIComponent(query)}];
 const results:any[]=[],errors:string[]=[];
 for(const p of providers){try{const response=await reader(p.url),data=JSON.parse(response.body);if(p.name==='Wikipedia'){if(!Array.isArray(data.query?.search))throw Error();for(const item of data.query.search)results.push({title:String(item.title).slice(0,200),url:'https://en.wikipedia.org/wiki/'+encodeURIComponent(String(item.title).replaceAll(' ','_')),snippet:sourceText(String(item.snippet),'text/html').slice(0,400),provider:p.name});}else{if(!Array.isArray(data.items))throw Error();for(const item of data.items)results.push({title:String(item.full_name).slice(0,200),url:publicURL(String(item.html_url)).href,snippet:String(item.description||'').slice(0,400),provider:p.name});}}catch{errors.push(p.name);}}
 return {query,results,unavailable:errors,coverage:'Wikipedia and public GitHub repository search only. Snippets are leads, not verified findings.'};
}
