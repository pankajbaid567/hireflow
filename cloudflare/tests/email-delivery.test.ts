/** Real isolated Worker/D1/R2/Queue; provider calls stop at synthetic fixtures. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
const root=fileURLToPath(new URL('../',import.meta.url)),code='email-delivery-local-fixture';
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,bucket:Awaited<ReturnType<Miniflare['getR2Bucket']>>,cookie:string;
let calls:{url:string;body:string;key:string|null}[],provider:(r:unknown)=>Promise<Response>,gate:{entered:Promise<void>;wait:Promise<void>;notify:()=>void;release:()=>void}|null;
const harness=`import runtime from './tests/runtime';export default{async fetch(request,env,context){const bound={...env};if(request.headers.get('X-Test-Provider'))bound.EMAIL_PROVIDER=request.headers.get('X-Test-Provider');if(request.headers.get('X-Test-Missing-Key')){delete bound.RESEND_API_KEY;delete bound.SENDGRID_API_KEY;}if(request.headers.get('X-Test-Queue-Outage'))bound.APPLICATION_QUEUE={send:async()=>{throw new Error('queue fixture');}};if(request.headers.get('X-Test-Hold-Payload'))bound.FILES={put:(...args)=>env.FILES.put(...args),delete:key=>env.FILES.delete(key),get:async key=>{const file=await env.FILES.get(key);if(key.startsWith('mail/'))await fetch('https://gate.fixture.example/wait');return file;}};return runtime.fetch(request,bound,context);}};`;
beforeAll(()=>{bundle=buildSync({stdin:{contents:harness,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
type Options={session?:string;provider?:string;noKey?:boolean;outage?:boolean;hold?:boolean};
async function request(path:string,method='GET',body?:unknown,options:Options={}){return mf.dispatchFetch(`https://email.fixture.example${path}`,{method,headers:{Cookie:options.session??cookie,'Content-Type':'application/json','X-HireFlow-Access-Code':code,...(options.provider?{'X-Test-Provider':options.provider}:{}),...(options.noKey?{'X-Test-Missing-Key':'true'}:{}),...(options.outage?{'X-Test-Queue-Outage':'true'}:{}),...(options.hold?{'X-Test-Hold-Payload':'true'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function json(path:string,method='GET',body?:unknown,options:Options={}){const r=await request(path,method,body,options);expect(r.status,await r.clone().text()).toBeLessThan(300);return r.json() as Promise<Record<string,any>>;}
async function enqueue(options:Options={}){const r=await request('/report/1/latest/email','POST',{},options);expect(r.status,await r.clone().text()).toBe(202);return r.json() as Promise<Record<string,any>>;}
const status=(id:string)=>json(`/report/1/email-deliveries/${id}`);
const deliver=(id:string,options:Options={})=>json('/__test/queue','POST',{kind:'email_delivery',delivery_id:id},options);
const recovery=()=>json('/__test/queue','POST',{kind:'maintenance'});
async function row(id:string){return(await db.prepare('SELECT * FROM email_deliveries WHERE id=?').bind(id).first<Record<string,any>>())!;}
async function application(id=1,size=100,mode='internship'){
 await db.prepare('INSERT INTO jobs(id,title,company,url,description,listing_type) VALUES(?,?,?,?,?,?)').bind(id,`Python ${mode}`,`Fixture Employer ${id}`,`https://example.com/${id}`,'Python, Docker',mode).run();
 const week=new Date();week.setUTCDate(week.getUTCDate()-(week.getUTCDay()+6)%7);const start=week.toISOString().slice(0,10),key=`resumes/1/${id}/v1.pdf`;
 await db.prepare("INSERT INTO applications(id,user_id,job_id,status,resume_path,resume_version,cycle_start,matched_skills,skill_gaps) VALUES(?,1,?,'applied',?,1,?,'[\"Python\"]','[\"Docker\"]')").bind(id,id,key,start).run();
 await db.prepare('INSERT INTO resumes(application_id,version,object_key) VALUES(?,1,?)').bind(id,key).run();
 const bytes=new Uint8Array(size);bytes.set(new TextEncoder().encode('%PDF-1.4\n'));await bucket.put(key,bytes);
}
beforeEach(async()=>{
 cookie='';calls=[];gate=null;provider=async()=>Response.json({id:'fixture-provider-id'});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'email-delivery-fixture'},bindings:{ACCESS_CODE:code,BROWSER_ENABLED:'false',EMAIL_PROVIDER:'resend',RESEND_API_KEY:'local-resend-fixture-key',SENDGRID_API_KEY:'local-sendgrid-fixture-key',FROM_EMAIL:'weekly@hireflow.test',PUBLIC_BASE_URL:'https://dashboard.fixture.example/api'},outboundService:async request=>{const url=new URL(request.url);if(url.hostname==='gate.fixture.example'&&gate){gate.notify();await gate.wait;return new Response('released');}if(!['api.resend.com','api.sendgrid.com'].includes(url.hostname))throw new Error('Unexpected employer/provider request');calls.push({url:request.url,body:await request.clone().text(),key:request.headers.get('idempotency-key')});return provider(request);}}));
 db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('FILES');await applyTestMigrations(db);
 const r=await request('/profile','POST',{name:'Email QA',email:'email-qa@example.com',mode:'internship',skills:['Python']});expect(r.status).toBe(201);cookie=r.headers.get('set-cookie')!.split(';')[0];await application();await json('/report/1/generate','POST',{});
},30000);
afterEach(async()=>{gate?.release();await mf?.dispose();},30000);
describe('durable private weekly report email',()=>{
 it('queues without provider writes, binds recipient from owner, and records accepted separately from delivered',async()=>{
  const ticket=await enqueue();expect(calls).toHaveLength(0);expect(JSON.stringify(ticket)).not.toMatch(/payload_key|source_snapshot|email-qa|local-resend/);
  await deliver(ticket.id);const ready=await status(ticket.id);expect(ready).toMatchObject({state:'accepted',attempts:1,attachment_count:1,linked_count:0,delivered_at:null,provider_message_id:'fixture-provider-id'});expect(ready.accepted_at).toBeTruthy();
  const payload=JSON.parse(calls[0].body);expect(payload.to).toEqual(['email-qa@example.com']);expect(payload.attachments).toHaveLength(1);expect(atob(payload.attachments[0].content)).toContain('%PDF');expect(calls[0].key).toBe((await row(ticket.id)).idempotency_key);
  const report=await json('/report/1/latest');expect(report.email_sent_at).toBe(ready.accepted_at);expect(report.email_delivery.delivered_at).toBeNull();
 });
 it('deduplicates repeated owner requests and duplicated queue deliveries',async()=>{
  const first=await enqueue(),second=await enqueue();expect(second.id).toBe(first.id);await Promise.all([deliver(first.id),deliver(first.id)]);await deliver(first.id);expect(calls).toHaveLength(1);expect((await status(first.id)).attempts).toBe(1);
 });
 it('retries Resend uncertain outcomes only with byte-identical immutable payload and idempotency key',async()=>{
  provider=async()=>{if(calls.length===1)throw new Error('fixture network secret never shown');return Response.json({id:'fixture-provider-id'});};
  const ticket=await enqueue();await deliver(ticket.id);expect((await status(ticket.id)).state).toBe('retry_wait');
  // Report and active resume change after the first request; the retry must keep v1.
  await db.prepare("UPDATE applications SET resume_version=2,resume_path='resumes/1/1/v2.pdf' WHERE id=1").run();await bucket.put('resumes/1/1/v2.pdf','different PDF');await json('/report/1/generate','POST',{});
  await db.prepare("UPDATE email_deliveries SET next_attempt_at='2000-01-01T00:00:00Z' WHERE id=?").bind(ticket.id).run();await deliver(ticket.id);expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect((await status(ticket.id)).state).toBe('accepted');expect((await json('/report/1/latest')).email_sent_at).toBeNull();
 });
 it('never automatically retries SendGrid after a network outcome is uncertain',async()=>{
  provider=async()=>{throw new Error('fixture upstream body');};const ticket=await enqueue({provider:'sendgrid'});await deliver(ticket.id,{provider:'sendgrid'});expect((await status(ticket.id))).toMatchObject({state:'needs_action',attempts:1,delivered_at:null});await recovery();await deliver(ticket.id,{provider:'sendgrid'});expect(calls).toHaveLength(1);expect(calls[0].key).toBeNull();
 });
 it('uses SendGrid MIME attachments and labels 202 as accepted',async()=>{
  provider=async()=>new Response(null,{status:202,headers:{'x-message-id':'fixture.message-id'}});const ticket=await enqueue({provider:'sendgrid'});await deliver(ticket.id,{provider:'sendgrid'});const payload=JSON.parse(calls[0].body);expect(payload.personalizations).toEqual([{to:[{email:'email-qa@example.com'}]}]);expect(payload.attachments[0]).toMatchObject({type:'application/pdf',disposition:'attachment'});expect((await status(ticket.id))).toMatchObject({state:'accepted',delivered_at:null,provider_message_id:'fixture.message-id'});
 });
 it('recovers an interrupted Resend send within the retention window and reuses its original key',async()=>{
  const ticket=await enqueue();await deliver(ticket.id);const original=calls[0];await db.prepare("UPDATE email_deliveries SET state='sending',accepted_at=NULL,finished_at=NULL,lease_token='interrupted',lease_expires_at='2000-01-01',attempts=1 WHERE id=?").bind(ticket.id).run();await recovery();await deliver(ticket.id);expect(calls).toHaveLength(2);expect(calls[1]).toEqual(original);expect((await status(ticket.id)).state).toBe('accepted');
 });
 it.each(['sendgrid','resend'])('stops an interrupted %s send when no safe automatic retry remains',async(providerName)=>{
  const ticket=await enqueue({provider:providerName});await db.prepare("UPDATE email_deliveries SET state='sending',first_attempt_at='2000-01-01',attempts=1,lease_token='interrupted',lease_expires_at='2000-01-01' WHERE id=?").bind(ticket.id).run();await recovery();await deliver(ticket.id,{provider:providerName});expect((await status(ticket.id)).state).toBe('needs_action');expect(calls).toHaveLength(0);
 });
 it('bounds Resend retries and redacts provider bodies from saved failure reasons',async()=>{
  provider=async()=>new Response('local-resend-fixture-key secret error body',{status:503});const ticket=await enqueue();for(let i=0;i<3;i++){await db.prepare("UPDATE email_deliveries SET next_attempt_at=NULL WHERE id=?").bind(ticket.id).run();await deliver(ticket.id);}const saved=await status(ticket.id);expect(saved).toMatchObject({state:'needs_action',attempts:3});expect(JSON.stringify(saved)).not.toMatch(/fixture-key|secret error/);await deliver(ticket.id);expect(calls).toHaveLength(3);
 });
 it('reports provider setup without disclosing secrets, and refuses unconfigured sends',async()=>{
  const readiness=await json('/report/1/email-readiness','GET',undefined,{noKey:true});expect(readiness.ready).toBe(false);expect(JSON.stringify(readiness)).not.toContain('fixture-key');const r=await request('/report/1/latest/email','POST',{}, {noKey:true});expect(r.status).toBe(503);expect((await db.prepare('SELECT count(*) AS n FROM email_deliveries').first<any>())!.n).toBe(0);expect(calls).toHaveLength(0);
 });
 it('fails closed on tampered payload hashes and on missing source files',async()=>{
  const ticket=await enqueue();const source=await row(ticket.id);await bucket.delete('resumes/1/1/v1.pdf');await deliver(ticket.id);expect((await status(ticket.id)).state).toBe('failed');expect(calls).toHaveLength(0);
  // A different report creates a separate explicit request; ready payload corruption is rejected.
  await json('/report/1/generate','POST',{});const next=await enqueue();await bucket.put((await row(next.id)).payload_key,'{"tampered":true}');await db.prepare("UPDATE email_deliveries SET state='ready',payload_hash='wrong-hash' WHERE id=?").bind(next.id).run();await deliver(next.id);expect((await status(next.id)).failure_reason).toContain('integrity');expect(calls).toHaveLength(0);expect(source.payload_key).not.toBe((await row(next.id)).payload_key);
 });
 it('uses versioned authenticated links for oversized PDFs and preserves report export links',async()=>{
  await application(2,150000,'job');await application(3,100,'job');await application(4,100,'internship');
  await db.prepare("UPDATE applications SET status='needs_action',failure_reason='CAPTCHA detected',manual_action_url='https://example.com/manual/3' WHERE id=3").run();await db.prepare("UPDATE applications SET status='failed',failure_reason='Unsupported employer form' WHERE id=4").run();await db.prepare('UPDATE jobs SET compensation=? WHERE id=2').bind(JSON.stringify({currency:'INR',minimum:12000,maximum:20000,period:'month',disclosed:true})).run();
  await db.prepare("INSERT INTO prep_guides(application_id,structured_data) VALUES(1,'{\"rounds\":[],\"questions\":[],\"topics\":{}}')").run();const exported=await json('/applications/1/prep-guide/exports','POST',{});await json('/__test/queue','POST',{kind:'prep_export',export_id:exported.id});
  const report=await json('/report/1/generate','POST',{}),app=report.content.applications.find((a:any)=>a.id===1);expect(app.prep_export.id).toBe(exported.id);expect(JSON.stringify(app.prep_export)).not.toMatch(/pdf_key|html_key|prep-guides\//);expect(report.metrics.quota_policy).toBe('shared_across_modes_per_UTC_week');expect(report.content.mode_groups.map((g:any)=>[g.listing_type,g.total_applications,g.applied_count])).toEqual([['internship',2,1],['job',2,1]]);expect(report.applied_count).toBe(2);
  const ticket=await enqueue();await deliver(ticket.id);const payload=JSON.parse(calls[0].body);expect(payload.html).toContain('/resumes/1/2/download?version=1');expect(payload.html).toContain('sign in to download');expect(payload.html).toContain(`/prep-guide/exports/${exported.id}/pdf`);for(const text of ['CAPTCHA detected','Unsupported employer form','check whether it was already submitted','https://example.com/manual/3','INR 12000–20000 / month','Internship and Job share one weekly quota'])expect(payload.html).toContain(text);expect(payload.html).not.toContain('prep-guides/1/');expect((await status(ticket.id)).linked_count).toBe(1);expect(payload.attachments).toHaveLength(4);
 });
 it('isolates readiness and delivery history by owner and requires an authenticated owner request',async()=>{
  const ticket=await enqueue();expect((await request('/report/1/email-readiness','GET',undefined,{session:''})).status).toBe(401);const other=await request('/profile','POST',{name:'Other Email QA',email:'other-email@example.com',mode:'job'},{session:''});const otherCookie=other.headers.get('set-cookie')!.split(';')[0];expect((await request(ticket.status_url,'GET',undefined,{session:otherCookie})).status).toBe(404);expect((await request(`/report/2/email-deliveries/${ticket.id}`,'GET',undefined,{session:otherCookie})).status).toBe(404);
 });
 it('recovers queue outage without making an inline provider request',async()=>{
  const ticket=await enqueue({outage:true});expect((await row(ticket.id)).dispatched_at).toBeNull();await recovery();expect((await row(ticket.id)).dispatched_at).toBeTruthy();expect(calls).toHaveLength(0);await deliver(ticket.id);expect((await status(ticket.id)).state).toBe('accepted');
 });
 it.each(['success','uncertain'])('does not overwrite report summaries after a late %s response loses its delivery lease',async outcome=>{
  let notify!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{notify=r;}),wait=new Promise<void>(r=>{release=r;});provider=async()=>{notify();await wait;if(outcome==='uncertain')throw new Error('controlled late uncertain result');return Response.json({id:'fixture-provider-id'});};
  const ticket=await enqueue(outcome==='uncertain'?{provider:'sendgrid'}:{}),work=deliver(ticket.id,outcome==='uncertain'?{provider:'sendgrid'}:{});await entered;await db.prepare("UPDATE email_deliveries SET lease_token='successor-lease',failure_reason='Successor owns this attempt' WHERE id=?").bind(ticket.id).run();await db.prepare("UPDATE weekly_reports SET email_failure_reason='Successor summary' WHERE user_id=1").run();release();await work;const saved=await row(ticket.id),report=(await db.prepare('SELECT email_sent_at,email_failure_reason FROM weekly_reports WHERE user_id=1').first<any>())!;expect(saved.lease_token).toBe('successor-lease');expect(saved.failure_reason).toBe('Successor owns this attempt');expect(report).toMatchObject({email_sent_at:null,email_failure_reason:'Successor summary'});
 });
 it('cancels after owner email changes or an account deletion is queued',async()=>{
  const ticket=await enqueue();await db.prepare("UPDATE users SET email='changed@example.com' WHERE id=1").run();await deliver(ticket.id);expect((await status(ticket.id)).state).toBe('cancelled');expect(calls).toHaveLength(0);
 });
 it('rejects a queued deletion at the final send boundary',async()=>{
  const ticket=await enqueue(),now=new Date().toISOString();await db.prepare("INSERT INTO workspace_deletions(id,user_id,profile_version,revision,expires_at,state,preview_json,files_json,created_at) VALUES('delete-email-fixture',1,1,0,?,'queued','{}','[]',?)").bind(new Date(Date.now()+3600000).toISOString(),now).run();await deliver(ticket.id);expect(calls).toHaveLength(0);expect((await row(ticket.id)).state).toBe('cancelled');
 });
 it('recovers an expired preparation lease after a previous safe Resend attempt',async()=>{
  provider=async()=>new Response(null,{status:503});const ticket=await enqueue();await deliver(ticket.id);const original=calls[0];await db.prepare("UPDATE email_deliveries SET state='ready',lease_token='lost-before-post',lease_expires_at='2000-01-01',next_attempt_at=NULL WHERE id=?").bind(ticket.id).run();await recovery();provider=async()=>Response.json({id:'fixture-provider-id'});await deliver(ticket.id);expect(calls[1]).toEqual(original);expect((await status(ticket.id)).state).toBe('accepted');
 });
 it('does not exceed ten attachments and links every remaining versioned PDF',async()=>{
  for(let id=2;id<=11;id++)await application(id);await json('/report/1/generate','POST',{});const ticket=await enqueue();await deliver(ticket.id);const payload=JSON.parse(calls[0].body);expect(payload.attachments).toHaveLength(10);expect(payload.html).toContain('/resumes/1/11/download?version=1');expect((await status(ticket.id)).linked_count).toBe(1);
 });
 it('rejects tombstoned source publication and records owner revisions for every delivery mutation',async()=>{
  const before=(await db.prepare('SELECT revision FROM workspace_revisions WHERE user_id=1').first<any>())!.revision;const ticket=await enqueue();const after=(await db.prepare('SELECT revision FROM workspace_revisions WHERE user_id=1').first<any>())!.revision;expect(after).toBeGreaterThan(before);await expect(db.prepare("UPDATE email_deliveries SET recipient='different@example.com' WHERE id=?").bind(ticket.id).run()).rejects.toThrow(/immutable/);
  await json('/report/1/generate','POST',{});const report=(await db.prepare('SELECT html_path FROM weekly_reports WHERE user_id=1').first<any>())!;await db.prepare('INSERT INTO workspace_artifact_tombstones(object_key,claimed_at) VALUES(?,?)').bind(report.html_path,new Date().toISOString()).run();const response=await request('/report/1/latest/email','POST',{});expect(response.status).toBeGreaterThanOrEqual(400);expect(calls).toHaveLength(0);
 });
 it('rechecks scheduled consent after payload reads and cancels before any provider write',async()=>{
  // Construct a genuine scheduler-owned durable row through its queue stage.
  const now=new Date().toISOString();await db.prepare("INSERT INTO weekly_schedules(user_id,enabled,timezone,weekday,hour,minute,discovery_target,prepare_guides,email_opt_in,updated_at) VALUES(1,1,'Asia/Kolkata',1,9,0,1,0,1,?)").bind(now).run();await db.prepare("INSERT INTO weekly_schedule_runs(id,user_id,local_week,schedule_version,profile_version,settings,state,stage,created_at,expires_at) VALUES('email-schedule-fixture',1,'2026-10-19',1,1,'{}','waiting','email',?,?)").bind(now,new Date(Date.now()+3600000).toISOString()).run();await json('/__test/queue','POST',{kind:'weekly_schedule',run_id:'email-schedule-fixture'});const delivery=(await db.prepare('SELECT * FROM email_deliveries').first<any>())!;expect(delivery.schedule_run_id).toBe('email-schedule-fixture');
  let notify!:()=>void,release!:()=>void;gate={entered:new Promise<void>(r=>{notify=r;}),wait:new Promise<void>(r=>{release=r;}),notify:()=>notify(),release:()=>release()};const work=deliver(delivery.id,{hold:true});await gate.entered;await db.prepare('UPDATE weekly_schedules SET enabled=0,version=version+1 WHERE user_id=1').run();gate.release();await work;expect((await status(delivery.id)).state).toBe('cancelled');expect(calls).toHaveLength(0);
 });
 it.each(['scheduled','existing_manual'])('reuses the original %s delivery when its email stage replays after report regeneration',async origin=>{
  const now=new Date().toISOString();await db.prepare("INSERT INTO weekly_schedules(user_id,enabled,timezone,weekday,hour,minute,discovery_target,prepare_guides,email_opt_in,updated_at) VALUES(1,1,'Asia/Kolkata',1,9,0,1,0,1,?)").bind(now).run();await db.prepare("INSERT INTO weekly_schedule_runs(id,user_id,local_week,schedule_version,profile_version,settings,state,stage,created_at,expires_at) VALUES('email-replay-fixture',1,'2026-10-19',1,1,'{}','waiting','email',?,?)").bind(now,new Date(Date.now()+3600000).toISOString()).run();
  if(origin==='existing_manual')await enqueue();await json('/__test/queue','POST',{kind:'weekly_schedule',run_id:'email-replay-fixture'});const first=(await db.prepare('SELECT * FROM email_deliveries').first<any>())!;expect((await db.prepare("SELECT email_delivery_id FROM weekly_schedule_runs WHERE id='email-replay-fixture'").first<any>())!.email_delivery_id).toBe(first.id);if(origin==='existing_manual')expect(first.schedule_run_id).toBeNull();await deliver(first.id);const originalBody=calls[0].body;
  await json('/report/1/generate','POST',{});await db.prepare("UPDATE weekly_schedule_runs SET state='waiting',stage='email',next_wake_at=NULL,lease_token=NULL WHERE id='email-replay-fixture'").run();await json('/__test/queue','POST',{kind:'weekly_schedule',run_id:'email-replay-fixture'});
  const rows=await db.prepare('SELECT * FROM email_deliveries').all<any>();expect(rows.results).toHaveLength(1);expect(rows.results[0]).toMatchObject({id:first.id,payload_key:first.payload_key,report_key:first.report_key,state:'accepted',attempts:1});expect(await(await bucket.get(first.payload_key))!.text()).toBe(originalBody);expect(calls).toHaveLength(1);
 });
});
