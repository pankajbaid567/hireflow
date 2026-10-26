/** Real Chromium hydration, real local D1 budgets; only public response bodies are fixtures. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {chromium} from 'playwright-core';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
import type {Env} from '../src/types';
const remote=vi.hoisted(()=>({launch:vi.fn()}));
vi.mock('@cloudflare/playwright',()=>({launch:remote.launch}));
import {readDynamicPublicSource,reserveDynamicSourceBrowser,DynamicSourceRejected} from '../src/dynamic_source';
import {readPublicSource,SourceDeferred} from '../src/source_reader';
import {discoveryFit,startDiscoveryCycle,processDiscoveryCycle} from '../src/discovery_cycles';
import {structuredJobLocation} from '../src/structured_location';
let mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,env:Env;
let calls:{url:string;method:string;cookie:string|null;authorization:string|null}[],browsers:Awaited<ReturnType<typeof chromium.launch>>[];
const origin='https://careers.rendered.example',url=origin+'/jobs/python-intern-123';
const description='Build Python APIs and SQL validation in a supervised software engineering internship. Work with a mentor to write focused tests and document services. Explain the Campus API project, discuss input validation, and improve reliability with safe integration tests. Learn to review code and communicate implementation choices.';
const posting={'@type':'JobPosting',title:'Python Engineer Intern',hiringOrganization:{name:'Synthetic Rendered Employer'},description,jobLocation:{address:{addressCountry:'IN'}},employmentType:'INTERN',datePosted:new Date(Date.now()-2*86400000).toISOString(),validThrough:new Date(Date.now()+30*86400000).toISOString()};
const document=(script='')=>`<!doctype html><title>Public job detail</title><main id="app">Loading this individual job</main>${script}`;
const metadata=`const p=${JSON.stringify(posting)};const s=document.createElement('script');s.type='application/ld+json';s.textContent=JSON.stringify(p);document.head.append(s);`;
let response:(url:URL)=>Response;
beforeEach(async()=>{
  remote.launch.mockReset();calls=[];browsers=[];response=()=>new Response(document(`<script>${metadata}</script>`),{headers:{'Content-Type':'text/html'}});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("local D1 only");}};',compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB']}));
  db=await mf.getD1Database('DB');await applyTestMigrations(db);
  env={DB:db,BROWSER:{},BROWSER_ENABLED:'true',BROWSER_DAILY_BUDGET_SECONDS:'540',DYNAMIC_SOURCE_ENABLED:'true',DYNAMIC_SOURCE_HOSTS:'careers.rendered.example'} as unknown as Env;
  vi.spyOn(globalThis,'fetch').mockImplementation(async(raw,init)=>{
    const value=new URL(String(raw)),headers=new Headers(init?.headers);
    expect(init?.redirect).toBe('manual');expect(init?.credentials).toBe('omit');
    calls.push({url:value.toString(),method:init?.method||'GET',cookie:headers.get('cookie'),authorization:headers.get('authorization')});
    return response(value);
  });
  remote.launch.mockImplementation(async()=>{
    const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});browsers.push(browser);return browser;
  });
},30000);
afterEach(async()=>{await Promise.all(browsers.map(browser=>browser.close().catch(()=>{})));await mf?.dispose();vi.useRealTimers();vi.restoreAllMocks();},30000);
async function reserved(){return Number((await db.prepare('SELECT reserved_seconds FROM browser_budget').first<{reserved_seconds:number}>())?.reserved_seconds||0);}
async function detailCount(){return Number((await db.prepare('SELECT details FROM discovery_daily_usage').first<{details:number}>())?.details||0);}
describe('explicit dynamic public reads',()=>{
  it('does not launch for disabled, unapproved, wildcard, insecure or directory sources',async()=>{
    expect(await readDynamicPublicSource({...env,DYNAMIC_SOURCE_ENABLED:'false'},url)).toBeNull();
    for(const target of ['https://elsewhere.example/jobs/1',origin+'/',origin+'/jobs',origin+'/careers','http://careers.rendered.example/jobs/1'])expect(await readDynamicPublicSource(env,target)).toBeNull();
    expect(await readDynamicPublicSource({...env,DYNAMIC_SOURCE_HOSTS:'*.example'},url)).toBeNull();
    expect(remote.launch).not.toHaveBeenCalled();expect(calls).toEqual([]);expect(await reserved()).toBe(0);
  });
  it.each(['https://user:secret@careers.rendered.example/jobs/1','https://127.0.0.1/jobs/1',url+'?api_key=synthetic-private-key'])('rejects an unsafe target before reserving or launching: %s',async target=>{
    await expect(readDynamicPublicSource(env,target)).rejects.toMatchObject({code:'unsafe_url'});expect(remote.launch).not.toHaveBeenCalled();expect(calls).toEqual([]);expect(await reserved()).toBe(0);
  });
  it('hydrates a real DOM from script/API GETs while ignoring cookies and Authorization',async()=>{
    response=value=>value.pathname==='/assets/app.js'?new Response(`document.cookie='source_cookie=synthetic';fetch('/api/job/123',{headers:{Authorization:'Bearer synthetic-page-header'}}).then(r=>r.json()).then(p=>{const s=document.createElement('script');s.type='application/ld+json';s.textContent=JSON.stringify(p);document.head.append(s);});`,{headers:{'Content-Type':'application/javascript'}}):value.pathname==='/api/job/123'?Response.json(posting):new Response(document('<script src="/assets/app.js"></script>'),{headers:{'Content-Type':'text/html','Cache-Control':'no-store'}});
    const initial=await readPublicSource(env,url); // Actual guarded static read, including no-store sources.
    const result=await readDynamicPublicSource(env,url,{initialDocument:{url,body:await initial.text()}});expect(result?.status).toBe(200);const text=await result!.text();expect(text).toContain('Synthetic Rendered Employer');expect(text).toContain('Python Engineer Intern');expect(text).toContain(description);expect(result!.headers.get('X-HireFlow-Dynamic-Method')).toBe('hydrated_json_ld');expect(result!.headers.get('X-HireFlow-Rendered-Document-Reused')).toBe('true');expect(result!.headers.get('X-HireFlow-Browser-Close-Acknowledged')).toBe('true');expect(result!.headers.get('X-HireFlow-Rendered-Native-Reads')).toBe('2');expect(calls).toHaveLength(3);expect(calls.every(call=>call.method==='GET'&&!call.cookie&&!call.authorization)).toBe(true);expect(await detailCount()).toBe(3);expect(await reserved()).toBe(90);expect(Number(result!.headers.get('X-HireFlow-Rendered-D1Calls'))).toBeLessThanOrEqual(18);expect(browsers[0].isConnected()).toBe(false);
  },15000);
  it('reads an explicit individual hydrated detail and never promotes a generic results body',async()=>{
    response=()=>new Response(document(`<script>document.querySelector('#app').innerHTML=${JSON.stringify(`<article data-job-id="123"><h1 data-job-title>Python Engineer Intern</h1><div data-company-name>Synthetic Rendered Employer</div><div data-job-description>${description}</div></article>`)};</script>`),{headers:{'Content-Type':'text/html'}});
    const result=await readDynamicPublicSource(env,url);expect(result!.headers.get('X-HireFlow-Dynamic-Method')).toBe('hydrated_job_detail');expect(await result!.text()).toContain(description);
    await db.prepare('UPDATE browser_budget SET last_launch_at=0').run();await db.prepare('DELETE FROM source_read_cache').run();await db.prepare('UPDATE source_domain_limits SET next_at=0').run();
    response=()=>new Response(document(`<script>document.querySelector('#app').textContent=${JSON.stringify('Many Python engineering jobs. '+description)};</script>`),{headers:{'Content-Type':'text/html'}});
    await expect(readDynamicPublicSource(env,url,{timeoutMs:700})).rejects.toMatchObject({code:'no_complete_job'});
  });
  it('retains explicit hydrated microdata geography, type and source dates for the actual fit policy',async()=>{
    const article=`<article itemscope itemtype="https://schema.org/JobPosting"><h1 itemprop="title">Python Engineer Intern</h1><div itemprop="hiringOrganization" itemscope><meta itemprop="name" content="Synthetic Rendered Employer"></div><p itemprop="description">${description}</p><div itemprop="jobLocation" itemscope><div itemprop="address" itemscope><meta itemprop="addressCountry" content="IN"><meta itemprop="addressLocality" content="Bengaluru"></div></div><time itemprop="datePosted" datetime="2026-10-20"></time><meta itemprop="validThrough" content="2026-11-15"><meta itemprop="employmentType" content="INTERN"><meta itemprop="skills" content="Python, SQL"></article>`;
    response=()=>new Response(document(`<script>document.querySelector('#app').innerHTML=${JSON.stringify(article)};</script>`),{headers:{'Content-Type':'text/html'}});
    const result=await readDynamicPublicSource(env,url),html=await result!.text();expect(result!.headers.get('X-HireFlow-Dynamic-Method')).toBe('hydrated_microdata');
    const observed=JSON.parse(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]);expect(observed).toMatchObject({datePosted:'2026-10-20',validThrough:'2026-11-15',employmentType:'INTERN',skills:'Python, SQL',jobLocation:{address:{addressCountry:'IN',addressLocality:'Bengaluru'}}});
    const geography=structuredJobLocation(observed);expect(geography.location).toBe('Bengaluru, India');expect(discoveryFit({...observed,listing_type:'internship',location:geography.location},{mode:'internship',skills:['Python'],preferred_locations:['India'],experience_years:0})).toMatchObject({accepted:true,geography:'explicit_location'});
  });
  it('preserves raw explicit data-attribute location and dates without inferring a country from a city',async()=>{
    const article=`<article data-job-id="123"><h1 data-job-title>Python Engineer Intern</h1><span data-company-name>Synthetic Rendered Employer</span><p data-job-description>${description}</p><span data-job-location="India"></span><span data-job-type="INTERN"></span><time data-job-posted="2026-10-20"></time><time data-job-expires="2026-11-15"></time></article>`;
    response=()=>new Response(document(`<script>document.querySelector('#app').innerHTML=${JSON.stringify(article)};</script>`),{headers:{'Content-Type':'text/html'}});
    const result=await readDynamicPublicSource(env,url),html=await result!.text(),observed=JSON.parse(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]);expect(observed).toMatchObject({jobLocation:{name:'India'},datePosted:'2026-10-20',validThrough:'2026-11-15',employmentType:'INTERN'});expect(structuredJobLocation(observed).location).toBe('India');expect(structuredJobLocation({jobLocation:{name:'Kolkata'}}).location).toBe('Kolkata');
  });
  it('blocks form POSTs, downloads, background transports and cross-host analytics',async()=>{
    response=()=>new Response(document(`<script>navigator.sendBeacon('/beacon','synthetic');try{new WebSocket('wss://analytics.example/socket')}catch{};fetch('/submit',{method:'POST',body:'synthetic public data'}).catch(()=>{});fetch('https://analytics.example/collect').catch(()=>{});${metadata}</script><form action="/form-write" method="POST"></form><iframe src="https://analytics.example/embed"></iframe><img src="https://analytics.example/pixel">`),{headers:{'Content-Type':'text/html'}});
    const result=await readDynamicPublicSource(env,url);expect(result?.status).toBe(200);expect(calls).toHaveLength(1);expect(calls[0].method).toBe('GET');expect(browsers[0].isConnected()).toBe(false);
  });
  it.each(['http://169.254.169.254/latest','https://other.rendered.example/jobs/123'])('rejects an unsafe or cross-host redirect before its I/O: %s',async location=>{
    response=()=>new Response(null,{status:302,headers:{Location:location}});
    await expect(readDynamicPublicSource(env,url)).rejects.toMatchObject({code:'unsafe_url'});expect(calls).toHaveLength(1);expect(browsers[0].isConnected()).toBe(false);
  });
  it('follows a bounded same-origin canonical redirect and records the actual final URL',async()=>{
    response=value=>value.pathname.endsWith('123')?new Response(null,{status:308,headers:{Location:'/jobs/python-intern-456'}}):new Response(document(`<script>${metadata}</script>`),{headers:{'Content-Type':'text/html'}});
    const result=await readDynamicPublicSource(env,url);expect(result!.headers.get('X-HireFlow-Source-URL')).toBe(origin+'/jobs/python-intern-456');expect(calls).toHaveLength(2);expect(await detailCount()).toBe(2);
  });
  it('stops at a CAPTCHA or login interstitial even if it includes JobPosting metadata',async()=>{
    response=()=>new Response(document(`<p>Verify you are human</p><div class="g-recaptcha"></div><script>${metadata}</script>`),{headers:{'Content-Type':'text/html'}});
    await expect(readDynamicPublicSource(env,url)).rejects.toMatchObject({code:'restricted'});expect(calls).toHaveLength(1);expect(browsers[0].isConnected()).toBe(false);
  });
  it('rejects a truncated script without executing it or caching partial bytes',async()=>{
    response=value=>value.pathname.endsWith('.js')?new Response(' '.repeat(180001)+metadata,{headers:{'Content-Type':'text/javascript'}}):new Response(document('<script src="/oversized.js"></script>'),{headers:{'Content-Type':'text/html'}});
    await expect(readDynamicPublicSource(env,url)).rejects.toMatchObject({code:'source_bounds'});expect(calls).toHaveLength(2);expect((await db.prepare("SELECT count(*) AS n FROM source_read_cache WHERE url LIKE '%.js'").first<{n:number}>())!.n).toBe(0);expect(browsers[0].isConnected()).toBe(false);
  });
  it('bounds total source requests and never forwards a thirteenth request',async()=>{
    const extra=Array.from({length:13},(_,i)=>`r${i}.rendered.example`);env.DYNAMIC_SOURCE_HOSTS=['careers.rendered.example',...extra].join(',');
    await db.batch(extra.map(host=>db.prepare('INSERT INTO source_read_cache(url,status,content_type,body,fetched_at,expires_at) VALUES(?,200,?,?,?,?)').bind('https://'+host+'/public-job','application/json','{\"public\":true}',new Date().toISOString(),new Date(Date.now()+3600000).toISOString())));
    response=value=>value.hostname!=='careers.rendered.example'?Response.json({public:true}):new Response(document(`<script>Promise.allSettled(${JSON.stringify(extra)}.map(host=>fetch('https://'+host+'/public-job'))).then(()=>{${metadata}});</script>`),{headers:{'Content-Type':'text/html'}});
    await expect(readDynamicPublicSource(env,url)).rejects.toMatchObject({code:'source_bounds'});expect(calls.length).toBeLessThanOrEqual(12);expect(await detailCount()).toBeLessThanOrEqual(12);expect(browsers[0].isConnected()).toBe(false);
  });
  it('defers before the per-step database allowance is exceeded and keeps completed public cache entries',async()=>{
    const extra=Array.from({length:8},(_,i)=>`db${i}.rendered.example`);env.DYNAMIC_SOURCE_HOSTS=['careers.rendered.example',...extra].join(',');
    response=value=>value.hostname!=='careers.rendered.example'?Response.json({public:true}):new Response(document(`<script>Promise.allSettled(${JSON.stringify(extra)}.map(host=>fetch('https://'+host+'/public-job'))).then(()=>{${metadata}});</script>`),{headers:{'Content-Type':'text/html'}});
    await expect(readDynamicPublicSource(env,url)).rejects.toMatchObject({attempted:true,reason:expect.stringContaining('per-step database allowance')});expect(calls.length).toBeLessThan(8);expect(await detailCount()).toBeGreaterThan(0);expect((await db.prepare('SELECT COUNT(*) AS n FROM source_read_cache').first<{n:number}>())!.n).toBeGreaterThan(0);expect(browsers[0].isConnected()).toBe(false);
  });
  it('caps intercepted routes as well as native requests before a resource flood can build an unbounded queue',async()=>{
    response=()=>new Response(document(`<script>Array.from({length:100},(_,i)=>fetch('/blocked-write-'+i,{method:'POST',body:'synthetic'}).catch(()=>{}));</script>`),{headers:{'Content-Type':'text/html'}});
    await expect(readDynamicPublicSource(env,url)).rejects.toMatchObject({code:'source_bounds'});expect(calls).toHaveLength(1);expect(browsers[0].isConnected()).toBe(false);
  });
  it('preserves a source Retry-After checkpoint instead of bypassing it through the browser',async()=>{
    const day=new Date().toISOString().slice(0,10);await db.prepare('INSERT INTO source_domain_limits(host,next_at,blocked_until) VALUES(?,?,?)').bind('careers.rendered.example',0,Date.now()+3600000).run();
    await expect(readDynamicPublicSource(env,url)).rejects.toMatchObject({attempted:true});expect(calls).toHaveLength(0);expect(await reserved()).toBe(90);expect(await detailCount()).toBe(0);expect(browsers[0].isConnected()).toBe(false);
    expect((await db.prepare('SELECT reserved_seconds FROM browser_budget WHERE day=?').bind(day).first<{reserved_seconds:number}>())!.reserved_seconds).toBe(90);
  });
  it('rejects an unbound or oversized initial document before reserving a browser',async()=>{
    await expect(readDynamicPublicSource(env,url,{initialDocument:{url:origin+'/jobs/another-1',body:'<html>wrong source</html>'}})).rejects.toMatchObject({code:'unsafe_url'});
    await expect(readDynamicPublicSource(env,url,{initialDocument:{url,body:'x'.repeat(180001)}})).rejects.toMatchObject({code:'source_bounds'});expect(remote.launch).not.toHaveBeenCalled();expect(await reserved()).toBe(0);expect(calls).toHaveLength(0);
  });
  it('does not launch when the shared day budget is exhausted, and atomically shares launch spacing',async()=>{
    const day=new Date().toISOString().slice(0,10);await db.prepare('INSERT INTO browser_budget(day,reserved_seconds) VALUES(?,?)').bind(day,530).run();
    await expect(readDynamicPublicSource(env,url)).rejects.toMatchObject({attempted:false});expect(await reserved()).toBe(530);expect(remote.launch).not.toHaveBeenCalled();
    await db.prepare('UPDATE browser_budget SET reserved_seconds=0,last_launch_at=0').run();
    const attempts=await Promise.allSettled([reserveDynamicSourceBrowser(env),reserveDynamicSourceBrowser(env)]);expect(attempts.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(await reserved()).toBe(90);expect(calls).toHaveLength(0);
  });
  it('closes a browser arriving after the rendering deadline and never refunds an uncertain reservation',async()=>{
    let resolve!: (browser:any)=>void;remote.launch.mockImplementation(()=>new Promise(value=>{resolve=value;}));
    const pending=readDynamicPublicSource(env,url,{timeoutMs:50});await expect(pending).rejects.toBeInstanceOf(SourceDeferred);
    const browser={close:vi.fn().mockResolvedValue(undefined)};resolve(browser);await new Promise(resolve=>setTimeout(resolve,20));expect(browser.close).toHaveBeenCalledOnce();expect(await reserved()).toBe(90);expect(calls).toHaveLength(0);
  });
  it('finishes the normal queued cycle with hydrated script/API evidence within the Free fifty-D1-call invocation bound',async()=>{
    const profile={name:'Synthetic Cycle',email:'cycle-rendered@example.com',mode:'internship',skills:['Python','SQL'],preferred_locations:['India'],target_roles:['Engineer'],experience_years:0};
    await db.prepare('INSERT INTO users(name,email,mode,master_profile) VALUES(?,?,?,?)').bind(profile.name,profile.email,profile.mode,JSON.stringify(profile)).run();
    env={...env,PLAN_WORK_IN_QUEUE:'true',APPLICATION_QUEUE:{metrics:async()=>({backlogCount:0,backlogBytes:0}),send:async()=>({metadata:{metrics:{backlogCount:0,backlogBytes:0}}}),sendBatch:async()=>({metadata:{metrics:{backlogCount:0,backlogBytes:0}}})}};
    const cycle=await startDiscoveryCycle(env,1,{target:1,max_search_calls:5,max_detail_checks:10});
    await db.prepare('UPDATE discovery_cycles SET query_cursor=max_searches WHERE id=?').bind(cycle.id).run();
    await db.prepare("INSERT INTO discovery_candidates(cycle_id,url,source_id,title,company,location,created_at) VALUES(?,?,'internshala','Python Engineer Intern','Synthetic Rendered Employer','India',?)").bind(cycle.id,url,new Date().toISOString()).run();
    response=value=>value.pathname==='/assets/app.js'?new Response(`fetch('/api/job/123').then(r=>r.json()).then(p=>{const s=document.createElement('script');s.type='application/ld+json';s.textContent=JSON.stringify(p);document.head.append(s);});`,{headers:{'Content-Type':'application/javascript'}}):value.pathname==='/api/job/123'?Response.json(posting):new Response(document('<script src="/assets/app.js"></script>'),{headers:{'Content-Type':'text/html','Cache-Control':'no-store'}});
    let platformCalls=0;const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>();
    const track=(statement:D1PreparedStatement):D1PreparedStatement=>{const wrapped=new Proxy(statement,{get(target,key){if(key==='bind')return(...values:unknown[])=>track(target.bind(...values));const method=Reflect.get(target,key,target);if(typeof method!=='function')return method;return(...values:unknown[])=>{if(['first','all','run','raw'].includes(String(key)))platformCalls++;return Reflect.apply(method,target,values);};}});originals.set(wrapped,statement);return wrapped;};
    const counted=new Proxy(env.DB,{get(target,key){if(key==='prepare')return(sql:string)=>track(target.prepare(sql));if(key==='batch')return(statements:D1PreparedStatement[])=>{platformCalls++;return target.batch(statements.map(statement=>originals.get(statement)||statement));};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await processDiscoveryCycle({...env,DB:counted},cycle.id);
    expect(platformCalls).toBeLessThanOrEqual(50);expect(platformCalls).toBeGreaterThan(20);expect(calls).toHaveLength(3);expect(calls.every(call=>call.method==='GET')).toBe(true);
    const state=await db.prepare('SELECT verified_count,imported_count FROM discovery_cycles WHERE id=?').bind(cycle.id).first<{verified_count:number;imported_count:number}>();expect(state).toEqual({verified_count:1,imported_count:1});
    const job=await db.prepare('SELECT location,provenance FROM jobs').first<{location:string;provenance:string}>();expect(job!.location).toBe('India');expect(JSON.parse(job!.provenance)).toMatchObject({kind:'rendered_json_ld',rendered_method:'hydrated_json_ld'});expect(await reserved()).toBe(90);
  },15000);
  it('keeps the cycle attempt charged after a cached shell, browser launch, successful script read and later quota denial',async()=>{
    const profile={name:'Synthetic Accounting',email:'accounting-rendered@example.com',mode:'internship',skills:['Python'],preferred_locations:['India'],experience_years:0};
    await db.prepare('INSERT INTO users(name,email,mode,master_profile) VALUES(?,?,?,?)').bind(profile.name,profile.email,profile.mode,JSON.stringify(profile)).run();
    env={...env,DISCOVERY_DAILY_DETAIL_BUDGET:'2',PLAN_WORK_IN_QUEUE:'true',APPLICATION_QUEUE:{metrics:async()=>({backlogCount:0,backlogBytes:0}),send:async()=>({metadata:{metrics:{backlogCount:0,backlogBytes:0}}}),sendBatch:async()=>({metadata:{metrics:{backlogCount:0,backlogBytes:0}}})}};
    response=value=>value.pathname==='/assets/app.js'?new Response(`fetch('/api/job/123').then(r=>r.json()).then(p=>{const s=document.createElement('script');s.type='application/ld+json';s.textContent=JSON.stringify(p);document.head.append(s);});`,{headers:{'Content-Type':'application/javascript'}}):value.pathname==='/api/job/123'?Response.json(posting):new Response(document('<script src="/assets/app.js"></script>'),{headers:{'Content-Type':'text/html'}});
    await readPublicSource(env,url); // First real public read; the queued verifier sees this cached shell.
    const cycle=await startDiscoveryCycle(env,1,{target:1,max_search_calls:5,max_detail_checks:10});await db.prepare('UPDATE discovery_cycles SET query_cursor=max_searches WHERE id=?').bind(cycle.id).run();
    await db.prepare("INSERT INTO discovery_candidates(cycle_id,url,source_id,title,company,location,created_at) VALUES(?,?,'internshala','Python Engineer Intern','Synthetic Rendered Employer','India',?)").bind(cycle.id,url,new Date().toISOString()).run();
    await processDiscoveryCycle(env,cycle.id);
    expect((await db.prepare('SELECT detail_calls,verified_count FROM discovery_cycles WHERE id=?').bind(cycle.id).first())).toMatchObject({detail_calls:1,verified_count:0});expect((await db.prepare('SELECT attempts,state FROM discovery_candidates WHERE cycle_id=?').bind(cycle.id).first())).toMatchObject({attempts:1,state:'pending'});
    expect(calls.map(call=>new URL(call.url).pathname)).toEqual(['/jobs/python-intern-123','/assets/app.js']);expect(await detailCount()).toBe(2);expect(await reserved()).toBe(90);expect(browsers[0].isConnected()).toBe(false);
  },15000);
  it('permits cached JavaScript only to the explicit script transport, never ordinary JD reads',async()=>{
    response=()=>new Response(metadata,{headers:{'Content-Type':'application/javascript'}});
    expect((await readPublicSource(env,origin+'/app.js',{},false,{allowScripts:true})).status).toBe(200);expect(calls).toHaveLength(1);
    expect((await readPublicSource(env,origin+'/app.js')).status).toBe(415);expect(calls).toHaveLength(1);
    expect((await readPublicSource(env,origin+'/app.js',{},false,{allowScripts:true})).headers.get('X-HireFlow-Source-Cache')).toBe('hit');
  });
});
