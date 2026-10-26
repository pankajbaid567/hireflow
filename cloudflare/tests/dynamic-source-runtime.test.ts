/** The production reservation and script transport execute inside real workerd/D1. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
const root=fileURLToPath(new URL('../',import.meta.url));
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,calls:number,respond:()=>Response|Promise<Response>;
beforeAll(()=>{
  bundle=buildSync({stdin:{contents:`import{reserveDynamicSourceBrowser}from'./src/dynamic_source';import{readPublicSource,SourceDeferred}from'./src/source_reader';export default{async fetch(request,env){try{const input=await request.json();if(input.reserve){await reserveDynamicSourceBrowser(env);return Response.json({reserved:true});}const response=await readPublicSource(env,input.url,{...(input.timeout?{signal:AbortSignal.timeout(input.timeout)}:{})},false,{allowScripts:input.scripts===true});return Response.json({status:response.status,bytes:(await response.arrayBuffer()).byteLength,cache:response.headers.get('X-HireFlow-Source-Cache')});}catch(error){return Response.json({deferred:error instanceof SourceDeferred,attempted:error.attempted||false,reason:error.reason||'Bounded public read failed.'},{status:429});}}};`,resolveDir:root},bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;
});
beforeEach(async()=>{
  calls=0;respond=()=>new Response('globalThis.publicFixture=true;',{headers:{'Content-Type':'application/javascript'}});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{BROWSER_DAILY_BUDGET_SECONDS:'540'},outboundService:()=>{calls++;return respond();}}));
  db=await mf.getD1Database('DB');await applyTestMigrations(db);
},30000);
afterEach(async()=>{await mf?.dispose();},30000);
async function request(input:Record<string,unknown>):Promise<Record<string,any>>{const response=await mf.dispatchFetch('https://worker.fixture.example/',{method:'POST',body:JSON.stringify(input)});return {http:response.status,...await response.json() as Record<string,unknown>};}
describe('dynamic source production transport and budget contracts',()=>{
  it('reserves only one concurrent browser slot with the application spacing and preserves the daily ceiling',async()=>{
    const values=await Promise.all([request({reserve:true}),request({reserve:true})]);expect(values.filter(value=>value.http===200)).toHaveLength(1);expect(values.find(value=>value.http===429)).toMatchObject({deferred:true,attempted:false});
    expect((await db.prepare('SELECT reserved_seconds FROM browser_budget').first<{reserved_seconds:number}>())!.reserved_seconds).toBe(90);expect(calls).toBe(0);
    await db.prepare('UPDATE browser_budget SET reserved_seconds=530,last_launch_at=0').run();expect(await request({reserve:true})).toMatchObject({http:429,deferred:true,attempted:false});expect((await db.prepare('SELECT reserved_seconds FROM browser_budget').first<{reserved_seconds:number}>())!.reserved_seconds).toBe(530);
  });
  it('does not turn a script into a JD via a shared cache hit',async()=>{
    const url='https://careers.fixture.example/script.js';expect(await request({url,scripts:true})).toMatchObject({http:200,status:200});expect(calls).toBe(1);
    expect(await request({url})).toMatchObject({http:200,status:415,bytes:0});expect(calls).toBe(1);
    expect(await request({url,scripts:true})).toMatchObject({http:200,status:200,cache:'hit'});expect(calls).toBe(1);
  });
  it('honors the dynamic renderer cancellation signal without extending the normal native read deadline',async()=>{
    respond=async()=>{await new Promise(resolve=>setTimeout(resolve,200));return new Response('late public fixture');};
    const result=await request({url:'https://careers.fixture.example/job/1',timeout:20});expect(result).toMatchObject({http:429,deferred:true,attempted:true});expect(calls).toBe(1);expect(result.reason).not.toContain('late public fixture');
  });
});
