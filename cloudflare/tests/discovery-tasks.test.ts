/** Isolated D1/Queue lifecycle; all provider and detail requests stay in fixtures. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';

const root=fileURLToPath(new URL('../',import.meta.url)),access='discovery-lifecycle-private-fixture-code';
const providerKey='synthetic-tavily-secret-not-for-responses';
const listing='https://wellfound.com/jobs/987654321-python-intern';
const description='Build supervised Python APIs and LangChain course tools as a student engineering intern. Write focused tests, document the interface, and deliver a small study-note project with a mentor.';
type Gate={entered:Promise<void>;wait:Promise<void>;notify:()=>void;release:()=>void;used:boolean;kind:'provider'|'semantic'};
function gate(kind:Gate['kind']):Gate{let notify!:()=>void,release!:()=>void;return{kind,used:false,entered:new Promise<void>(resolve=>{notify=resolve;}),wait:new Promise<void>(resolve=>{release=resolve;}),notify:()=>notify(),release:()=>release()};}
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,cookie:string,providerCalls:string[][],partialFailure:boolean,active:Gate|null;
// Runtime's /__test/queue invokes the actual worker.queue handler. Only this
// isolated bundle adds failure injection and invokes the real cron handler.
const harness=`
import runtime from './tests/runtime';
import worker from './src/index';
export default {async fetch(request,env,context){
  if(new URL(request.url).pathname==='/__test/cron'){
    await worker.scheduled({cron:'*/5 * * * *',scheduledTime:Date.now(),noRetry(){}},env);
    const delivered=await runtime.fetch(new Request('https://discovery.fixture.example/__test/queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'maintenance'})}),env,context);
    return Response.json({recovered:(await delivered.json()).acknowledged});
  }
  const bound={...env};
  if(request.headers.get('X-Test-Queue-Outage')==='true')bound.APPLICATION_QUEUE={send:async()=>{throw new Error('controlled queue unavailable');}};
  if(request.headers.get('X-Test-Semantic')==='true'){
    bound.SEMANTIC_MATCHING_ENABLED='true';
    bound.AI={run:async(_model,input)=>{
      await fetch('https://embedding.fixture.example/gate',{method:'POST'});
      return{data:input.text.map(()=>[1,...Array(383).fill(0)]),shape:[input.text.length,384]};
    }};
  }
  return runtime.fetch(request,bound,context);
}};`;
beforeAll(()=>{bundle=buildSync({stdin:{contents:harness,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
async function request(path:string,method='GET',body?:unknown,options:{session?:string;outage?:boolean;semantic?:boolean}={}){
  return mf.dispatchFetch(`https://discovery.fixture.example${path}`,{method,headers:{Cookie:options.session??cookie,'Content-Type':'application/json','X-HireFlow-Access-Code':access,...(options.outage?{'X-Test-Queue-Outage':'true'}:{}),...(options.semantic?{'X-Test-Semantic':'true'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function json(path:string,method='GET',body?:unknown,options:Parameters<typeof request>[3]={}){const response=await request(path,method,body,options);expect(response.status,await response.clone().text()).toBeLessThan(300);return response.json() as Promise<Record<string,any>>;}
async function start(outage=false){const response=await request('/jobs/1/discover','POST',undefined,{outage});expect(response.status).toBe(202);return response.json() as Promise<Record<string,any>>;}
async function deliver(id:string,semantic=false){return json('/__test/queue','POST',{kind:'discover',discovery_id:id},{semantic});}
async function count(sql='SELECT count(*) AS n FROM applications WHERE user_id=1'){return (await db.prepare(sql).first<{n:number}>())!.n;}
async function existingReviewedDraft(){
  await json('/jobs/1','POST',{title:'Python Intern',company:'Existing Fixture',url:'https://existing.fixture.example/jobs/one',description:'A supervised Python internship building documented course tools.',listing_type:'internship'});
  const plan=await json('/weekly-plan/1'),item=plan.plan[0];
  const review=await json(`/applications/${item.application_id}/review`,'POST',{resume_version:item.resume_version,profile_version:1,reviewed:true,answers:{}});
  return{application_id:item.application_id,review_id:review.review_id};
}
beforeEach(async()=>{
  cookie='';providerCalls=[];partialFailure=false;active=null;
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],kvNamespaces:['FILES_KV'],queueProducers:{APPLICATION_QUEUE:'discovery-fixture'},bindings:{ACCESS_CODE:access,TAVILY_API_KEY:providerKey,BROWSER_ENABLED:'false',SEMANTIC_MATCHING_ENABLED:'false'},outboundService:async request=>{
    const url=new URL(request.url);
    if(url.hostname==='api.tavily.com'){
      const input=await request.json() as {include_domains:string[]};providerCalls.push(input.include_domains);
      if(active?.kind==='provider'&&!active.used&&input.include_domains.includes('wellfound.com')){active.used=true;active.notify();await active.wait;}
      if(partialFailure&&input.include_domains.includes('internshala.com'))return Response.json({error:`private upstream detail ${providerKey}`},{status:401});
      return Response.json({results:input.include_domains.includes('wellfound.com')?[{title:'Python Engineer Intern at Fixture Co',url:listing,content:description}]:[]});
    }
    if(url.hostname==='wellfound.com'){
      expect(request.method).toBe('GET');
      return new Response(`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Python Engineer Intern',hiringOrganization:{name:'Fixture Co'},description,employmentType:'INTERN',datePosted:new Date().toISOString()})}</script>`,{headers:{'Content-Type':'text/html'}});
    }
    if(url.hostname==='embedding.fixture.example'){
      if(active?.kind==='semantic'&&!active.used){active.used=true;active.notify();await active.wait;}
      return new Response('controlled embedding complete');
    }
    throw new Error('Unexpected outbound destination in isolated discovery fixture');
  }}));
  db=await mf.getD1Database('DB');await applyTestMigrations(db);
  const created=await request('/profile','POST',{name:'Discovery Lifecycle QA',email:'discovery-lifecycle@example.com',mode:'internship',skills:['Python'],target_roles:['AI Engineer'],weekly_quota:1});
  expect(created.status).toBe(201);cookie=created.headers.get('set-cookie')!.split(';')[0];
},30000);
afterEach(async()=>{active?.release();await mf?.dispose();},30000);

describe('private queued discovery lifecycle',()=>{
  it('returns one private durable ticket without inline search and denies anonymous/cross-owner polling',async()=>{
    const first=await start(),again=await start();expect(again.discovery_id).toBe(first.discovery_id);expect(providerCalls).toHaveLength(0);
    expect(first).toMatchObject({state:'queued',poll_url:`/jobs/1/discover/${first.discovery_id}`});
    const queued=await json(first.poll_url);expect(queued.state).toBe('queued');
    expect(JSON.stringify(queued)).not.toMatch(/profile_snapshot|discovery-lifecycle@example|synthetic-tavily-secret|profile_version/);
    expect((await request(first.poll_url,'GET',undefined,{session:''})).status).toBe(401);
    const second=await request('/profile','POST',{name:'Other Owner',email:'other-discovery@example.com',mode:'job',skills:['SQL']},{session:''});expect(second.status).toBe(201);const other=second.headers.get('set-cookie')!.split(';')[0];
    expect((await request(first.poll_url,'GET',undefined,{session:other})).status).toBe(404);
    expect((await request(`/jobs/2/discover/${first.discovery_id}`,'GET',undefined,{session:other})).status).toBe(404);
    expect(await count('SELECT count(*) AS n FROM discovery_runs WHERE user_id=1')).toBe(1);
  });
  it('claims duplicate queue deliveries once and never authorizes an application',async()=>{
    const ticket=await start();active=gate('provider');const pending=deliver(ticket.discovery_id);await active.entered;
    expect((await json(ticket.poll_url)).state).toBe('running');expect((await deliver(ticket.discovery_id)).acknowledged).toBe(true);
    active.release();expect((await pending).acknowledged).toBe(true);expect((await deliver(ticket.discovery_id)).acknowledged).toBe(true);
    const result=await json(ticket.poll_url);expect(result).toMatchObject({state:'completed',discovered:1,imported:1});expect(providerCalls).toHaveLength(5);
    expect(result.sources).toHaveLength(5);expect(result.sources.every((source:any)=>source.search_calls===1)).toBe(true);
    expect(await count()).toBe(1);expect(await count("SELECT count(*) AS n FROM applications WHERE status NOT IN ('pending','planned')")).toBe(0);
    expect(await count('SELECT count(*) AS n FROM submission_reviews')).toBe(0);expect(await count('SELECT count(*) AS n FROM outbox')).toBe(0);
  });
  it('retains source-specific provider failure counts while importing another accessible source',async()=>{
    partialFailure=true;const ticket=await start();await deliver(ticket.discovery_id);const result=await json(ticket.poll_url);
    expect(result).toMatchObject({state:'completed',imported:1,discovered:1});expect(result.sources.find((source:any)=>source.id==='internshala')).toMatchObject({status:'unavailable',search_calls:1,verified:0});expect(result.sources.find((source:any)=>source.id==='wellfound')).toMatchObject({status:'ok',search_calls:1,verified:1});expect(result.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/private upstream detail|synthetic-tavily-secret/);expect(providerCalls).toHaveLength(5);
  });
  it.each(['provider','semantic'] as const)('rejects changed profile facts while awaiting %s without attaching stale applications or approvals',async kind=>{
    const existing=await existingReviewedDraft(),ticket=await start();active=gate(kind);const pending=deliver(ticket.discovery_id,kind==='semantic');await active.entered;
    await json('/profile/1','PATCH',{skills:['Python','Docker'],mode:'job'});active.release();expect((await pending).acknowledged).toBe(true);
    const result=await json(ticket.poll_url);expect(result.state).toBe('failed');expect(result.detail).toContain('profile or mode changed');expect(await count()).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.user_id=1 AND j.url='${listing}'`)).toBe(0);
    expect((await db.prepare('SELECT revoked_at FROM submission_reviews WHERE id=?').bind(existing.review_id).first<{revoked_at:string|null}>())!.revoked_at).toBeTruthy();
    expect((await db.prepare('SELECT resume_path,confirmed_review_id FROM applications WHERE id=?').bind(existing.application_id).first())).toMatchObject({resume_path:null,confirmed_review_id:null});
    expect(await count('SELECT count(*) AS n FROM submission_reviews')).toBe(1);
  });
  it('recovers a persisted undispatched ticket after a queue outage through the actual cron',async()=>{
    const ticket=await start(true);expect(providerCalls).toHaveLength(0);expect((await db.prepare('SELECT dispatched_at FROM discovery_runs WHERE id=?').bind(ticket.discovery_id).first<{dispatched_at:string|null}>())!.dispatched_at).toBeNull();
    expect((await json('/__test/cron','POST')).recovered).toBe(true);expect((await db.prepare('SELECT dispatched_at FROM discovery_runs WHERE id=?').bind(ticket.discovery_id).first<{dispatched_at:string|null}>())!.dispatched_at).toBeTruthy();
    await deliver(ticket.discovery_id);expect((await json(ticket.poll_url)).state).toBe('completed');expect(providerCalls).toHaveLength(5);expect(await count()).toBe(1);
  });
  it.each(['poll','delivery','cron'] as const)('expires a queued ticket before delivery without spending provider calls (%s observes expiry)',async observer=>{
    const ticket=await start();await db.prepare("UPDATE discovery_runs SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(ticket.discovery_id).run();
    if(observer==='delivery')await deliver(ticket.discovery_id);if(observer==='cron')await json('/__test/cron','POST');
    const result=await json(ticket.poll_url);expect(result.state).toBe('failed');expect(result.detail).toContain('expired');await deliver(ticket.discovery_id);expect(providerCalls).toHaveLength(0);expect(await count()).toBe(0);
  });
  it.each(['poll','cron','none'] as const)('does not import results after expiry during provider work (%s observes expiry)',async observer=>{
    const ticket=await start();active=gate('provider');const pending=deliver(ticket.discovery_id);await active.entered;
    await db.prepare("UPDATE discovery_runs SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(ticket.discovery_id).run();
    if(observer==='poll')expect((await json(ticket.poll_url)).state).toBe('failed');if(observer==='cron')await json('/__test/cron','POST');
    active.release();expect((await pending).acknowledged).toBe(true);expect((await json(ticket.poll_url)).state).toBe('failed');expect(await count()).toBe(0);
    expect(await count('SELECT count(*) AS n FROM submission_reviews')).toBe(0);
  });
});
