/** Real D1/R2 races with only inference and upload timing controlled. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
import {canonicalListingUrl,parseCompensation} from '../src/listing_details';
const root=fileURLToPath(new URL('../',import.meta.url)),code='jd-race-owned-test-code-long-enough';
type Gate={entered:Promise<void>;release:()=>void;wait:Promise<void>;notify:()=>void;used:boolean};
function gate():Gate{let notify!:()=>void,release!:()=>void;return{entered:new Promise<void>(resolve=>{notify=resolve;}),wait:new Promise<void>(resolve=>{release=resolve;}),notify:()=>notify(),release:()=>release(),used:false};}
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,bucket:Awaited<ReturnType<Miniflare['getR2Bucket']>>,cookie:string,active:Gate|null;
const harness=`
import worker from './src/index';
export default {async fetch(request,env,ctx){
  const race=request.headers.get('X-Test-Race');const bound={...env,SEMANTIC_MATCHING_ENABLED:race==='semantic'?'true':'false',GROQ_API_KEY:race==='tailor'?'synthetic-groq-fixture-key-long-enough':undefined};
  if(race==='semantic')bound.AI={run:async(_model,input)=>{
    await fetch('https://embedding.fixture.example/gate',{method:'POST',body:JSON.stringify(input)});
    return{data:input.text.map(()=>[1,...Array(383).fill(0)]),shape:[input.text.length,384]};
  }};
  if(race==='upload')bound.FILES={put:async(...args)=>{await env.FILES.put(...args);await fetch('https://upload.fixture.example/gate',{method:'POST'});},get:key=>env.FILES.get(key),delete:key=>env.FILES.delete(key)};
  return worker.fetch(request,bound,ctx);
}};`;
beforeAll(()=>{bundle=buildSync({stdin:{contents:harness,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
async function request(path:string,method='GET',body?:unknown,race?:string){return mf.dispatchFetch(`https://jd.fixture.example${path}`,{method,headers:{Cookie:cookie||'','Content-Type':'application/json','X-HireFlow-Access-Code':code,...(race?{'X-Test-Race':race}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
async function json(path:string,method='GET',body?:unknown,race?:string){const response=await request(path,method,body,race);expect(response.status,await response.clone().text()).toBeLessThan(300);return response.json() as Promise<Record<string,any>>;}
async function snapshot(){const app=await db.prepare('SELECT a.*,j.facts_version,j.description,j.title FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id=1').first<Record<string,any>>();if(!app)throw new Error('Missing synthetic application');return app;}
async function changeJob(){await db.prepare("UPDATE jobs SET title='Docker Engineer',description='Docker orchestration role. Two years of relevant experience required. Salary INR 600000/year.' WHERE id=1").run();}
beforeEach(async()=>{
  cookie='';active=null;
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'jd-fixture'},bindings:{ACCESS_CODE:code,BROWSER_ENABLED:'false'},outboundService:async request=>{
    const host=new URL(request.url).hostname;
    if(!['embedding.fixture.example','upload.fixture.example','api.groq.com'].includes(host))throw new Error('Unexpected external destination in isolated race fixture');
    if(active&&!active.used){active.used=true;active.notify();await active.wait;}
    if(host==='api.groq.com'){
      const body=await request.json() as {messages:Array<{content:string}>};const data=JSON.parse(body.messages.at(-1)!.content.split('DATA:\n')[1]);
      const selection={summary_fact_ids:data.source_facts.slice(0,1).map((fact:{id:string})=>fact.id),project_indices:data.projects.slice(0,3).map((project:{index:number})=>project.index)};
      return Response.json({choices:[{message:{content:JSON.stringify(selection)}}]});
    }
    return new Response('fixture complete');
  }}));
  db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('FILES');await applyTestMigrations(db);
  const created=await request('/profile','POST',{name:'JD Race Owner',email:'jd-race@example.com',mode:'internship',skills:['Python'],summary:'Built Python course tools.',projects:[{name:'Planner',description:'Built a Python planning project.',tech:['Python']}],weekly_quota:1});expect(created.status).toBe(201);cookie=created.headers.get('set-cookie')!.split(';')[0];
  await json('/jobs/1','POST',{title:'Python Intern',company:'Race Fixture Employer',url:'https://example.com/jobs/race',description:'Python internship for a student building course tools.',listing_type:'internship'});
  await json('/weekly-plan/1');
},30000);
afterEach(async()=>{active?.release();await mf?.dispose();},30000);

describe('material JD snapshot isolation',()=>{
  it('never marks an old embedding/ranking snapshot as current after a concurrent JD edit',async()=>{
    await db.prepare('UPDATE applications SET scored_job_version=0,resume_path=NULL WHERE id=1').run();
    active=gate();const pending=request('/weekly-plan/1','GET',undefined,'semantic');await active.entered;await changeJob();active.release();
    const response=await pending;expect(response.status).toBe(200);
    const app=await snapshot();expect(app.scored_job_version).not.toBe(app.facts_version);expect(app.resume_path).toBeNull();
    const refreshed=await json('/weekly-plan/1');expect(refreshed.plan[0].role_title).toBe('Docker Engineer');
    const current=await snapshot();expect(current.scored_job_version).toBe(current.facts_version);expect(JSON.parse(current.skill_gaps)).toContain('Docker');
  });
  it('cannot attach a PDF tailored for a previous JD after the provider resumes',async()=>{
    const original=await snapshot();await db.prepare('UPDATE applications SET resume_path=NULL WHERE id=1').run();
    active=gate();const pending=request('/weekly-plan/1','GET',undefined,'tailor');await active.entered;await changeJob();active.release();
    expect((await pending).status).toBe(200);const app=await snapshot();expect(app.resume_path).toBeNull();
    expect((await db.prepare('SELECT version FROM resumes WHERE application_id=1 ORDER BY version').all<{version:number}>()).results).toEqual([{version:original.resume_version}]);
    expect((await bucket.list()).objects.map(object=>object.key)).toEqual([original.resume_path]);
  });
  it('does not attach an edited upload after its listing header changed in flight',async()=>{
    const original=await snapshot(),draft=await json('/applications/1/resume-draft');
    active=gate();const pending=request('/applications/1/resume-draft','PUT',{base_version:original.resume_version,profile_version:1,draft:{...draft.draft,summary:'Built a reviewed Python planning project.'}},'upload');
    await active.entered;await changeJob();active.release();expect((await pending).status).toBe(409);
    const app=await snapshot();expect(app.resume_path).toBeNull();expect(app.resume_version).toBe(original.resume_version);
    expect((await db.prepare('SELECT count(*) AS n FROM resumes WHERE application_id=1').first<{n:number}>())!.n).toBe(1);
    expect((await bucket.list()).objects.map(object=>object.key)).toEqual([original.resume_path]);
  });
});

describe('negative listing-fact controls',()=>{
  it('keeps empty structured pay unknown rather than inventing a zero salary',()=>{
    const value=parseCompensation('Salary undisclosed',{currency:'INR',value:{minValue:'',maxValue:' ',unitText:'MONTH'}});expect(value.disclosed).toBe(false);expect(value.minimum).toBeNull();expect(value.maximum).toBeNull();
  });
  it('does not turn company revenue measured in LPA into candidate compensation',()=>{expect(parseCompensation('Our company revenue is 8 LPA; salary undisclosed').disclosed).toBe(false);});
  it('retains unknown posting identifiers named ref or source',()=>{
    expect(canonicalListingUrl('https://careers.example.com/apply?ref=jobA')).not.toBe(canonicalListingUrl('https://careers.example.com/apply?ref=jobB'));
    expect(canonicalListingUrl('https://careers.example.com/apply?source=jobA')).not.toBe(canonicalListingUrl('https://careers.example.com/apply?source=jobB'));
  });
});
