/** Actual private API + worker.queue, D1 version races; no real provider calls. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
const root=fileURLToPath(new URL('../',import.meta.url)),code='prep-refresh-private-fixture-code';
type Gate={entered:Promise<void>;wait:Promise<void>;release:()=>void;notify:()=>void;used:boolean};
function gate():Gate{let release!:()=>void,notify!:()=>void;return{entered:new Promise<void>(resolve=>{notify=resolve;}),wait:new Promise<void>(resolve=>{release=resolve;}),release:()=>release(),notify:()=>notify(),used:false};}
let mf:Miniflare,bundle:string,db:Awaited<ReturnType<Miniflare['getD1Database']>>,cookie:string,active:Gate|null,calls:number;
const harness=`import runtime from './tests/runtime';export default{async fetch(request,env,ctx){const bound={...env};const profileRace=request.headers.get('X-Test-Profile-Race')==='true',guideReadRace=request.headers.get('X-Test-Guide-Read-Race')==='true';if(profileRace||guideReadRace)bound.DB={prepare:sql=>{const statement=env.DB.prepare(sql);return ((profileRace&&sql.includes('INSERT INTO prep_refreshes'))||(guideReadRace&&sql.startsWith('SELECT state,created_at,failure_reason FROM prep_refreshes ')))?{bind:(...args)=>({first:async()=>{await fetch('https://gate.fixture.example/'+(guideReadRace?'guide-read':'profile'));return statement.bind(...args).first();}})}:statement;},batch:statements=>env.DB.batch(statements)};if(request.headers.get('X-Test-Queue-Outage')==='true')bound.APPLICATION_QUEUE={send:async()=>{throw new Error('controlled queue outage');}};return runtime.fetch(request,bound,ctx);}};`;
beforeAll(()=>{bundle=buildSync({stdin:{contents:harness,resolveDir:root,loader:'ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
async function request(path:string,method='GET',body?:unknown,options:{anonymous?:boolean;outage?:boolean;cookie?:string;race?:boolean;guideReadRace?:boolean}={}){return mf.dispatchFetch('https://prep.fixture.example'+path,{method,headers:{Cookie:options.anonymous?'':options.cookie??cookie,'Content-Type':'application/json','X-HireFlow-Access-Code':code,...(options.outage?{'X-Test-Queue-Outage':'true'}:{}),...(options.race?{'X-Test-Profile-Race':'true'}:{}),...(options.guideReadRace?{'X-Test-Guide-Read-Race':'true'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function json(path:string,method='GET',body?:unknown,options:Parameters<typeof request>[3]={}){const res=await request(path,method,body,options);expect(res.status,await res.clone().text()).toBeLessThan(300);return res.json() as Promise<Record<string,any>>;}
async function lease(){return db.prepare('SELECT * FROM prep_refreshes WHERE application_id=1').first<Record<string,any>>();}
async function deliver(row:Record<string,any>){return json('/__test/queue','POST',{kind:'prep',application_id:1,refresh_token:row.token});}
async function guide(){return db.prepare('SELECT * FROM prep_guides WHERE application_id=1').first<Record<string,any>>();}
beforeEach(async()=>{
 cookie='';active=null;calls=0;
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'prep-refresh-fixture'},bindings:{ACCESS_CODE:code,BROWSER_ENABLED:'false',GROQ_API_KEY:'synthetic-private-groq-fixture-key',LLM_PROVIDER:'groq'},outboundService:async request=>{
  if(new URL(request.url).hostname==='gate.fixture.example'){active!.used=true;active!.notify();await active!.wait;return new Response('controlled profile race');}
  if(new URL(request.url).hostname!=='api.groq.com')throw new Error('Unexpected external destination in isolated prep refresh');calls++;if(active&&!active.used){active.used=true;active.notify();await active.wait;}
  // The provider deliberately returns insufficient questions: the actual
  // source-grounded fallback must remain useful and truthful after this failure.
  return Response.json({choices:[{message:{content:'[]'}}]});
 }}));
 db=await mf.getD1Database('DB');await applyTestMigrations(db);
 const created=await request('/profile','POST',{name:'Prep Refresh QA',email:'prep-refresh@example.com',mode:'internship',skills:['Python'],weekly_quota:1});expect(created.status).toBe(201);cookie=created.headers.get('set-cookie')!.split(';')[0];
 await json('/jobs/1','POST',{title:'Python Intern',company:'Fixture Employer',url:'https://careers.example.com/jobs/prep',description:'Python and SQL required to coordinate clinic appointments and patient booking slots.',listing_type:'internship'});
 const app=await db.prepare('SELECT a.id,j.facts_version FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id=1').first<Record<string,any>>();
 await db.prepare('INSERT INTO prep_guides(application_id,structured_data,company_intel,source_profile_version,source_job_version) VALUES(?,?,?,?,?)').bind(1,JSON.stringify({version:'legacy-v1',questions:[{question:'Saved legacy question'}]}),'{}',1,app!.facts_version).run();
},30000);
afterEach(async()=>{active?.release();await mf?.dispose();},30000);
describe('explicit queued prep refresh',()=>{
 it('retains the saved guide while one private deduplicated task runs, then updates the revision without granting approval',async()=>{
  const old=(await guide())!;expect((await request('/applications/1/prep-guide/refresh','POST',{}, {anonymous:true})).status).toBe(401);
  await json('/applications/1/prep-guide/refresh','POST',{});const row=(await lease())!;await json('/applications/1/prep-guide/refresh','POST',{});expect((await lease())!.token).toBe(row.token);expect(calls).toBe(0);
  active=gate();const work=deliver(row);await active.entered;const current=await json('/applications/1/prep-guide');expect(current.version).toBe('legacy-v1');expect(current.refresh.state).toBe('running');expect(JSON.stringify(current.refresh)).not.toContain(row.token);await deliver(row);active.release();await work;
  const fresh=await json('/applications/1/prep-guide');expect(fresh.version).toBe('prep-evidence-v3');expect(fresh.guide_revision).toBeGreaterThan(old.revision);expect(fresh.refresh.state).toBe('completed');expect(fresh.questions.length).toBeGreaterThanOrEqual(5);expect(calls).toBe(1);expect(fresh.guide_stale).toBe(false);
  expect((await db.prepare('SELECT count(*) AS n FROM submission_reviews').first<{n:number}>())!.n).toBe(0);expect((await db.prepare('SELECT count(*) AS n FROM outbox').first<{n:number}>())!.n).toBe(0);
 });
 it('does not pair completed refresh state with a guide read before queue completion',async()=>{
  const old=(await guide())!;await json('/applications/1/prep-guide/refresh','POST',{});const row=(await lease())!;
  active=gate();const pending=json('/applications/1/prep-guide','GET',undefined,{guideReadRace:true});await active.entered;
  // Complete the real queue handler while the HTTP refresh-state read is paused.
  // Entering this gate marks it used, so inference is not paused a second time.
  expect(active.used).toBe(true);expect((await lease())!.state).toBe('queued');await deliver(row);expect((await lease())!.state).toBe('completed');active.release();
  const fresh=await pending;expect(fresh.refresh.state).toBe('completed');expect(fresh.version).toBe('prep-evidence-v3');expect(fresh.guide_revision).toBe(old.revision+1);expect(fresh.guide_stale).toBe(false);expect(calls).toBe(1);
  expect((await db.prepare('SELECT count(*) AS n FROM submission_reviews').first<{n:number}>())!.n).toBe(0);expect((await db.prepare('SELECT count(*) AS n FROM outbox').first<{n:number}>())!.n).toBe(0);
 });
 it('returns409 when a profile changes before durable enqueue instead of claiming a refresh was requested',async()=>{
  active=gate();const pending=request('/applications/1/prep-guide/refresh','POST',{}, {race:true});await active.entered;await json('/profile/1','PATCH',{skills:['Python','Docker']});active.release();const response=await pending;
  expect(response.status).toBe(409);expect((await response.json() as Record<string,any>).detail).toContain('profile or listing changed');expect(await lease()).toBeNull();expect(calls).toBe(0);expect(JSON.parse((await guide())!.structured_data).version).toBe('legacy-v1');
 });
 it.each(['profile','job'] as const)('keeps the old guide when %s changes during provider work',async kind=>{
  const old=(await guide())!;await json('/applications/1/prep-guide/refresh','POST',{});active=gate();const pending=deliver((await lease())!);await active.entered;
  if(kind==='profile')await json('/profile/1','PATCH',{skills:['Python','Docker']});else await db.prepare("UPDATE jobs SET description='Docker internship building supervised container tooling.' WHERE id=1").run();
  active.release();await pending;expect((await guide())!.structured_data).toBe(old.structured_data);expect((await guide())!.revision).toBe(old.revision);expect((await lease())!.state).toBe('failed');expect((await json('/applications/1/prep-guide')).guide_stale).toBe(true);
 });
 it('uses the submitted immutable JD snapshot when the live listing changes',async()=>{
  const row=await db.prepare('SELECT j.* FROM jobs j JOIN applications a ON a.job_id=j.id WHERE a.id=1').first<Record<string,any>>();
  await db.prepare("UPDATE applications SET status='needs_action',job_snapshot=? WHERE id=1").bind(JSON.stringify(row)).run();await json('/applications/1/prep-guide/refresh','POST',{});active=gate();const pending=deliver((await lease())!);await active.entered;
  await db.prepare("UPDATE jobs SET description='A completely different Docker role.' WHERE id=1").run();active.release();await pending;
  const fresh=await json('/applications/1/prep-guide');expect(fresh.refresh.state).toBe('completed');expect(fresh.guide_source_job_version).toBe(row!.facts_version);expect(fresh.questions.some((q:any)=>q.question.includes('clinic appointments'))).toBe(true);
 });
 it('cannot overwrite a newer refresh after its old token expires during inference',async()=>{
  await json('/applications/1/prep-guide/refresh','POST',{});const old=(await lease())!;active=gate();const pending=deliver(old);await active.entered;
  await db.prepare("UPDATE prep_refreshes SET expires_at='2000-01-01T00:00:00.000Z' WHERE application_id=1").run();await json('/applications/1/prep-guide/refresh','POST',{});const newer=(await lease())!;expect(newer.token).not.toBe(old.token);
  await deliver(newer);const fresh=(await guide())!;active.release();await pending;expect((await guide())!.structured_data).toBe(fresh.structured_data);expect((await guide())!.revision).toBe(fresh.revision);expect((await lease())!.token).toBe(newer.token);expect((await lease())!.state).toBe('completed');
 });
 it('recovers an undispatched ticket, rejects cross-owner requests and enforces three explicit refreshes per ten minutes',async()=>{
  const other=await request('/profile','POST',{name:'Other QA',email:'other-prep@example.com',mode:'internship',skills:['Python']},{anonymous:true});const otherCookie=other.headers.get('set-cookie')!.split(';')[0];expect((await request('/applications/1/prep-guide/refresh','POST',{}, {cookie:otherCookie})).status).toBe(404);
  await json('/applications/1/prep-guide/refresh','POST',{}, {outage:true});expect((await lease())!.dispatched_at).toBeNull();await json('/__test/queue','POST',{kind:'maintenance'});expect((await lease())!.dispatched_at).toBeTruthy();await deliver((await lease())!);
  for(let count=0;count<2;count++){await json('/applications/1/prep-guide/refresh','POST',{});await deliver((await lease())!);}
  expect((await request('/applications/1/prep-guide/refresh','POST',{})).status).toBe(429);expect(calls).toBe(3);
 });
});
