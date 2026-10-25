import {beforeAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
// Pure policy imports run in Node; the separately bundled workerd harness below
// uses the real plans implementation, D1, files and queue consumer.
vi.mock('../src/plans',()=>({getPlan:()=>{},addJobs:()=>{}}));
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
import {scheduledWindow,zonedInstant} from '../src/weekly_scheduler';
import {discoveryFit,discoveryQueryPlan} from '../src/discovery_cycles';
const root=fileURLToPath(new URL('../',import.meta.url));let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,cookie:string,searches:number,details:number,blocked=false;
let detailGate:{entered:()=>void;wait:Promise<void>;release:()=>void}|null=null;
const headers=()=>({'Content-Type':'application/json',Cookie:cookie,'X-HireFlow-Access-Code':'cycle-fixture-secret-private-123'});
async function req(path:string,method='GET',body?:unknown,session=cookie){return mf.dispatchFetch('https://cycle.fixture.example'+path,{method,headers:{...headers(),Cookie:session},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function json(path:string,method='GET',body?:unknown){const response=await req(path,method,body);expect(response.status,await response.clone().text()).toBeLessThan(300);return response.json() as Promise<Record<string,any>>;}
async function tick(task:unknown){return json('/__test/queue','POST',task);}
beforeAll(()=>{bundle=buildSync({stdin:{contents:`import runtime from './tests/runtime';import {recoverWeeklySchedules} from './src/weekly_scheduler';export default {async fetch(r,e,c){if(new URL(r.url).pathname==='/__test/schedule'){await recoverWeeklySchedules(e,new Date((await r.json()).now));return Response.json({ok:true});}return runtime.fetch(r,e,c);}}`,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
beforeEach(async()=>{cookie='';searches=details=0;blocked=false;mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'cycle-fixture'},bindings:{ACCESS_CODE:'cycle-fixture-secret-private-123',PUBLIC_BASE_URL:'https://cycle.fixture.example',ALLOWED_ORIGINS:'https://cycle.fixture.example',BROWSER_ENABLED:'false',TAVILY_API_KEY:'fixture-only',DISCOVERY_DAILY_SEARCH_BUDGET:'40',DISCOVERY_DAILY_DETAIL_BUDGET:'800'},outboundService:async request=>{
 const url=new URL(request.url);if(url.hostname==='api.tavily.com'){searches++;const input=await request.json() as any,domain=input.include_domains?.[0];if(blocked)return new Response('limited',{status:429,headers:{'Retry-After':'60'}});if(!['boards.greenhouse.io','job-boards.greenhouse.io','jobs.lever.co'].includes(domain))return Response.json({results:[]});return Response.json({results:Array.from({length:10},(_,i)=>({title:'Python Engineer Intern',url:domain==='jobs.lever.co'?`https://jobs.lever.co/cycleqa/${searches}-${i}`:`https://${domain}/cycleqa/jobs/${searches*100+i}`,content:'Snippet alone must never be imported.'}))});}
 if(url.hostname==='boards-api.greenhouse.io'){details++;if(detailGate){detailGate.entered();await detailGate.wait;}return Response.json({title:'Python Engineer Intern',content:'Build and test Python APIs in a supervised software engineering internship. Work with mentors on database integration and testing. '.repeat(4),location:{name:'Bengaluru, India'},absolute_url:`https://boards.greenhouse.io/cycleqa/jobs/${url.pathname.split('/').at(-1)}`});}
 if(url.hostname==='api.lever.co'){details++;const id=url.pathname.split('/').at(-1);return Response.json({text:'Python Engineer Intern',descriptionPlain:'Build Python APIs in a supervised software engineering internship. Pair with a mentor on testing and database integrations. '.repeat(4),categories:{location:'Bengaluru, India',commitment:'Internship'},hostedUrl:`https://jobs.lever.co/cycleqa/${id}`,applyUrl:`https://jobs.lever.co/cycleqa/${id}/apply`});}
 throw new Error('Unexpected external request '+url.hostname);
}}));db=await mf.getD1Database('DB');await applyTestMigrations(db);const created=await req('/profile','POST',{name:'Cycle QA',email:'cycle-qa@example.com',mode:'internship',skills:['Python'],preferred_locations:['India'],target_roles:['Engineer']});expect(created.status,await created.clone().text()).toBe(201);cookie=created.headers.get('set-cookie')!.split(';')[0];},30000);
afterEach(async()=>{detailGate?.release();detailGate=null;await mf?.dispose();},30000);
describe('timezone scheduling',()=>{
 it('resolves India, year/week rollover and DST folds/gaps deterministically',()=>{
  expect(scheduledWindow({timezone:'Asia/Kolkata',weekday:1,hour:9,minute:0},new Date('2026-12-31T20:00:00Z'))).toEqual({local_week:'2026-12-28',current:'2026-12-28T03:30:00.000Z',next:'2027-01-04T03:30:00.000Z'});
  expect(new Date(zonedInstant(Date.UTC(2026,10,1,1,30),'America/New_York')).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  expect(new Date(zonedInstant(Date.UTC(2026,2,8,2,30),'America/New_York')).toISOString()).toBe('2026-03-08T07:30:00.000Z');
 });
 it('is opt-in, owner private, validates timezone and refuses unconfigured email consent',async()=>{
  expect((await json('/account/schedule')).settings.enabled).toBe(false);expect((await req('/account/schedule','GET',undefined,'')).status).toBe(401);
  expect((await req('/account/schedule','PUT',{timezone:'fake/zone'})).status).toBe(422);expect((await req('/account/schedule','PUT',{email_opt_in:true})).status).toBe(409);
 });
 it('deduplicates missed and repeated ticks, catches latest week only and cancels on pause',async()=>{
  await json('/account/schedule','PUT',{enabled:true,weekday:1,timezone:'Asia/Kolkata',hour:9});await db.prepare("UPDATE weekly_schedules SET next_run_at='2020-01-01T00:00:00Z' WHERE user_id=1").run();
  await json('/__test/schedule','POST',{now:'2026-10-28T10:00:00Z'});await json('/__test/schedule','POST',{now:'2026-10-28T10:00:00Z'});
  const rows=await db.prepare('SELECT * FROM weekly_schedule_runs').all();expect(rows.results).toHaveLength(1);expect(rows.results[0].local_week).toBe('2026-10-26');
  await json('/account/schedule','PUT',{enabled:false});expect((await db.prepare('SELECT state FROM weekly_schedule_runs').first())!.state).toBe('cancelled');await tick({kind:'weekly_schedule',run_id:rows.results[0].id});expect(searches).toBe(0);
 });
 it('prepares report and one reminder across duplicate deliveries without any submission authorization',async()=>{
  await json('/account/schedule','PUT',{enabled:true,prepare_guides:false});await db.prepare("UPDATE weekly_schedules SET next_run_at='2000-01-01' WHERE user_id=1").run();await json('/__test/schedule','POST',{now:new Date().toISOString()});const row=await db.prepare('SELECT * FROM weekly_schedule_runs').first<any>();
  await db.prepare("UPDATE weekly_schedule_runs SET stage='report' WHERE id=?").bind(row.id).run();await tick({kind:'weekly_schedule',run_id:row.id});await tick({kind:'weekly_schedule',run_id:row.id});await tick({kind:'weekly_schedule',run_id:row.id});expect((await db.prepare('SELECT state FROM weekly_schedule_runs').first())!.state).toBe('completed');expect((await db.prepare('SELECT count(*) n FROM workspace_reminders').first())!.n).toBe(1);expect((await db.prepare('SELECT count(*) n FROM submission_reviews').first())!.n).toBe(0);expect((await db.prepare('SELECT count(*) n FROM outbox').first())!.n).toBe(0);
 });
 it('recovers abandoned leases and fails stale-profile work without calling providers',async()=>{
  await json('/account/schedule','PUT',{enabled:true});await db.prepare("UPDATE weekly_schedules SET next_run_at='2000-01-01' WHERE user_id=1").run();await json('/__test/schedule','POST',{now:new Date().toISOString()});const row=await db.prepare('SELECT * FROM weekly_schedule_runs').first<any>();await db.prepare("UPDATE weekly_schedule_runs SET state='running',lease_expires_at='2000-01-01' WHERE id=?").bind(row.id).run();await json('/__test/schedule','POST',{now:new Date().toISOString()});await db.prepare('UPDATE users SET profile_version=profile_version+1 WHERE id=1').run();await tick({kind:'weekly_schedule',run_id:row.id});expect((await db.prepare('SELECT state FROM weekly_schedule_runs').first())!.state).toBe('cancelled');expect(searches).toBe(0);
 });
 it.each([false,true])('pauses managed child discovery while retaining a manual cycle (manual=%s)',async manual=>{
  const existing=manual?await json('/jobs/1/discovery-cycles','POST',{target:5}):null;
  await json('/account/schedule','PUT',{enabled:true});await db.prepare("UPDATE weekly_schedules SET next_run_at='2000-01-01' WHERE user_id=1").run();await json('/__test/schedule','POST',{now:new Date().toISOString()});const row=await db.prepare('SELECT id FROM weekly_schedule_runs').first<any>();await tick({kind:'weekly_schedule',run_id:row.id});const child=await db.prepare('SELECT * FROM discovery_cycles').first<any>();expect(Boolean(child.schedule_run_id)).toBe(!manual);
  await json('/account/schedule','PUT',{enabled:false});const after=await json(`/jobs/1/discovery-cycles/${existing?.id||child.id}`);expect(after.state).toBe(manual?'queued':'cancelled');expect(searches).toBe(0);
 });
});
describe('durable larger discovery',()=>{
 it('keeps query sources distinct and excludes mode/experience/geography mismatches',()=>{
  expect(new Set(discoveryQueryPlan({mode:'internship'},25).map(q=>q.source_id)).size).toBe(6);
  const profile={mode:'internship',skills:['Python'],preferred_locations:['India'],experience_years:0};
  expect(discoveryFit({title:'Engineer',description:'Python internship',listing_type:'job',location:'India'},profile).accepted).toBe(false);
  expect(discoveryFit({title:'Engineer',description:'Python internship',listing_type:'internship',location:'USA'},profile).reason).toBe('geography_mismatch');
  expect(discoveryFit({title:'Engineer',description:'Python internship',listing_type:'internship',location:'India',required_experience:{minimum_years:5}},profile).accepted).toBe(false);
 });
 it('retains 100 distinct full JDs across bounded queue steps, deduplicates deliveries and survives a checkpoint restart',async()=>{
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:30,max_detail_checks:300});let state:any;
  for(let i=0;i<200;i++){
   // Isolated fixture clock admission only: no production usage/refund reset.
   await db.prepare("UPDATE source_domain_limits SET next_at=0,blocked_until=0").run();await db.prepare("UPDATE discovery_cycles SET next_wake_at=NULL WHERE id=?").bind(cycle.id).run();
   await tick({kind:'discovery_cycle',cycle_id:cycle.id});state=await json(`/jobs/1/discovery-cycles/${cycle.id}`);if(!['queued','running'].includes(state.state))break;
   if(i===25){await json(`/jobs/1/discovery-cycles/${cycle.id}/cancel`,'POST');const checkpoint=await json(`/jobs/1/discovery-cycles/${cycle.id}`);expect(checkpoint.state).toBe('cancelled');await json(`/jobs/1/discovery-cycles/${cycle.id}/resume`,'POST');}
  }
  expect(state.state,state.detail).toBe('completed');expect(state.verified_count).toBe(100);expect(details).toBe(100);expect(searches).toBeLessThanOrEqual(30);expect((await db.prepare('SELECT count(*) n FROM applications').first())!.n).toBe(100);await tick({kind:'discovery_cycle',cycle_id:cycle.id});expect(details).toBe(100);expect((await db.prepare('SELECT count(*) n FROM outbox').first())!.n).toBe(0);
 },120000);
 it('records partial exhaustion honestly, retains checkpoints and denies cross-owner status',async()=>{
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:5,max_detail_checks:1});for(let i=0;i<10;i++){await db.prepare("UPDATE source_domain_limits SET next_at=0").run();await tick({kind:'discovery_cycle',cycle_id:cycle.id});}
  const state=await json(`/jobs/1/discovery-cycles/${cycle.id}`);expect(state.state).toBe('partial');expect(state.verified_count).toBeLessThan(100);expect(state.message).toContain('out of 100');expect((await req(`/jobs/1/discovery-cycles/${cycle.id}`,'GET',undefined,'')).status).toBe(401);
 });
 it('stops a checkpoint after a profile edit and does not retry cancelled messages',async()=>{
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:5});await json(`/jobs/1/discovery-cycles/${cycle.id}/cancel`,'POST');await tick({kind:'discovery_cycle',cycle_id:cycle.id});expect(searches).toBe(0);await db.prepare('UPDATE users SET profile_version=profile_version+1 WHERE id=1').run();expect((await req(`/jobs/1/discovery-cycles/${cycle.id}/resume`,'POST')).status).toBe(409);
 });
 it('pauses at the shared daily allowance without losing its query checkpoint or resetting usage',async()=>{
  const day=new Date().toISOString().slice(0,10);await db.prepare('INSERT INTO discovery_daily_usage(day,searches) VALUES(?,40)').bind(day).run();const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100});await tick({kind:'discovery_cycle',cycle_id:cycle.id});const state=await json(`/jobs/1/discovery-cycles/${cycle.id}`);expect(state.state).toBe('paused');expect(state.search_calls).toBe(0);expect(Date.parse(state.next_retry_at)).toBeGreaterThan(Date.now());expect((await db.prepare('SELECT searches FROM discovery_daily_usage WHERE day=?').bind(day).first())!.searches).toBe(40);expect((await req(`/jobs/1/discovery-cycles/${cycle.id}/resume`,'POST')).status).toBe(429);expect(searches).toBe(0);
 });
 it('rejects late source publication after an in-flight cancellation',async()=>{
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100});await db.prepare('UPDATE discovery_cycles SET query_cursor=max_searches WHERE id=?').bind(cycle.id).run();await db.prepare("INSERT INTO discovery_candidates(cycle_id,url,source_id,title,company,location,created_at) VALUES(?,'https://boards.greenhouse.io/cycleqa/jobs/123','greenhouse','Python Engineer Intern','Cycle QA','India',?)").bind(cycle.id,new Date().toISOString()).run();let notify!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{notify=r;});detailGate={entered:notify,wait:new Promise<void>(r=>{release=r;}),release:()=>release()};
  const pending=tick({kind:'discovery_cycle',cycle_id:cycle.id});await entered;await json(`/jobs/1/discovery-cycles/${cycle.id}/cancel`,'POST');release();await pending;expect((await json(`/jobs/1/discovery-cycles/${cycle.id}`)).state).toBe('cancelled');expect((await db.prepare('SELECT count(*) n FROM applications').first())!.n).toBe(0);
 });
});
