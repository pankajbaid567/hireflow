/** Actual workerd + shared D1; every outbound response is a controlled fixture. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
const root=fileURLToPath(new URL('../',import.meta.url));
type SourceRequest={url:string;method:string;headers:{get(name:string):string|null;has(name:string):boolean}};
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,calls:SourceRequest[],respond:(request:SourceRequest)=>Response|Promise<Response>;
const harness=`import{verifyDiscoveryDetail}from'./src/intelligence';import{readPublicSource,reserveDiscoveryUsage,SourceDeferred}from'./src/source_reader';export default{async fetch(request,env){try{const data=await request.json();if(data.verify)return Response.json({job:await verifyDiscoveryDetail({...env,DISCOVERY_SHARED_GUARDS:'true'},{url:data.url,title:'Python Intern',company:'Fixture Employer'})});if(data.kind){await reserveDiscoveryUsage(env,data.kind);return Response.json({reserved:true});}const response=await readPublicSource(env,data.url,data.init||{},data.refresh||false),bytes=await response.arrayBuffer();return Response.json({status:response.status,headers:Object.fromEntries(response.headers),bytes:bytes.byteLength,text:new TextDecoder().decode(bytes)});}catch(error){return Response.json({deferred:error instanceof SourceDeferred,attempted:error.attempted||false,delay:error.delaySeconds||0,error:error.message},{status:error instanceof SourceDeferred?429:422});}}};`;
beforeAll(()=>{bundle=buildSync({stdin:{contents:harness,resolveDir:root,loader:'ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
beforeEach(async()=>{calls=[];respond=()=>new Response('Montréal हिंदी public source',{headers:{'Content-Type':'text/html'}});mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{DISCOVERY_DAILY_SEARCH_BUDGET:'25',DISCOVERY_DAILY_DETAIL_BUDGET:'400'},outboundService:request=>{calls.push(request);return respond(request);}}));db=await mf.getD1Database('DB');await applyTestMigrations(db);},30000);
afterEach(async()=>{await mf?.dispose();},30000);
async function read(url='https://source.example.com/jobs/one',init:RequestInit={},refresh=false):Promise<Record<string,any>>{const response=await mf.dispatchFetch('https://fixture.example/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,init,refresh})});return{http:response.status,...await response.json() as Record<string,any>};}
async function available(){await db.prepare('UPDATE source_domain_limits SET next_at=0,blocked_until=0').run();}
async function usage(){return (await db.prepare("SELECT details FROM discovery_daily_usage WHERE day=?").bind(new Date().toISOString().slice(0,10)).first<{details:number}>())?.details||0;}
describe('shared public source cache and rate limits',()=>{
 it('reuses bounded public UTF-8 source bytes across requests without another quota reservation',async()=>{
  const first=await read(),second=await read();expect(first.text).toBe('Montréal हिंदी public source');expect(second.text).toBe(first.text);expect(second.headers['x-hireflow-source-cache']).toBe('hit');expect(calls).toHaveLength(1);expect(await usage()).toBe(1);
 });
 it('atomically enforces host spacing on concurrent different URLs and canonicalizes a trailing-dot hostname',async()=>{
  const values=await Promise.all([read('https://source.example.com./jobs/one'),read('https://source.example.com/jobs/two')]);expect(values.filter(row=>row.http===200)).toHaveLength(1);expect(values.find(row=>row.deferred)).toMatchObject({attempted:false});expect(calls).toHaveLength(1);expect(await usage()).toBe(1);
 });
 it('atomically bounds account search reservations across callers',async()=>{
  const values=await Promise.all(Array.from({length:30},()=>mf.dispatchFetch('https://fixture.example/reserve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'searches'})})));expect(values.filter(row=>row.status===200)).toHaveLength(25);expect(values.filter(row=>row.status===429)).toHaveLength(5);expect(calls).toHaveLength(0);
 });
 it.each([{'Cache-Control':'private'},{'Cache-Control':'no-store'},{'Cache-Control':'no-cache'},{'Cache-Control':'max-age=0'},{'Set-Cookie':'synthetic=session'},{Vary:'Cookie'}])('does not cache private or revalidation-only responses %j',async headers=>{
  respond=()=>{const safe=new Headers();for(const [name,value]of Object.entries(headers))if(value!==undefined)safe.set(name,value);return new Response('public fixture',{headers:safe});};await read();await available();await read();expect(calls).toHaveLength(2);expect((await db.prepare('SELECT count(*) AS n FROM source_read_cache').first<{n:number}>())!.n).toBe(0);
 });
 it('honors max-age/Age and evicts a previous public response when it becomes no-store or closed',async()=>{
  respond=()=>new Response('active',{headers:{'Cache-Control':'max-age=60',Age:'10'}});await read();const row=await db.prepare('SELECT expires_at FROM source_read_cache').first<{expires_at:string}>();expect(Date.parse(row!.expires_at)-Date.now()).toBeGreaterThan(48000);expect(Date.parse(row!.expires_at)-Date.now()).toBeLessThanOrEqual(50000);
  await available();respond=()=>new Response('private new response',{headers:{'Cache-Control':'no-store'}});await read(undefined,{},true);expect((await db.prepare('SELECT count(*) AS n FROM source_read_cache').first<{n:number}>())!.n).toBe(0);
  await available();respond=()=>new Response('active again');await read();await available();respond=()=>new Response('login or removed',{status:404});expect((await read(undefined,{},true)).status).toBe(404);expect((await read()).status).toBe(404);expect((await read()).text).toBe('');
 });
 it('persists Retry-After dates without reducing a day-long requested pause to one hour',async()=>{
  respond=()=>new Response(null,{status:429,headers:{'Retry-After':new Date(Date.now()+86400000).toUTCString()}});const first=await read();expect(first).toMatchObject({http:429,deferred:true,attempted:true});expect(first.delay).toBeGreaterThan(86390);expect((await read('https://source.example.com/jobs/two'))).toMatchObject({deferred:true,attempted:false});expect(calls).toHaveLength(1);
 });
 it('persists increasing backoff after upstream transport/5xx failures and does not leak upstream details',async()=>{
  respond=()=>{throw new Error('synthetic private upstream detail');};const first=await read();expect(first).toMatchObject({deferred:true,attempted:true,delay:10});expect(first.error).not.toContain('private upstream');await available();const second=await read();expect(second.delay).toBe(20);expect((await db.prepare('SELECT failures,last_status FROM source_domain_limits').first())).toMatchObject({failures:2,last_status:500});
 });
 it('bounds bytes, skips partial cache entries and never forwards caller credentials',async()=>{
  respond=request=>{expect(request.headers.has('Cookie')).toBe(false);expect(request.headers.has('Authorization')).toBe(false);return new Response('x'.repeat(200000),{headers:{'Content-Type':'text/plain'}});};const value=await read(undefined,{headers:{Cookie:'synthetic-private-cookie',Authorization:'Bearer synthetic-private-token'}});expect(value.bytes).toBe(180000);expect(value.headers['x-hireflow-truncated']).toBe('true');expect((await db.prepare('SELECT count(*) AS n FROM source_read_cache').first<{n:number}>())!.n).toBe(0);
 });
 it.each(['http://127.0.0.1/private','http://169.254.169.254/latest','https://source.example.com:8443/private','https://source.example.com/jobs?access_token=synthetic','https://source.example.com/jobs?api_key=synthetic','https://user:secret@source.example.com/jobs'])('rejects unsafe/credential-like URLs before any outbound request: %s',async url=>{expect((await read(url)).http).toBe(422);expect(calls).toHaveLength(0);expect(await usage()).toBe(0);});
 it('returns large bounded Ashby boards without exceeding a D1 row or caching partial data',async()=>{
  respond=()=>Response.json({jobs:[],publicFixture:'x'.repeat(2200000)});const value=await read('https://api.ashbyhq.com/posting-api/job-board/fixture');expect(value.bytes).toBeGreaterThan(2*1024*1024);expect(value.bytes).toBeLessThan(4*1024*1024);expect((await db.prepare('SELECT count(*) AS n FROM source_read_cache').first<{n:number}>())!.n).toBe(0);
 });
 it('finishes a same-host canonical redirect while respecting the shared per-host interval',async()=>{
  const description='Build Python APIs for supervised student projects. Write focused tests and documentation, review small changes with a mentor, and validate inputs before publishing.';
  respond=request=>new URL(request.url).pathname==='/jobs/one'?new Response(null,{status:302,headers:{Location:'/jobs/two'}}):new Response(`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Python Intern',hiringOrganization:{name:'Fixture Employer'},description,employmentType:'INTERN'})}</script>`);
  const response=await mf.dispatchFetch('https://fixture.example/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({verify:true,url:'https://source.example.com/jobs/one'})}),result=await response.json() as Record<string,any>;
  expect(result.job).toMatchObject({title:'Python Intern',url:'https://source.example.com/jobs/two',description});expect(calls).toHaveLength(2);expect(await usage()).toBe(2);
 });
 it('returns redirects without reading their bodies and rejects a private next hop before I/O',async()=>{
  respond=()=>new Response('x'.repeat(200000),{status:302,headers:{Location:'http://10.0.0.1/private','Set-Cookie':'synthetic=private'}});const redirect=await read();expect(redirect.status).toBe(302);expect(redirect.bytes).toBe(0);expect(redirect.headers.location).toBe('http://10.0.0.1/private');expect(redirect.headers['set-cookie']).toBeUndefined();expect((await read(redirect.headers.location)).http).toBe(422);expect(calls).toHaveLength(1);
 });
});
