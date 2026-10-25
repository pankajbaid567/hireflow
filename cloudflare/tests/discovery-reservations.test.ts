/** Crash/recovery reservations through the actual Worker, D1 and source readers. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
const root=fileURLToPath(new URL('../',import.meta.url)),access='reservation-fixture-private-code';
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,cookie:string,searches:Record<string,any>[],details:number;
let hold:'search'|'detail'|null,gate:{entered:Promise<void>;wait:Promise<void>;notify:()=>void;release:()=>void}|null,redirect:boolean;
beforeAll(()=>{bundle=buildSync({entryPoints:[root+'tests/runtime.ts'],bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
async function request(path:string,method='GET',body?:unknown){return mf.dispatchFetch('https://reservation.fixture.example'+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,'X-HireFlow-Access-Code':access},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function json(path:string,method='GET',body?:unknown){const r=await request(path,method,body);expect(r.status,await r.clone().text()).toBeLessThan(300);return r.json() as Promise<Record<string,any>>;}
const tick=(id:string)=>json('/__test/queue','POST',{kind:'discovery_cycle',cycle_id:id});
const maintenance=()=>json('/__test/queue','POST',{kind:'maintenance'});
const status=(id:string)=>json(`/jobs/1/discovery-cycles/${id}`);
async function start(details=1){return json('/jobs/1/discovery-cycles','POST',{target:1,max_search_calls:5,max_detail_checks:details});}
function barrier(kind:'search'|'detail'){let notify!:()=>void,release!:()=>void;hold=kind;gate={entered:new Promise<void>(r=>{notify=r;}),wait:new Promise<void>(r=>{release=r;}),notify:()=>notify(),release:()=>release()};return gate;}
async function candidate(id:string,url='https://boards.greenhouse.io/reservationqa/jobs/123'){await db.prepare('UPDATE discovery_cycles SET query_cursor=max_searches WHERE id=?').bind(id).run();await db.prepare("INSERT INTO discovery_candidates(cycle_id,url,source_id,title,company,location,created_at) VALUES(?,?,'greenhouse','Python Engineer Intern','Reservation QA','India',?)").bind(id,url,new Date().toISOString()).run();}
beforeEach(async()=>{cookie='';searches=[];details=0;hold=null;gate=null;redirect=false;mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'reservation-fixture'},bindings:{ACCESS_CODE:access,BROWSER_ENABLED:'false',TAVILY_API_KEY:'fixture-only',DISCOVERY_DAILY_SEARCH_BUDGET:'40',DISCOVERY_DAILY_DETAIL_BUDGET:'800'},outboundService:async request=>{
 const url=new URL(request.url);if(url.hostname==='api.tavily.com'){searches.push(await request.json() as Record<string,any>);if(hold==='search'&&gate){hold=null;gate.notify();await gate.wait;}return Response.json({results:[]});}
 if(url.hostname==='boards-api.greenhouse.io'){details++;if(hold==='detail'&&gate){hold=null;gate.notify();await gate.wait;}return Response.json({title:'Python Engineer Intern',content:'Build Python APIs in a supervised internship with mentoring and unit tests. '.repeat(5),location:{name:'India'},absolute_url:'https://boards.greenhouse.io/reservationqa/jobs/123'});}
 if(url.hostname==='boards.greenhouse.io'&&redirect){details++;return new Response(null,{status:302,headers:{Location:'https://careers.public-example.com/jobs/python-intern'}});}
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
