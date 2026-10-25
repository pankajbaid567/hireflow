/** Real workerd/D1/R2/worker.queue; only provider and upload timing are fixtures. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
const root=fileURLToPath(new URL('../',import.meta.url)),access='plan-lifecycle-private-fixture-code';
type Gate={entered:Promise<void>;wait:Promise<void>;notify:()=>void;release:()=>void;used:boolean;kind:'semantic'|'upload'};
function gate(kind:Gate['kind']):Gate{let notify!:()=>void,release!:()=>void;return{kind,used:false,entered:new Promise<void>(resolve=>{notify=resolve;}),wait:new Promise<void>(resolve=>{release=resolve;}),notify:()=>notify(),release:()=>release()};}
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,bucket:Awaited<ReturnType<Miniflare['getR2Bucket']>>,cookie:string,active:Gate|null,inference:number,uploads:number;
const harness=`
import runtime from './tests/runtime';
import worker from './src/index';
export default {async fetch(request,env,context){
 const bound={...env,PLAN_WORK_IN_QUEUE:'true',SEMANTIC_MATCHING_ENABLED:'false'};
 if(request.headers.get('X-Test-Queue-Outage')==='true')bound.APPLICATION_QUEUE={send:async()=>{throw new Error('controlled queue outage');}};
 if(request.headers.get('X-Test-Semantic')==='true'){
  bound.SEMANTIC_MATCHING_ENABLED='true';bound.AI={run:async(_model,input)=>{
   await fetch('https://embedding.fixture.example/gate',{method:'POST'});
   return{data:input.text.map(()=>[1,...Array(383).fill(0)]),shape:[input.text.length,384]};
  }};
 }
 bound.FILES={put:async(...args)=>{await env.FILES.put(...args);if(request.headers.get('X-Test-Put-Failure')==='true')throw new Error('private storage failure marker');await fetch('https://upload.fixture.example/gate',{method:'POST'});},get:key=>env.FILES.get(key),delete:key=>env.FILES.delete(key)};
 if(new URL(request.url).pathname==='/__test/cron'){
  await worker.scheduled({cron:'*/5 * * * *',scheduledTime:Date.now(),noRetry(){}},bound);
  return runtime.fetch(new Request('https://plan.fixture.example/__test/queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'maintenance'})}),bound,context);
 }
 return runtime.fetch(request,bound,context);
}};`;
beforeAll(()=>{bundle=buildSync({stdin:{contents:harness,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
async function request(path:string,method='GET',body?:unknown,options:{outage?:boolean;semantic?:boolean;anonymous?:boolean;putFailure?:boolean}={}){
 return mf.dispatchFetch(`https://plan.fixture.example${path}`,{method,headers:{Cookie:options.anonymous?'':cookie,'Content-Type':'application/json','X-HireFlow-Access-Code':access,...(options.outage?{'X-Test-Queue-Outage':'true'}:{}),...(options.semantic?{'X-Test-Semantic':'true'}:{}),...(options.putFailure?{'X-Test-Put-Failure':'true'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function json(path:string,method='GET',body?:unknown,options:Parameters<typeof request>[3]={}){const response=await request(path,method,body,options);expect(response.status,await response.clone().text()).toBeLessThan(300);return response.json() as Promise<Record<string,any>>;}
async function lease(){return db.prepare('SELECT * FROM resume_preparations ORDER BY application_id LIMIT 1').first<Record<string,any>>();}
async function app(id=1){return db.prepare('SELECT a.*,j.facts_version,j.description,j.title,j.quality_method FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id=?').bind(id).first<Record<string,any>>();}
async function deliver(row:Record<string,any>,semantic=false,putFailure=false){return json('/__test/queue','POST',{kind:'plan',application_id:row.application_id,token:row.token},{semantic,putFailure});}
async function add(index=1){return json('/jobs/1','POST',{title:`Python Intern ${index}`,company:`Fixture Co ${index}`,url:`https://careers.example.com/jobs/plan-${index}`,description:'Python internship building supervised course tools. Docker is required. Salary INR 15000/month.',listing_type:'internship'});}
async function ready(){let plan:Record<string,any>={};for(let index=0;index<20;index++){plan=await json('/weekly-plan/1');if(!plan.preparing)return plan;const pending=await lease();expect(pending).toBeTruthy();await deliver(pending!);}throw new Error('Fixture plan did not finish in bounded deliveries');}
async function noAuthorization(){expect((await db.prepare('SELECT count(*) AS n FROM submission_reviews').first<{n:number}>())!.n).toBe(0);expect((await db.prepare('SELECT count(*) AS n FROM outbox').first<{n:number}>())!.n).toBe(0);expect((await db.prepare("SELECT count(*) AS n FROM applications WHERE status NOT IN ('pending','planned')").first<{n:number}>())!.n).toBe(0);}
beforeEach(async()=>{
 cookie='';active=null;inference=0;uploads=0;
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'plan-fixture'},bindings:{ACCESS_CODE:access,BROWSER_ENABLED:'false',PLAN_WORK_IN_QUEUE:'true'},outboundService:async request=>{
  const host=new URL(request.url).hostname,kind=host==='embedding.fixture.example'?'semantic':host==='upload.fixture.example'?'upload':null;
  if(!kind)throw new Error('Unexpected outbound destination in private plan fixture');
  if(kind==='semantic')inference++;else uploads++;
  if(active?.kind===kind&&!active.used){active.used=true;active.notify();await active.wait;}
  return new Response('controlled fixture complete');
 }}));
 db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('FILES');await applyTestMigrations(db);
 const created=await request('/profile','POST',{name:'Plan Queue QA',email:'plan-queue@example.com',mode:'internship',skills:['Python'],summary:'Built Python course tools.',projects:[{name:'Course tools',description:'Built a Python planning project.',tech:['Python']}],weekly_quota:1});expect(created.status).toBe(201);cookie=created.headers.get('set-cookie')!.split(';')[0];
},30000);
afterEach(async()=>{active?.release();await mf?.dispose();},30000);
describe('private queued plan preparation',()=>{
 it('defers manual normalization, inference and PDF creation; deduplicates polls and actual queue deliveries',async()=>{
  expect((await add()).imported).toBe(1);expect(await app()).toMatchObject({matching_method:'pending',matching_algorithm:'pending',scored_profile_version:0,scored_job_version:0,quality_method:'pending'});expect(inference).toBe(0);expect(uploads).toBe(0);
  const plan=await json('/weekly-plan/1'),score=await lease();expect(plan).toMatchObject({preparing:true,plan:[]});expect(score).toMatchObject({kind:'score',state:'queued',attempts:0});
  await json('/weekly-plan/1');expect((await lease())!.token).toBe(score!.token);expect(inference).toBe(0);
  active=gate('semantic');const pending=deliver(score!,true);await active.entered;expect((await deliver(score!,true)).acknowledged).toBe(true);active.release();await pending;
  expect(inference).toBe(1);expect(await app()).toMatchObject({scored_profile_version:1,matching_method:'hybrid',quality_method:'evidence_rules_v1'});expect((await app())!.scored_job_version).toBe((await app())!.facts_version);
  const preparing=await json('/weekly-plan/1'),resume=await lease();expect(preparing.plan[0].resume_url).toBeNull();expect(resume!.kind).toBe('resume');
  active=gate('upload');const pdf=deliver(resume!);await active.entered;await deliver(resume!);active.release();await pdf;await deliver(resume!);
  const final=await json('/weekly-plan/1');expect(final.preparing).toBe(false);expect(final.plan[0].resume_url).toBeTruthy();expect(uploads).toBe(1);expect((await bucket.list()).objects).toHaveLength(1);expect((await app())!.resume_version).toBe(1);await noAuthorization();
  expect((await request('/weekly-plan/1','GET',undefined,{anonymous:true})).status).toBe(401);
 });
 it.each(['profile','job'] as const)('rejects %s changes while actual semantic scoring waits',async change=>{
  await add();await json('/weekly-plan/1');const score=(await lease())!;active=gate('semantic');const pending=deliver(score,true);await active.entered;
  if(change==='profile')await json('/profile/1','PATCH',{skills:['Python','TypeScript'],mode:'job'});else await db.prepare("UPDATE jobs SET title='Docker Intern',description='A Docker orchestration internship for students.' WHERE id=1").run();
  active.release();await pending;const snapshot=(await app())!;expect(snapshot.scored_profile_version===1&&snapshot.scored_job_version===snapshot.facts_version).toBe(false);expect(snapshot.resume_path).toBeNull();expect((await bucket.list()).objects).toHaveLength(0);await noAuthorization();
 });
 it.each(['profile','job','swap'] as const)('rejects %s changes during an uploaded PDF without losing historical downloads',async change=>{
  await add();await add(2);const original=await ready(),old=(await app())!,oldKeys=(await bucket.list()).objects.map(row=>row.key);
  await json('/applications/1/resume-regenerate','POST',{resume_version:old.resume_version});await json('/weekly-plan/1');const row=(await lease())!;expect(row.kind).toBe('resume');active=gate('upload');const pending=deliver(row);await active.entered;
  if(change==='profile')await json('/profile/1','PATCH',{summary:'Built documented Python course tools.'});
  else if(change==='job')await db.prepare("UPDATE jobs SET title='Docker Intern',description='A Docker orchestration internship for students.' WHERE id=1").run();
  else await json('/weekly-plan/1/swap','POST',{remove_job_id:original.plan[0].job_id,add_job_id:original.alternatives[0].job_id});
  active.release();await pending;expect((await app())!.resume_path).toBeNull();expect((await bucket.list()).objects.map(row=>row.key)).toEqual(oldKeys);
  const historical=await request(`${original.plan[0].resume_url}?version=1`);expect(historical.status).toBe(200);expect((await historical.text()).startsWith('%PDF-')).toBe(true);await noAuthorization();
 });
 it('recovers a durable undispatched lease after a queue outage through the actual cron consumer',async()=>{
  await add();await json('/weekly-plan/1','GET',undefined,{outage:true});const row=(await lease())!;expect(row.dispatched_at).toBeNull();expect(inference).toBe(0);
  expect((await json('/__test/cron','POST')).acknowledged).toBe(true);expect((await lease())!.dispatched_at).toBeTruthy();await deliver(row);expect((await app())!.scored_profile_version).toBe(1);await noAuthorization();
 });
 it('bounds abandoned lease recovery, removes unregistered puts, and stops polling until explicit retry',async()=>{
  await add();await json('/weekly-plan/1');const row=(await lease())!,orphan='resumes/1/interrupted_fixture.pdf';await bucket.put(orphan,'%PDF-fixture');
  await db.prepare("UPDATE resume_preparations SET state='running',attempts=1,object_key=?,expires_at='2000-01-01T00:00:00.000Z' WHERE application_id=?").bind(orphan,row.application_id).run();
  await json('/__test/cron','POST');expect(await bucket.get(orphan)).toBeNull();expect(await lease()).toMatchObject({state:'queued',attempts:1,object_key:null});
  await db.prepare("UPDATE resume_preparations SET state='running',attempts=2,expires_at='2000-01-01T00:00:00.000Z' WHERE application_id=?").bind(row.application_id).run();await json('/__test/cron','POST');
  const failed=await json('/weekly-plan/1');expect(failed.preparing).toBe(false);expect(failed.warnings[0]).toContain('interrupted twice');await json('/weekly-plan/1');expect((await lease())!.token).not.toBe(row.token);expect(inference).toBe(0);
  await json('/weekly-plan/1/refresh-matches','POST',{});expect((await lease())!.token).not.toBe(row.token);expect((await ready()).preparing).toBe(false);await noAuthorization();
 });
 it('rotates expired generations before recovery so an old uploaded worker cannot attach or delete newer work',async()=>{
  await add();await json('/weekly-plan/1');await deliver((await lease())!);await json('/weekly-plan/1');const old=(await lease())!;
  active=gate('upload');const oldWorker=deliver(old);await active.entered;
  const oldKey=(await lease())!.object_key;expect(await bucket.get(oldKey)).toBeTruthy();
  await db.prepare("UPDATE resume_preparations SET expires_at='2000-01-01T00:00:00.000Z' WHERE application_id=? AND token=?").bind(old.application_id,old.token).run();
  await json('/__test/cron','POST');const newer=(await lease())!;expect(newer.token).not.toBe(old.token);expect(newer).toMatchObject({state:'queued',attempts:1});expect(await bucket.get(oldKey)).toBeNull();
  // The retry owns version2. Its upload is held while old version1 resumes.
  const firstGate=active;active=gate('upload');const newWorker=deliver(newer);await active.entered;const newKey=(await lease())!.object_key;expect(newKey).not.toBe(oldKey);
  firstGate.release();await oldWorker;expect((await app())!.resume_path).toBeNull();expect((await lease())!.token).toBe(newer.token);expect((await lease())!.object_key).toBe(newKey);expect(await bucket.get(newKey)).toBeTruthy();
  active.release();await newWorker;expect((await app())!.resume_path).toBe(newKey);expect((await bucket.list()).objects.map(row=>row.key)).toEqual([newKey]);expect((await app())!.resume_version).toBe(2);await noAuthorization();
 });
 it('keeps a clean permanent failure after a partial put and requires an explicit resume retry',async()=>{
  await add();await json('/weekly-plan/1');await deliver((await lease())!);await json('/weekly-plan/1');const row=(await lease())!;
  await deliver(row,false,true);expect(await lease()).toMatchObject({state:'failed',object_key:null});expect((await bucket.list()).objects).toHaveLength(0);
  const failed=await json('/weekly-plan/1');expect(failed.preparing).toBe(false);expect(failed.plan[0].resume_url).toBeNull();expect(failed.warnings.join(' ')).toContain('could not finish');expect(JSON.stringify(failed)).not.toContain('private storage failure marker');
  const version=(await app())!.resume_version;await json('/weekly-plan/1');await deliver(row);expect((await app())!.resume_version).toBe(version);
  await json('/applications/1/resume-regenerate','POST',{resume_version:version});expect((await ready()).preparing).toBe(false);expect((await app())!.resume_version).toBe(version+1);await noAuthorization();
 });
 it('bounds repeated queued expiry even when no consumer ever claims the work',async()=>{
  await add();await json('/weekly-plan/1','GET',undefined,{outage:true});
  for(let index=0;index<2;index++){
   await db.prepare("UPDATE resume_preparations SET expires_at='2000-01-01T00:00:00.000Z'").run();await json('/__test/cron','POST');
  }
  const stopped=await json('/weekly-plan/1');expect(stopped.preparing).toBe(false);expect((await lease())!.state).toBe('failed');expect(inference).toBe(0);expect(uploads).toBe(0);await noAuthorization();
 });
 it('returns immediately at exhausted quota without re-scoring another mode and keeps historical PDFs',async()=>{
  await add();await add(2);const original=await ready(),before=(await app())!;await db.prepare("UPDATE applications SET status='applied' WHERE id=1").run();
  await json('/profile/1','PATCH',{mode:'job'});await json('/profile/1','PATCH',{mode:'internship'});const empty=await json('/weekly-plan/1');expect(empty).toMatchObject({preparing:false,plan:[]});expect(await lease()).toBeNull();expect((await app(2))!.scored_profile_version).toBe(1);expect(uploads).toBe(1);
  expect((await request(original.plan[0].resume_url)).status).toBe(200);expect((await app())!.resume_path).toBe(before.resume_path);
 });
});
