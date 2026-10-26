/** Crash/recovery reservations through the actual Worker, D1 and source readers. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
const root=fileURLToPath(new URL('../',import.meta.url)),access='reservation-fixture-private-code';
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,cookie:string,searches:Record<string,any>[],details:number;
let hold:'search'|'detail'|null,gate:{entered:Promise<void>;wait:Promise<void>;notify:()=>void;release:()=>void}|null,redirect:boolean,limitedReads:number,aliasReads:number;
beforeAll(()=>{bundle=buildSync({stdin:{contents:`
 import runtime from './tests/runtime';
 // A controlled competing caller consumes the final shared search reservation
 // after the advisory read. Production has no such fixture hook or endpoint.
 export default {async fetch(request,env,ctx){
  if(request.headers.get('X-Fixture-Dynamic')==='1')env={...env,BROWSER_ENABLED:'true',DYNAMIC_SOURCE_ENABLED:'true',DYNAMIC_SOURCE_HOSTS:'careers.public-example.com'};
  if(request.headers.get('X-Fixture-Search-Race')!=='1')return runtime.fetch(request,env,ctx);
  const raw=env.DB;let armed=true;
  const wrap=(statement,sql)=>new Proxy(statement,{get(target,key){
   if(key==='bind')return(...args)=>wrap(target.bind(...args),sql);
   if(key==='first'&&sql==='SELECT searches FROM discovery_daily_usage WHERE day=?')return async(...args)=>{const value=await target.first(...args);if(armed){armed=false;await raw.prepare('UPDATE discovery_daily_usage SET searches=40 WHERE day=?').bind(new Date().toISOString().slice(0,10)).run();}return value;};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const DB=new Proxy(raw,{get(target,key){if(key==='prepare')return sql=>wrap(target.prepare(sql),sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  return runtime.fetch(request,{...env,DB},ctx);
 }};`,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
async function request(path:string,method='GET',body?:unknown){return mf.dispatchFetch('https://reservation.fixture.example'+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,'X-HireFlow-Access-Code':access},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function json(path:string,method='GET',body?:unknown){const r=await request(path,method,body);expect(r.status,await r.clone().text()).toBeLessThan(300);return r.json() as Promise<Record<string,any>>;}
const tick=(id:string)=>json('/__test/queue','POST',{kind:'discovery_cycle',cycle_id:id});
const maintenance=()=>json('/__test/queue','POST',{kind:'maintenance'});
const status=(id:string)=>json(`/jobs/1/discovery-cycles/${id}`);
async function start(details=1){return json('/jobs/1/discovery-cycles','POST',{target:1,max_search_calls:5,max_detail_checks:details});}
function barrier(kind:'search'|'detail'){let notify!:()=>void,release!:()=>void;hold=kind;gate={entered:new Promise<void>(r=>{notify=r;}),wait:new Promise<void>(r=>{release=r;}),notify:()=>notify(),release:()=>release()};return gate;}
async function candidate(id:string,url='https://boards.greenhouse.io/reservationqa/jobs/123'){await db.prepare('UPDATE discovery_cycles SET query_cursor=max_searches WHERE id=?').bind(id).run();await db.prepare("INSERT INTO discovery_candidates(cycle_id,url,source_id,title,company,location,created_at) VALUES(?,?,'greenhouse','Python Engineer Intern','Reservation QA','India',?)").bind(id,url,new Date().toISOString()).run();}
beforeEach(async()=>{cookie='';searches=[];details=0;limitedReads=aliasReads=0;hold=null;gate=null;redirect=false;mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'reservation-fixture'},bindings:{ACCESS_CODE:access,BROWSER_ENABLED:'false',TAVILY_API_KEY:'fixture-only',DISCOVERY_DAILY_SEARCH_BUDGET:'40',DISCOVERY_DAILY_DETAIL_BUDGET:'800'},outboundService:async request=>{
 const url=new URL(request.url);if(url.hostname==='api.tavily.com'){searches.push(await request.json() as Record<string,any>);if(hold==='search'&&gate){hold=null;gate.notify();await gate.wait;}return Response.json({results:[]});}
 if(url.hostname==='boards-api.greenhouse.io'){details++;if(hold==='detail'&&gate){hold=null;gate.notify();await gate.wait;}return Response.json({title:'Python Engineer Intern',content:'Build Python APIs in a supervised internship with mentoring and unit tests. '.repeat(5),location:{name:'India'},absolute_url:'https://boards.greenhouse.io/reservationqa/jobs/123'});}
 if(url.hostname==='boards.greenhouse.io'&&redirect){details++;return new Response(null,{status:302,headers:{Location:'https://careers.public-example.com/jobs/python-intern'}});}
 if(url.hostname==='careers.blocked-example.com'){limitedReads++;return new Response(null,{status:429,headers:{'Retry-After':String(7*86400)}});}
 if(url.hostname==='careers.alias-example.com'){aliasReads++;return new Response(null,{status:302,headers:{Location:'https://careers.final-example.com/jobs/123'}});}
 if(url.hostname==='careers.final-example.com'){aliasReads++;return new Response(`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Python Engineer Intern',hiringOrganization:{name:'Reservation QA'},description:'Build Python APIs in a supervised internship with mentoring and unit tests. '.repeat(5),employmentType:'INTERN',jobLocation:{address:{addressCountry:'India'}}})}</script>`);}
 throw new Error('Unexpected source request '+url.hostname);
 }}));db=await mf.getD1Database('DB');await applyTestMigrations(db);const r=await request('/profile','POST',{name:'Reservation QA',email:'reservation-qa@example.com',mode:'internship',skills:['Python'],preferred_locations:['India']});expect(r.status).toBe(201);cookie=r.headers.get('set-cookie')!.split(';')[0];},30000);
afterEach(async()=>{gate?.release();await mf?.dispose();},30000);
describe('pessimistic per-cycle external attempt reservations',()=>{
 it('checkpoints a search before provider await and never repeats the unknown query after lease recovery',async()=>{
  const cycle=await start(),blocked=barrier('search'),old=tick(cycle.id);await blocked.entered;let state=await status(cycle.id);expect(state.search_calls).toBe(1);expect(state.sources[0].search_calls).toBe(1);expect(state.search_accounting).toContain('reserved_attempts');
  await db.prepare("UPDATE discovery_cycles SET lease_expires_at='2000-01-01' WHERE id=?").bind(cycle.id).run();await maintenance();await tick(cycle.id);blocked.release();await old;
  expect(searches).toHaveLength(2);expect(searches[0].include_domains).not.toEqual(searches[1].include_domains);expect((await status(cycle.id)).search_calls).toBe(2);
  for(let i=0;i<5;i++)await tick(cycle.id);state=await status(cycle.id);expect(state.state).toBe('partial');expect(state.search_calls).toBe(5);expect(searches).toHaveLength(5);expect((await db.prepare('SELECT searches FROM discovery_daily_usage').first<any>())!.searches).toBe(5);
 });
 it('reserves a detail check before the source await and cannot overspend its last slot after a crash',async()=>{
  const cycle=await start();await candidate(cycle.id);const blocked=barrier('detail'),old=tick(cycle.id);await blocked.entered;expect((await status(cycle.id)).detail_checks).toBe(1);
  await db.prepare("UPDATE discovery_cycles SET lease_expires_at='2000-01-01' WHERE id=?").bind(cycle.id).run();await maintenance();await tick(cycle.id);blocked.release();await old;const state=await status(cycle.id);expect(state.state).toBe('partial');expect(state.detail_checks).toBe(1);expect(details).toBe(1);expect(state.verified_count).toBe(0);expect((await db.prepare('SELECT count(*) AS n FROM applications').first<any>())!.n).toBe(0);
 });
 it('refunds only the per-cycle reservation when the shared search allowance proves no provider request occurred',async()=>{
  const day=new Date().toISOString().slice(0,10);await db.prepare('INSERT INTO discovery_daily_usage(day,searches) VALUES(?,40)').bind(day).run();const cycle=await start();await tick(cycle.id);const state=await status(cycle.id);expect(state).toMatchObject({state:'paused',search_calls:0});expect(state.sources[0].search_calls).toBe(0);expect((await db.prepare('SELECT query_cursor FROM discovery_cycles WHERE id=?').bind(cycle.id).first<any>())!.query_cursor).toBe(0);expect(searches).toHaveLength(0);expect((await db.prepare('SELECT searches FROM discovery_daily_usage WHERE day=?').bind(day).first<any>())!.searches).toBe(40);
 });
 it('drains saved detail candidates at the shared search limit before pausing an unfinished source round',async()=>{
  const day=new Date().toISOString().slice(0,10);await db.prepare('INSERT INTO discovery_daily_usage(day,searches) VALUES(?,40)').bind(day).run();
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:5,max_detail_checks:10});await candidate(cycle.id);await db.prepare('UPDATE discovery_cycles SET query_cursor=0 WHERE id=?').bind(cycle.id).run();
  await tick(cycle.id);let state=await status(cycle.id);expect(state).toMatchObject({state:'queued',verified_count:1,search_calls:0,detail_checks:1,pending:0});expect(searches).toHaveLength(0);expect(details).toBe(1);
  await tick(cycle.id);state=await status(cycle.id);expect(state).toMatchObject({state:'paused',verified_count:1,search_calls:0,detail_checks:1});expect(state.detail).toContain('Daily discovery allowance');expect(Date.parse(state.next_retry_at)).toBeGreaterThan(Date.now());
  expect((await db.prepare('SELECT query_cursor FROM discovery_cycles WHERE id=?').bind(cycle.id).first<any>())!.query_cursor).toBe(0);expect((await db.prepare('SELECT searches,details FROM discovery_daily_usage WHERE day=?').bind(day).first<any>())).toMatchObject({searches:40,details:1});expect((await db.prepare('SELECT count(*) AS n FROM applications').first<any>())!.n).toBe(1);
 });
 it('spends the final admitted search once, drains details and preserves the next unsearched source cursor',async()=>{
  const day=new Date().toISOString().slice(0,10);await db.prepare('INSERT INTO discovery_daily_usage(day,searches) VALUES(?,39)').bind(day).run();
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:5,max_detail_checks:10});await candidate(cycle.id);await db.prepare('UPDATE discovery_cycles SET query_cursor=0 WHERE id=?').bind(cycle.id).run();
  await tick(cycle.id);expect(searches).toHaveLength(1);expect(details).toBe(0);await tick(cycle.id);expect(details).toBe(1);await tick(cycle.id);
  const state=await status(cycle.id);expect(state).toMatchObject({state:'paused',verified_count:1,search_calls:1,detail_checks:1});expect(searches).toHaveLength(1);expect(state.sources.map((source:any)=>source.search_calls)).toEqual([1,0,0,0,0]);expect((await db.prepare('SELECT query_cursor FROM discovery_cycles WHERE id=?').bind(cycle.id).first<any>())!.query_cursor).toBe(1);expect((await db.prepare('SELECT searches,details FROM discovery_daily_usage WHERE day=?').bind(day).first<any>())).toMatchObject({searches:40,details:1});
  // Isolated next-day fixture: retain the exhausted historical counter rather
  // than refunding it, then admit today's previously unsearched next source.
  const previousDay=new Date(Date.parse(day)-86400000).toISOString().slice(0,10);await db.prepare('UPDATE discovery_daily_usage SET day=? WHERE day=?').bind(previousDay,day).run();await db.prepare("UPDATE discovery_cycles SET next_wake_at='2000-01-01' WHERE id=?").bind(cycle.id).run();await json(`/jobs/1/discovery-cycles/${cycle.id}/resume`,'POST',{});await tick(cycle.id);
  expect(searches).toHaveLength(2);expect(searches[1].include_domains).toEqual(['wellfound.com']);expect((await status(cycle.id)).sources.map((source:any)=>source.search_calls)).toEqual([1,1,0,0,0]);expect((await db.prepare('SELECT searches FROM discovery_daily_usage WHERE day=?').bind(previousDay).first<any>())!.searches).toBe(40);expect((await db.prepare('SELECT searches FROM discovery_daily_usage WHERE day=?').bind(day).first<any>())!.searches).toBe(1);
 });
 it('keeps a competing final reservation charged and drains details after losing the advisory race',async()=>{
  const day=new Date().toISOString().slice(0,10);await db.prepare('INSERT INTO discovery_daily_usage(day,searches) VALUES(?,39)').bind(day).run();
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:5,max_detail_checks:10});await candidate(cycle.id);await db.prepare('UPDATE discovery_cycles SET query_cursor=0 WHERE id=?').bind(cycle.id).run();
  const race=await mf.dispatchFetch('https://reservation.fixture.example/__test/queue',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-HireFlow-Access-Code':access,'X-Fixture-Search-Race':'1'},body:JSON.stringify({kind:'discovery_cycle',cycle_id:cycle.id})});expect(race.status).toBe(200);
  expect(await status(cycle.id)).toMatchObject({state:'queued',search_calls:0,detail_checks:0});expect(searches).toHaveLength(0);expect((await db.prepare('SELECT searches FROM discovery_daily_usage WHERE day=?').bind(day).first<any>())!.searches).toBe(40);
  await tick(cycle.id);await tick(cycle.id);expect(await status(cycle.id)).toMatchObject({state:'paused',verified_count:1,search_calls:0,detail_checks:1});expect((await db.prepare('SELECT query_cursor FROM discovery_cycles WHERE id=?').bind(cycle.id).first<any>())!.query_cursor).toBe(0);expect((await db.prepare('SELECT searches FROM discovery_daily_usage WHERE day=?').bind(day).first<any>())!.searches).toBe(40);
 });
 it('counts redirect aliases of one canonical full JD once while retaining actual read charges',async()=>{
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:5,max_detail_checks:10});await candidate(cycle.id,'https://careers.alias-example.com/jobs/one');await candidate(cycle.id,'https://careers.alias-example.com/jobs/two');
  await tick(cycle.id);await db.prepare('UPDATE source_domain_limits SET next_at=0').run();await tick(cycle.id);await tick(cycle.id);
  const state=await status(cycle.id);expect(state).toMatchObject({state:'partial',verified_count:1,imported_count:1,detail_checks:2,rejected:1,pending:0});expect(state.sources.reduce((sum:number,source:any)=>sum+source.verified,0)).toBe(1);expect(aliasReads).toBe(3);expect((await db.prepare('SELECT details FROM discovery_daily_usage').first<any>())!.details).toBe(3);
  expect((await db.prepare('SELECT count(*) AS n FROM applications').first<any>())!.n).toBe(1);expect((await db.prepare('SELECT count(*) AS n FROM jobs').first<any>())!.n).toBe(1);const rejected=await db.prepare("SELECT reason,evidence_json FROM discovery_candidates WHERE state='rejected'").first<any>();expect(rejected.reason).toBe('duplicate_canonical_listing');expect(JSON.parse(rejected.evidence_json)).toMatchObject({accepted:false,canonical_url:'https://careers.final-example.com/jobs/123',reason:'duplicate_canonical_listing'});
 });
 it('defers one seven-day-limited host while continuing an unrelated healthy source',async()=>{
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:5,max_detail_checks:10});const blocked='https://careers.blocked-example.com/jobs/1';await candidate(cycle.id,blocked);await db.prepare("UPDATE discovery_candidates SET created_at='2000-01-01' WHERE cycle_id=?").bind(cycle.id).run();await candidate(cycle.id);
  await tick(cycle.id);expect(limitedReads).toBe(1);expect(details).toBe(0);expect(await status(cycle.id)).toMatchObject({state:'queued',verified_count:0,detail_checks:1});
  const deferred=await db.prepare('SELECT state,attempts,evidence_json FROM discovery_candidates WHERE cycle_id=? AND url=?').bind(cycle.id,blocked).first<any>();expect(deferred).toMatchObject({state:'pending',attempts:1});expect(Date.parse(JSON.parse(deferred.evidence_json).deferred_until)).toBeGreaterThan(Date.now()+6*86400000);
  await tick(cycle.id);expect(details).toBe(1);expect(await status(cycle.id)).toMatchObject({state:'queued',verified_count:1,detail_checks:2});await tick(cycle.id);const waiting=await status(cycle.id);expect(Date.parse(waiting.next_retry_at)).toBeGreaterThan(Date.now()+6*86400000);expect(waiting.pending).toBe(1);expect(limitedReads).toBe(1);expect((await db.prepare('SELECT details FROM discovery_daily_usage').first<any>())!.details).toBe(2);
 });
 it('retains the failure reason and stops after three actual limited-host attempts',async()=>{
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:5,max_detail_checks:10});await candidate(cycle.id,'https://careers.blocked-example.com/jobs/1');
  for(let i=0;i<3;i++){
   // Only this isolated fixture advances the host/candidate retry clock.
   await db.prepare("UPDATE discovery_candidates SET evidence_json='{}' WHERE cycle_id=?").bind(cycle.id).run();await db.prepare('UPDATE source_domain_limits SET next_at=0,blocked_until=0').run();await tick(cycle.id);
  }
  await tick(cycle.id);expect(await status(cycle.id)).toMatchObject({state:'partial',verified_count:0,detail_checks:3,errors:1,pending:0});expect(limitedReads).toBe(3);expect((await db.prepare('SELECT state,attempts,reason FROM discovery_candidates').first<any>())).toMatchObject({state:'error',attempts:3,reason:'Source temporarily rate limited or unavailable.'});expect((await db.prepare('SELECT details FROM discovery_daily_usage').first<any>())!.details).toBe(3);
 });
 it('sleeps until the shorter detail wait instead of the exhausted search allowance, without a hot loop',async()=>{
  const day=new Date().toISOString().slice(0,10);await db.prepare('INSERT INTO discovery_daily_usage(day,searches) VALUES(?,40)').bind(day).run();
  const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:5,max_detail_checks:10});await candidate(cycle.id);await db.prepare('UPDATE discovery_cycles SET query_cursor=0 WHERE id=?').bind(cycle.id).run();await db.prepare('INSERT INTO source_domain_limits(host,next_at,blocked_until) VALUES(?,?,?)').bind('boards-api.greenhouse.io',Date.now()+60000,0).run();
  await tick(cycle.id);await tick(cycle.id);const waiting=await status(cycle.id);expect(waiting).toMatchObject({search_calls:0,detail_checks:0,pending:1});
  const resetAt=Date.parse(day)+86400000;if(resetAt-Date.now()>70000){expect(waiting.state).toBe('queued');expect(Date.parse(waiting.next_retry_at)).toBeGreaterThan(Date.now()+50000);expect(Date.parse(waiting.next_retry_at)).toBeLessThan(Date.now()+70000);}else{expect(['queued','paused']).toContain(waiting.state);expect(Date.parse(waiting.next_retry_at)).toBeLessThan(Date.now()+70000);}
  await tick(cycle.id);expect(searches).toHaveLength(0);expect(details).toBe(0);expect((await db.prepare('SELECT searches,details FROM discovery_daily_usage WHERE day=?').bind(day).first<any>())).toMatchObject({searches:40,details:0});expect((await db.prepare('SELECT attempts FROM discovery_candidates').first<any>())!.attempts).toBe(0);
 });
 it('pauses at the exact daily boundary instead of treating equivalent reset rounding as a shorter source wait',async()=>{
  const day=new Date().toISOString().slice(0,10),resetAt=Date.parse(day)+86400000;await db.prepare('INSERT INTO discovery_daily_usage(day,searches) VALUES(?,40)').bind(day).run();const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:5,max_detail_checks:10});await candidate(cycle.id);await db.prepare('UPDATE discovery_cycles SET query_cursor=0 WHERE id=?').bind(cycle.id).run();await db.prepare('UPDATE discovery_candidates SET evidence_json=? WHERE cycle_id=?').bind(JSON.stringify({deferred_until:new Date(resetAt+1).toISOString(),retry_reason:'Daily discovery allowance reached; existing results are preserved.'}),cycle.id).run();
  await tick(cycle.id);const state=await status(cycle.id);expect(state).toMatchObject({state:'paused',search_calls:0,detail_checks:0,pending:1});expect(Date.parse(state.next_retry_at)).toBeGreaterThanOrEqual(resetAt);expect(Date.parse(state.next_retry_at)).toBeLessThan(resetAt+1500);expect(searches).toHaveLength(0);expect(details).toBe(0);expect((await db.prepare('SELECT searches FROM discovery_daily_usage').first<any>())!.searches).toBe(40);
 });
 it('keeps cache-only static reads and known pre-launch browser denial free of attempt or detail debt',async()=>{
  const day=new Date().toISOString().slice(0,10),url='https://careers.public-example.com/jobs/python-intern';await db.prepare('INSERT INTO discovery_daily_usage(day,details) VALUES(?,7)').bind(day).run();await db.prepare('INSERT INTO browser_budget(day,reserved_seconds,last_launch_at) VALUES(?,540,0)').bind(day).run();await db.prepare('INSERT INTO source_read_cache(url,status,content_type,body,fetched_at,expires_at) VALUES(?,200,?,?,?,?)').bind(url,'text/html','<!doctype html><title>Python internship</title><p>Loading job. Enable JavaScript.</p>',new Date().toISOString(),new Date(Date.now()+3600000).toISOString()).run();const cycle=await json('/jobs/1/discovery-cycles','POST',{target:100,max_search_calls:5,max_detail_checks:10});await candidate(cycle.id,url);
  const response=await mf.dispatchFetch('https://reservation.fixture.example/__test/queue',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-HireFlow-Access-Code':access,'X-Fixture-Dynamic':'1'},body:JSON.stringify({kind:'discovery_cycle',cycle_id:cycle.id})});expect(response.status).toBe(200);
  expect(await status(cycle.id)).toMatchObject({state:'queued',verified_count:0,search_calls:0,detail_checks:0,pending:1});expect((await db.prepare('SELECT state,attempts,reason FROM discovery_candidates').first<any>())).toMatchObject({state:'pending',attempts:0,reason:'Daily browser allowance reached; existing discovery results are preserved.'});expect((await db.prepare('SELECT searches,details FROM discovery_daily_usage').first<any>())).toMatchObject({searches:0,details:7});expect((await db.prepare('SELECT reserved_seconds FROM browser_budget').first<any>())!.reserved_seconds).toBe(540);expect(searches).toHaveLength(0);expect(details+limitedReads+aliasReads).toBe(0);
 });
 it('refunds a proven pre-read host wait without refunding any global allowance',async()=>{
  const cycle=await start();await candidate(cycle.id);await db.prepare('INSERT INTO source_domain_limits(host,next_at,blocked_until) VALUES(?,?,?)').bind('boards-api.greenhouse.io',Date.now()+60000,0).run();await tick(cycle.id);expect((await status(cycle.id)).detail_checks).toBe(0);expect(details).toBe(0);const pending=(await db.prepare('SELECT state,attempts FROM discovery_candidates').first<any>())!;expect(pending).toMatchObject({state:'pending',attempts:0});expect((await db.prepare('SELECT details FROM discovery_daily_usage').first<any>())).toBeNull();
 });
 it('does not refund an earlier successful read when a later redirect or fallback encounters a shared host wait',async()=>{
  // Force the ATS endpoint to return no listing, then read a public redirect;
  // the fallback target is throttled before its own external request.
  const cycle=await start();await candidate(cycle.id,'https://boards.greenhouse.io/reservationqa/jobs/not-numeric');redirect=true;
  await db.prepare('INSERT INTO source_domain_limits(host,next_at,blocked_until) VALUES(?,?,?)').bind('careers.public-example.com',Date.now()+60000,0).run();await tick(cycle.id);const state=await status(cycle.id);expect(state.detail_checks).toBe(1);expect(details).toBeGreaterThan(0);expect((await db.prepare('SELECT attempts FROM discovery_candidates').first<any>())!.attempts).toBe(1);expect((await db.prepare('SELECT details FROM discovery_daily_usage').first<any>())!.details).toBeGreaterThan(0);
 });
});
