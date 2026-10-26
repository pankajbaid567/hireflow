/** Bounded, unauthenticated hydration for explicitly permitted public job hosts. */
import {launch} from '@cloudflare/playwright';
import {Buffer} from 'node:buffer';
import {first,run} from './storage';
import {browserDailyBudgetSeconds,submissionDelayMs} from './telemetry';
import {readPublicSource,safeSourceUrl,SourceDeferred} from './source_reader';
import type {Env} from './types';

type Browser=Awaited<ReturnType<typeof launch>>;
// Reserve beyond the normal work/close bounds: a lost invocation may leave
// the remote browser until its default 60-second idle timeout. This is a
// pessimistic shared allowance, not a claim of exact native browser duration.
const workLimitMs=20000,reservationSeconds=90,maximumRequests=12,maximumInterceptedRequests=36,maximumTotalBytes=1024*1024,maximumSnapshot=180000,maximumD1Calls=18;
const restricted=/\b(?:verify (?:that )?you are human|checking your browser|access to this page has been denied|log ?in to view (?:this|the) job|sign in to view (?:this|the) job|complete (?:the |a )?captcha challenge|i am not a robot)\b/i;
const captchaSelector='iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i],iframe[src*="challenges.cloudflare.com" i],.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey],#captcha-challenge';
export class DynamicSourceRejected extends Error {
  constructor(readonly code:'unsafe_url'|'restricted'|'source_bounds'|'no_complete_job'|'unsupported_resource'){
    super({unsafe_url:'This rendered source requested an unsafe or unapproved destination.',restricted:'This source requires login or human verification.',source_bounds:'This rendered source exceeds the bounded read allowance.',no_complete_job:'The rendered page did not expose one complete individual job.',unsupported_resource:'The rendered source needs an unsupported resource.'}[code]);
  }
}
function configuredHosts(env:Env):Set<string>{
  const hosts=new Set<string>();
  for(const host of String(env.DYNAMIC_SOURCE_HOSTS||'').split(/[\s,]+/).slice(0,16)){
    if(!host||host!==host.toLowerCase()||/[/*:@?#]/.test(host))continue;
    try{const parsed=safeSourceUrl('https://'+host+'/');if(parsed.hostname===host)hosts.add(host);}catch{/* Malformed configuration never broadens access. */}
  }
  return hosts;
}
function boundedDatabase(database:D1Database,attempted:()=>boolean){
  const state={calls:0},original=new WeakMap<D1PreparedStatement,D1PreparedStatement>();
  const charge=()=>{if(state.calls>=maximumD1Calls)throw new SourceDeferred('Rendered source reached its per-step database allowance; cached public resources are preserved.',30,attempted());state.calls++;};
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>{
    const wrapped=new Proxy(statement,{get(target,property){
      if(property==='bind')return(...values:unknown[])=>wrap(target.bind(...values));
      const value=Reflect.get(target,property,target);
      if(typeof value!=='function')return value;
      if(['first','all','run','raw'].includes(String(property)))return(...args:unknown[])=>{charge();return Reflect.apply(value,target,args);};
      return value.bind(target);
    }});original.set(wrapped,statement);return wrapped;
  };
  const db=new Proxy(database,{get(target,property){
    if(property==='prepare')return(sql:string)=>wrap(target.prepare(sql));
    if(property==='batch')return(statements:D1PreparedStatement[])=>{charge();return target.batch(statements.map(statement=>original.get(statement)||statement));};
    if(property==='exec')return(sql:string)=>{charge();return target.exec(sql);};
    const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
  return{db,state};
}
/** Shares the application launch spacing/day allowance; never resets actual usage. */
export async function reserveDynamicSourceBrowser(env:Env):Promise<void>{
  const now=Date.now(),day=new Date(now).toISOString().slice(0,10),budget=browserDailyBudgetSeconds(env),spacing=submissionDelayMs(env);
  await run(env,'INSERT INTO browser_budget(day) VALUES(?) ON CONFLICT(day) DO NOTHING',day);
  const reserved=await first(env,`UPDATE browser_budget SET reserved_seconds=reserved_seconds+?,last_launch_at=? WHERE day=? AND reserved_seconds+?<=? AND last_launch_at<=? RETURNING reserved_seconds`,reservationSeconds,now,day,reservationSeconds,budget,now-spacing);
  if(reserved)return;
  const state=await first(env,'SELECT reserved_seconds,last_launch_at FROM browser_budget WHERE day=?',day);
  if(Number(state?.reserved_seconds||0)+reservationSeconds>budget)throw new SourceDeferred('Daily browser allowance reached; existing discovery results are preserved.',Math.max(1,Math.ceil((Date.parse(day)+86400000-now)/1000)));
  throw new SourceDeferred('Waiting for the shared browser launch allowance.',Math.max(1,Math.ceil((Number(state?.last_launch_at||0)+spacing-now)/1000)+1));
}
async function closeBrowser(browser:Browser){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([browser.close().then(()=>true,()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]);}finally{if(timer)clearTimeout(timer);}
}
/** Returns null without a browser when disabled or the host/path is unapproved.
 * The caller must first reject static login/CAPTCHA/error responses. Every browser
 * resource still uses the normal native source reader, account budget and cache.
 */
export async function readDynamicPublicSource(env:Env,raw:string,options:{timeoutMs?:number;initialDocument?:{url:string;body:string}}={}):Promise<Response|null>{
  if(env.DYNAMIC_SOURCE_ENABLED!=='true'||env.BROWSER_ENABLED!=='true')return null;
  let target:URL;
  try{target=safeSourceUrl(raw);}catch{throw new DynamicSourceRejected('unsafe_url');}
  const hosts=configuredHosts(env);
  if(target.protocol!=='https:'||!hosts.has(target.hostname)||target.pathname==='/'||/\/(?:jobs|careers|openings|positions|internships|search)\/?$/i.test(target.pathname))return null;
  let initialDocument:string|undefined;
  if(options.initialDocument){
    try{if(safeSourceUrl(options.initialDocument.url).toString()!==target.toString())throw new Error();}catch{throw new DynamicSourceRejected('unsafe_url');}
    if(typeof options.initialDocument.body!=='string'||new TextEncoder().encode(options.initialDocument.body).length>maximumSnapshot)throw new DynamicSourceRejected('source_bounds');
    initialDocument=options.initialDocument.body;
  }
  const requested=Number(options.timeoutMs??workLimitMs),timeout=Number.isFinite(requested)?Math.max(1,Math.min(workLimitMs,Math.floor(requested))):workLimitMs;
  const deadline=Date.now()+timeout;
  let launchAttempted=false;const database=boundedDatabase(env.DB,()=>launchAttempted);env={...env,DB:database.db};
  await reserveDynamicSourceBrowser(env);
  let browser:Browser|undefined,finished=false,timer:ReturnType<typeof setTimeout>|undefined,output:Response|null=null;
  let blocked:DynamicSourceRejected|SourceDeferred|undefined;
  const abort=new AbortController();
  const remaining=()=>Math.max(1,deadline-Date.now());
  const check=()=>{if(blocked)throw blocked;if(finished||Date.now()>=deadline)throw new SourceDeferred('Rendered source timed out; its checkpoint can be retried.',30,true);};
  const work=async()=>{
    launchAttempted=true;browser=await launch(env.BROWSER);
    if(finished){await closeBrowser(browser);throw new SourceDeferred('Rendered browser acquisition timed out.',30,true);}
    check();
    const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,userAgent:'HireFlow-ReadOnly-Source-Check/1.0'});
    // A fresh public context has no owner data. Disable transports which can
    // bypass ordinary request interception; neither storage nor cookies persist.
    await context.addInitScript(()=>{
      const unavailable=()=>{throw new Error('This public source reader disables background transports');};
      Object.defineProperties(globalThis,{WebSocket:{value:unavailable},EventSource:{value:unavailable},Worker:{value:unavailable},SharedWorker:{value:unavailable},RTCPeerConnection:{value:unavailable},open:{value:()=>null}});
      Object.defineProperty(navigator,'sendBeacon',{value:()=>false});
      HTMLFormElement.prototype.submit=unavailable;HTMLFormElement.prototype.requestSubmit=unavailable;
    });
    if(context.routeWebSocket)await context.routeWebSocket('**/*',socket=>socket.close());
    let requests=0,totalBytes=0,navigations=0,intercepted=0,nativeReads=0,reusedDocument=false,redirect:string|undefined;
    let page:Awaited<ReturnType<Browser['newPage']>>;
    let serial:Promise<void>=Promise.resolve();
    await context.route('**/*',route=>{
      if(++intercepted>maximumInterceptedRequests){blocked=new DynamicSourceRejected('source_bounds');return route.abort().catch(()=>{});}
      const task=serial.then(async()=>{
        const request=route.request();
        try{
          check();
          let url:URL;
          try{url=safeSourceUrl(request.url());}catch{throw new DynamicSourceRejected('unsafe_url');}
          if(url.protocol!=='https:'||!hosts.has(url.hostname)){
            if(request.isNavigationRequest())throw new DynamicSourceRejected('unsafe_url');
            await route.abort();return;
          }
          // Explicitly configured CDN hosts may serve scripts; document
          // navigation remains on the original origin and cannot open a popup.
          if(request.isNavigationRequest()&&(url.origin!==target.origin||request.frame().parentFrame()!==null||page&&request.frame().page()!==page))throw new DynamicSourceRejected('unsafe_url');
          if(!['GET','HEAD'].includes(request.method())){await route.abort();return;}
          if(!['document','script','fetch','xhr'].includes(request.resourceType())){await route.abort();return;}
          if(++requests>maximumRequests||request.isNavigationRequest()&&++navigations>3)throw new DynamicSourceRejected('source_bounds');
          if(initialDocument!==undefined&&request.isNavigationRequest()&&url.toString()===target.toString()){
            // Internal caller bytes were already fetched with the normal public
            // guards and checked for error/login/challenge states. Reusing them
            // avoids a second no-cache HTML read or fabricated cache insertion.
            const body=initialDocument;initialDocument=undefined;reusedDocument=true;totalBytes+=new TextEncoder().encode(body).length;
            await route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:{'content-security-policy':"default-src 'none'; script-src 'self' https: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https:; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'"},body});return;
          }
          let response:Response;
          for(let attempt=0;;attempt++){
            try{response=await readPublicSource(env,url.toString(),{method:request.method(),signal:abort.signal},false,{allowScripts:true});break;}
            catch(error){
              if(error instanceof SourceDeferred&&!error.attempted&&error.delaySeconds<=2&&attempt<2&&remaining()>error.delaySeconds*1000+250){await new Promise(resolve=>setTimeout(resolve,error.delaySeconds*1000));check();continue;}
              throw error;
            }
          }
          check();
          if(response.headers.get('X-HireFlow-Source-Cache')!=='hit')nativeReads++;
          if([401,403,999].includes(response.status)){await response.body?.cancel();throw new DynamicSourceRejected('restricted');}
          if(response.status>=300&&response.status<400){
            const location=response.headers.get('location');await response.body?.cancel();
            let next:URL;try{next=safeSourceUrl(new URL(location||'',url).toString());}catch{throw new DynamicSourceRejected('unsafe_url');}
            if(!location||next.origin!==target.origin||!hosts.has(next.hostname))throw new DynamicSourceRejected('unsafe_url');
            if(!request.isNavigationRequest())throw new DynamicSourceRejected('unsupported_resource');
            // Playwright does not reroute every automatic redirect hop. Return
            // an inert document and drive the next validated GET explicitly.
            redirect=next.toString();await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Reading public job</title>'});return;
          }
          if(!response.ok){await response.body?.cancel();throw new DynamicSourceRejected('unsupported_resource');}
          if(response.headers.get('X-HireFlow-Truncated')==='true'){await response.body?.cancel();throw new DynamicSourceRejected('source_bounds');}
          const bytes=new Uint8Array(await response.arrayBuffer());totalBytes+=bytes.length;
          if(totalBytes>maximumTotalBytes)throw new DynamicSourceRejected('source_bounds');
          const type=response.headers.get('content-type')||'text/html';
          if(!/^(?:text\/(?:html|plain|javascript|ecmascript)|application\/(?:json|ld\+json|javascript|ecmascript|x-javascript))(?:\s*;|$)/i.test(type))throw new DynamicSourceRejected('unsupported_resource');
          const headers:Record<string,string>={'content-type':type};
          if(request.resourceType()==='document')headers['content-security-policy']="default-src 'none'; script-src 'self' https: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https:; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'";
          // Do not fulfill Set-Cookie or forward any browser request headers.
          await route.fulfill({status:response.status,headers,body:Buffer.from(bytes)});
        }catch(error){
          blocked=error instanceof DynamicSourceRejected||error instanceof SourceDeferred?error:new SourceDeferred('Rendered source read failed temporarily.',30,true);
          await route.abort().catch(()=>{});
        }
      });
      serial=task.catch(()=>{});return task;
    });
    page=await context.newPage();
    context.on('page',popup=>{if(popup!==page){blocked=new DynamicSourceRejected('unsafe_url');void popup.close().catch(()=>{});}});
    page.setDefaultTimeout(Math.min(3000,remaining()));
    const navigate=async(initial:string)=>{
      let next=initial;for(let hop=0;hop<3;hop++){check();redirect=undefined;await page.goto(next,{waitUntil:'domcontentloaded',timeout:remaining()});check();if(!redirect)return;next=redirect;}
      throw new DynamicSourceRejected('source_bounds');
    };
    await navigate(target.toString());
    // Poll only explicit job metadata/detail attributes. Body text or search
    // result snippets cannot be promoted into a complete hydrated description.
    for(;;){
      check();
      if(redirect){await navigate(redirect);continue;}
      const snapshot=await page.evaluate(({limit,selector,restriction})=>{
        const text=(document.body?.innerText||'').slice(0,12000);
        if(document.querySelector(selector)||new RegExp(restriction,'i').test(text))return {restricted:true};
        const pick=(candidate:Record<string,unknown>)=>{
          const description=typeof candidate.description==='string'?candidate.description:'';
          const organization=candidate.hiringOrganization as Record<string,unknown>|undefined;
          if(typeof candidate.title!=='string'||!candidate.title.trim()||typeof organization?.name!=='string'||!organization.name.trim()||description.replace(/<[^>]*>/g,' ').trim().length<250)return null;
          const selected:Record<string,unknown>={'@context':'https://schema.org','@type':'JobPosting'};
          for(const key of ['title','description','hiringOrganization','jobLocation','jobLocationType','applicantLocationRequirements','datePosted','validThrough','employmentType','baseSalary','skills','url'])if(Object.hasOwn(candidate,key))selected[key]=candidate[key];
          const encoded=JSON.stringify(selected);return encoded.length<=limit?encoded:null;
        };
        const found:string[]=[];
        for(const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0,10)){
          const value=script.textContent||'';if(value.length>limit)continue;
          try{
            const root=JSON.parse(value),queue:unknown[]=Array.isArray(root)?[...root]:[root];
            for(let scanned=0;queue.length&&scanned<40;scanned++){
              const item=queue.shift();if(!item||typeof item!=='object'||Array.isArray(item))continue;
              const node=item as Record<string,unknown>,types=Array.isArray(node['@type'])?node['@type']:[node['@type']];
              if(types.includes('JobPosting')){const selected=pick(node);if(selected)found.push(selected);}
              for(const next of [node['@graph'],node.mainEntity])if(next)queue.push(...(Array.isArray(next)?next:[next]));
            }
          }catch{/* Ignore unrelated malformed metadata. */}
        }
        const distinct=[...new Set(found)];
        if(distinct.length===1)return{json:distinct[0],method:'hydrated_json_ld'};
        if(distinct.length>1)return{multiple:true};
        const jobs=Array.from(document.querySelectorAll('[itemscope][itemtype$="/JobPosting"],article[data-job-id]'));
        if(jobs.length!==1)return{};
        const job=jobs[0];
        const value=(element:Element|null,attribute?:string)=>element?.getAttribute('content')?.trim()||element?.getAttribute('datetime')?.trim()||(element as HTMLElement|null)?.innerText?.trim()||(attribute?element?.getAttribute(attribute)?.trim():'')||'';
        const read=(selectors:string,attribute?:string)=>value(job.querySelector(selectors),attribute);
        const organization=job.querySelector('[itemprop="hiringOrganization"]');
        const title=read('[itemprop="title"],[data-job-title]','data-job-title'),company=value(organization?.querySelector('[itemprop="name"]')||organization)||read('[data-company-name]','data-company-name'),description=read('[itemprop="description"],[data-job-description]','data-job-description');
        const observed:Record<string,unknown>={title,hiringOrganization:{name:company},description,url:location.href};
        const place=job.querySelector('[itemprop="jobLocation"]'),address=place?.querySelector('[itemprop="address"]')||place;
        const fields:Record<string,string>={};for(const property of ['addressLocality','addressRegion','addressCountry']){const field=value(address?.querySelector('[itemprop="'+property+'"]')||null);if(field)fields[property]=field;}
        const rawLocation=value(place)||read('[data-job-location]','data-job-location');
        if(Object.keys(fields).length)observed.jobLocation={'@type':'Place',address:{'@type':'PostalAddress',...fields}};
        else if(rawLocation)observed.jobLocation={'@type':'Place',name:rawLocation};
        for(const [property,attribute] of [['datePosted','data-job-posted'],['validThrough','data-job-expires'],['employmentType','data-job-type'],['skills','data-job-skills'],['jobLocationType','data-job-location-type']]){
          const field=read('[itemprop="'+property+'"],['+attribute+']',attribute);if(field)observed[property]=field;
        }
        const json=pick(observed);
        return json?{json,method:job.matches('[itemscope]')?'hydrated_microdata':'hydrated_job_detail'}:{};
      },{limit:maximumSnapshot,selector:captchaSelector,restriction:restricted.source});
      check();
      if(snapshot.restricted)throw new DynamicSourceRejected('restricted');
      if(snapshot.multiple)throw new DynamicSourceRejected('no_complete_job');
      if(snapshot.json){
        const final=safeSourceUrl(page.url());if(final.origin!==target.origin||!hosts.has(final.hostname))throw new DynamicSourceRejected('unsafe_url');
        const html='<!doctype html><script type="application/ld+json">'+snapshot.json.replace(/</g,'\\u003c')+'</script>';
        if(new TextEncoder().encode(html).length>maximumSnapshot)throw new DynamicSourceRejected('source_bounds');
        return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','X-HireFlow-Source-Rendered':'true','X-HireFlow-Dynamic-Method':snapshot.method!,'X-HireFlow-Source-URL':final.toString(),'X-HireFlow-Fetched-At':new Date().toISOString(),'X-HireFlow-Rendered-Requests':String(requests),'X-HireFlow-Rendered-Native-Reads':String(nativeReads),'X-HireFlow-Rendered-Document-Reused':String(reusedDocument),'X-HireFlow-Rendered-Bytes':String(totalBytes),'X-HireFlow-Rendered-D1Calls':String(database.state.calls)}});
      }
      if(remaining()<300)throw new DynamicSourceRejected('no_complete_job');
      await new Promise(resolve=>setTimeout(resolve,Math.min(200,remaining())));
    }
  };
  try{
    output=await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{finished=true;abort.abort();reject(new SourceDeferred('Rendered source timed out; its checkpoint can be retried.',30,true));},Math.max(1,deadline-Date.now()));})]);return output;
  }catch(error){const failure=blocked||error;if(failure instanceof SourceDeferred&&launchAttempted&&!failure.attempted)throw new SourceDeferred(failure.reason,failure.delaySeconds,true);if(failure instanceof DynamicSourceRejected||failure instanceof SourceDeferred)throw failure;throw new SourceDeferred('Rendered browser or source is temporarily unavailable.',30,true);}
  finally{finished=true;abort.abort();if(timer)clearTimeout(timer);if(browser){const closed=await closeBrowser(browser);output?.headers.set('X-HireFlow-Browser-Close-Acknowledged',closed?'true':'unknown');}}
}
