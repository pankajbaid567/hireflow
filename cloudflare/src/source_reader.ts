/** Shared bounded reads of public, unauthenticated sources. Never cache secrets. */
import {type Env} from './types';
import {first,run} from './storage';
import {validatePublicUrl} from './public_url';
export class SourceDeferred extends Error {constructor(readonly reason:string,readonly delaySeconds:number,readonly attempted=false){super(reason);}}
const maximumText=180000,maximumAshby=4*1024*1024,maximumCacheEntries=100,defaultTtl=6*3600000;
function cap(raw:unknown,fallback:number,hard:number){const n=raw==null?fallback:Number(raw);return Number.isFinite(n)?Math.max(0,Math.min(hard,Math.floor(n))):0;}
export function discoveryUsageLimit(env:Env,kind:'searches'|'details'){
 return kind==='searches'?cap(env.DISCOVERY_DAILY_SEARCH_BUDGET,25,40):cap(env.DISCOVERY_DAILY_DETAIL_BUDGET,400,800);
}
export async function reserveDiscoveryUsage(env:Env,kind:'searches'|'details'){
 const maximum=discoveryUsageLimit(env,kind),day=new Date().toISOString().slice(0,10);
 const row=await first(env,`INSERT INTO discovery_daily_usage(day,${kind}) SELECT ?,1 WHERE ?>=1 ON CONFLICT(day) DO UPDATE SET ${kind}=${kind}+1 WHERE ${kind}<? RETURNING ${kind}`,day,maximum,maximum);
 if(!row)throw new SourceDeferred('Daily discovery allowance reached; existing results are preserved.',Math.max(1,Math.ceil((Date.parse(day)+86400000-Date.now())/1000)));
}
function cacheTtl(response:Response,now:number){
 const policy=response.headers.get('Cache-Control')||'',vary=response.headers.get('Vary')||'';
 if(/\b(?:private|no-store|no-cache)\b/i.test(policy)||response.headers.has('Set-Cookie')||vary.split(',').some(name=>name.trim()&&!/^(accept|accept-encoding)$/i.test(name.trim())))return 0;
 const age=Number(response.headers.get('Age')||0),match=policy.match(/(?:^|,)\s*s-maxage\s*=\s*"?(\d+)/i)||policy.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)/i);
 let ttl=match?Math.max(0,Number(match[1])-(Number.isFinite(age)?Math.max(0,age):0))*1000:defaultTtl;
 const expires=response.headers.get('Expires');if(!match&&expires){const date=Date.parse(expires);if(Number.isFinite(date))ttl=date-now;}
 return Math.max(0,Math.min(defaultTtl,ttl));
}
async function backoff(env:Env,host:string,status:number,explicit?:number){
 const now=Date.now(),state=await first(env,'SELECT failures FROM source_domain_limits WHERE host=?',host);
 const delay=explicit??Math.min(3600,10*2**Math.min(Number(state?.failures||0),9));
 const updated=await first(env,'UPDATE source_domain_limits SET blocked_until=MAX(blocked_until,?),failures=MIN(failures+1,12),last_status=? WHERE host=? RETURNING blocked_until',now+delay*1000,status,host);
 return Math.max(1,Math.ceil(((updated?.blocked_until||now+delay*1000)-now)/1000));
}
export function safeSourceUrl(raw:string){
 const value=new URL(validatePublicUrl(raw));value.hostname=value.hostname.replace(/\.$/,'');
 if(value.port&&!['80','443'].includes(value.port))throw new Error('Public source reads use standard HTTP(S) ports only');
 for(const name of value.searchParams.keys())if(/(?:^|[_-])(?:token|password|secret|signature)(?:$|[_-])|^(?:api[_-]?key|authorization|auth|session(?:id)?|email|phone)$/i.test(name))throw new Error('Credential-like or personal source query parameters are not permitted');
 return value;
}
function supportedSourceType(type:string,scripts=false){return /^(?:text\/(?:html|plain)|application\/(?:json|[^;]+\+json|xhtml\+xml))(?:\s*;|$)/i.test(type)||scripts&&/^(?:text|application)\/(?:javascript|ecmascript|x-javascript)(?:\s*;|$)/i.test(type);}
export async function readPublicSource(env:Env,raw:string,init:RequestInit={},refresh=false,options:{allowScripts?:boolean}={}):Promise<Response>{
 const parsed=safeSourceUrl(raw),url=parsed.toString(),method=init.method||'GET';if(!['GET','HEAD'].includes(method)||init.body!=null)throw new Error('Public source reads permit body-free GET/HEAD only');
 const maximumBody=parsed.hostname==='api.ashbyhq.com'&&parsed.pathname.startsWith('/posting-api/job-board/')?maximumAshby:maximumText;
 const now=Date.now(),iso=new Date(now).toISOString();
 if(!refresh&&method==='GET'){
  const cached=await first(env,'SELECT status,content_type,body,fetched_at FROM source_read_cache WHERE url=? AND expires_at>?',url,iso);
  if(cached&&cached.status>=200&&cached.status<300&&!supportedSourceType(cached.content_type,options.allowScripts))return new Response(null,{status:415});
  if(cached)return new Response([204,205,304].includes(cached.status)?null:cached.body,{status:cached.status,headers:{'Content-Type':cached.content_type,'X-HireFlow-Source-Cache':'hit','X-HireFlow-Fetched-At':cached.fetched_at}});
 }
 const reserved=await first(env,`INSERT INTO source_domain_limits(host,next_at) VALUES(?,?) ON CONFLICT(host) DO UPDATE SET next_at=excluded.next_at WHERE next_at<=? AND blocked_until<=? RETURNING host`,parsed.hostname,now+1000,now,now);
 if(!reserved){const state=await first(env,'SELECT next_at,blocked_until FROM source_domain_limits WHERE host=?',parsed.hostname);throw new SourceDeferred('Waiting for this source’s shared read allowance.',Math.max(1,Math.ceil((Math.max(state?.next_at||0,state?.blocked_until||0)-now)/1000)));}
 await reserveDiscoveryUsage(env,'details');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  const headers=new Headers({Accept:'text/html, application/json','User-Agent':'HireFlow-ReadOnly-Source-Check/1.0'}),range=new Headers(init.headers).get('Range');if(range&&/^bytes=0-\d{1,6}$/.test(range))headers.set('Range',range);
  const response=await fetch(url,{method,redirect:'manual',signal:init.signal?AbortSignal.any([controller.signal,init.signal]):controller.signal,credentials:'omit',headers});
  const ttl=cacheTtl(response,now),type=response.headers.get('Content-Type')||'text/html';
  if(!ttl)await run(env,'DELETE FROM source_read_cache WHERE url=?',url);
  if(response.status===429||response.status>=500){
   const retry=response.headers.get('Retry-After'),seconds=retry&&/^\d+$/.test(retry)?Number(retry):retry?Math.ceil((Date.parse(retry)-Date.now())/1000):undefined;
   // Preserve a meaningful server-requested delay in durable state. Queue
   // delivery can wake earlier, but cannot issue a read before blocked_until.
   const explicit=seconds!==undefined&&Number.isFinite(seconds)?Math.max(1,Math.min(7*86400,seconds)):undefined;await response.body?.cancel();
   throw new SourceDeferred('Source temporarily rate limited or unavailable.',await backoff(env,parsed.hostname,response.status,explicit),true);
  }
  if([401,403,404,410].includes(response.status)){
   await response.body?.cancel();await run(env,'DELETE FROM source_read_cache WHERE url=?',url);
   // Cache only the public failure status, never a login/challenge response.
   if(ttl&&method==='GET')await run(env,'INSERT INTO source_read_cache(url,status,content_type,body,fetched_at,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET status=excluded.status,content_type=excluded.content_type,body=excluded.body,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at',url,response.status,type,'',iso,new Date(now+Math.min(ttl,60000)).toISOString());
   await run(env,'UPDATE source_domain_limits SET last_status=? WHERE host=?',response.status,parsed.hostname);
   return new Response(null,{status:response.status,headers:{'Content-Type':type,'X-HireFlow-Source-Cache':'miss'}});
  }
  if(!response.ok||method==='HEAD'){await response.body?.cancel();const safe=new Headers({'Content-Type':type,'X-HireFlow-Source-Cache':'miss'});for(const name of ['Location','Cache-Control','Retry-After']){const value=response.headers.get(name);if(value)safe.set(name,value);}return new Response(null,{status:response.status,headers:safe});}
  if(!supportedSourceType(type,options.allowScripts)){await response.body?.cancel();return new Response(null,{status:415});}
  const reader=response.body?.getReader();if(!reader){await run(env,'DELETE FROM source_read_cache WHERE url=?',url);return new Response(null,{status:response.status,headers:{'Content-Type':type,'X-HireFlow-Source-Cache':'miss','X-HireFlow-Fetched-At':iso}});}
  const chunks:Uint8Array[]=[];let size=0,truncated=false;
  for(;;){const next=await reader.read();if(next.done)break;const take=next.value.subarray(0,maximumBody-size);chunks.push(take);size+=take.length;if(take.length<next.value.length||size>=maximumBody){truncated=true;await reader.cancel();break;}}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  let body:string|null=null;try{body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{/* Invalid/truncated UTF-8 is returned as bounded original bytes, never cached as corrupted text. */}
  const metadata:D1PreparedStatement[]=[];
  if(!truncated&&size<=1024*1024&&body!==null&&ttl&&response.status!==206){
   metadata.push(env.DB.prepare('INSERT INTO source_read_cache(url,status,content_type,body,fetched_at,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET status=excluded.status,content_type=excluded.content_type,body=excluded.body,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at').bind(url,response.status,type,body,iso,new Date(now+ttl).toISOString()));
   metadata.push(env.DB.prepare('DELETE FROM source_read_cache WHERE url IN (SELECT url FROM source_read_cache ORDER BY fetched_at DESC,url DESC LIMIT -1 OFFSET ?)').bind(maximumCacheEntries));
  }
  metadata.push(env.DB.prepare('UPDATE source_domain_limits SET failures=CASE WHEN blocked_until<=? THEN 0 ELSE failures END,last_status=? WHERE host=?').bind(Date.now(),response.status,parsed.hostname));
  // One D1 API call, preserving statement order and the normal privacy/cache
  // policy. Free Workers permit 50 D1 calls per invocation; each batch counts one.
  await env.DB.batch(metadata);
  return new Response(bytes.buffer,{status:response.status,headers:{'Content-Type':type,'X-HireFlow-Source-Cache':'miss','X-HireFlow-Fetched-At':iso,...(truncated?{'X-HireFlow-Truncated':'true'}:{})}});
 }catch(error){if(error instanceof SourceDeferred)throw error;let delay=10;try{delay=await backoff(env,parsed.hostname,0);}catch{/* Preserve a safe retry classification when metadata persistence is unavailable. */}throw new SourceDeferred('Source read timed out or failed temporarily.',delay,true);}finally{clearTimeout(timer);}
}
export async function pruneSourceCache(env:Env){await run(env,'DELETE FROM source_read_cache WHERE expires_at<?',new Date().toISOString());await run(env,'DELETE FROM discovery_daily_usage WHERE day<?',new Date(Date.now()-7*86400000).toISOString().slice(0,10));}
