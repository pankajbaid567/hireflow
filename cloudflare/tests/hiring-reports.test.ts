/** Real Worker, owner cookies, migrations and D1; only the Gmail provider is synthetic. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
import {buildHiringReport,normalizeHiringInput,parseHiringCsv} from '../src/hiring';
import {scoreMatch} from '../src/intelligence';

const root=fileURLToPath(new URL('../',import.meta.url)),access='hiring-owner-fixture-access-code';
const input={jd_text:'Python and JavaScript engineer internship building supervised SQL APIs.',shortlist_size:2,applicants:[{name:'Project evidence',skills:['Python'],projects:[{name:'Campus records',description:'A supervised data service.',technologies:['SQL']}],education:[{degree:'B.Tech student'}]},{name:'Alias evidence',skills:['JS','Python'],experience_years:0},{name:'No match',skills:['Java']}]};
let mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,bundle:string,cookie:string,owner:number,messages:any[],response:{state:string;provider_message_id?:string;provider_status:number|null;failure_reason?:string},gate:{enter:()=>void;wait:Promise<void>}|null;
const gmailFixture=`export function gmailReadiness(env){return{ready:Boolean(env.GMAIL_USER&&env.GMAIL_APP_PASSWORD),reason:'Synthetic Gmail setup'};}export function gmailRecipientAllowed(env,recipient){return [env.GMAIL_USER,...String(env.GMAIL_ALLOWED_RECIPIENTS||'').split(',')].map(s=>s.toLowerCase()).includes(recipient.toLowerCase());}export async function sendGmailMessage(env,message){return(await fetch('https://smtp.fixture.invalid/send',{method:'POST',body:JSON.stringify(message)})).json();}export async function probeGmailConnection(){throw new Error('No real SMTP in hiring fixtures');}`;
beforeAll(async()=>{bundle=(await build({stdin:{contents:`import runtime from './tests/runtime';export default{fetch:(r,e,c)=>runtime.fetch(r,{...e,...(r.headers.get('X-Test-Hiring-Queue')==='true'?{PLAN_WORK_IN_QUEUE:'true'}:{})},c)};`,resolveDir:root,loader:'ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent',plugins:[{name:'isolated-gmail-provider',setup(build){build.onResolve({filter:/gmail_transport$/},()=>({path:'gmail-fixture',namespace:'gmail-fixture'}));build.onLoad({filter:/.*/,namespace:'gmail-fixture'},()=>({contents:gmailFixture,loader:'js'}));}}]})).outputFiles[0].text;});
async function request(path:string,method='GET',body?:unknown,session=cookie){return mf.dispatchFetch('https://hiring.fixture.invalid'+path,{method,headers:{Cookie:session||'','Content-Type':'application/json','X-HireFlow-Access-Code':access},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function json(path:string,method='GET',body?:unknown,session=cookie){const r=await request(path,method,body,session);expect(r.status,await r.clone().text()).toBeLessThan(300);return r.json() as Promise<any>;}
async function create(data:any=input){return json('/hiring/shortlist','POST',data);}
async function queuedCreate(){return mf.dispatchFetch('https://hiring.fixture.invalid/hiring/shortlist',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Test-Hiring-Queue':'true'},body:JSON.stringify(input)});}
async function emailReport(report:any,extra:any={}){return json(`/hiring/shortlists/${report.id}/email`,'POST',{recipient:'reviewer@example.com',confirm_recipient:'reviewer@example.com',report_hash:report.report_hash,reviewed:true,...extra});}
async function deliver(id:string){return json('/__test/queue','POST',{kind:'hiring_email',delivery_id:id});}
beforeEach(async()=>{
 messages=[];gate=null;response={state:'accepted',provider_status:250,provider_message_id:'synthetic-message'};
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'hiring-fixture'},bindings:{ACCESS_CODE:access,BROWSER_ENABLED:'false',EMAIL_PROVIDER:'gmail',GMAIL_USER:'sender@example.com',GMAIL_APP_PASSWORD:'syntheticpassword',GMAIL_ALLOWED_RECIPIENTS:'reviewer@example.com',FROM_EMAIL:'sender@example.com'},outboundService:async req=>{expect(req.url).toBe('https://smtp.fixture.invalid/send');messages.push(await req.json());if(gate){gate.enter();await gate.wait;}return Response.json(response);}}));
 db=await mf.getD1Database('DB');await applyTestMigrations(db);const created=await request('/profile','POST',{name:'Synthetic Hiring Owner',email:'hiring-owner@example.com',mode:'job'},'');expect(created.status).toBe(201);cookie=created.headers.get('set-cookie')!.split(';')[0];owner=(await created.json() as any).id;
},30000);
afterEach(async()=>{await mf?.dispose();},30000);
describe('evidence-based hiring reports',()=>{
 it('uses the maintained six-factor scorer, explicit technologies and canonical alias citations without protected-trait scoring',()=>{
  const normalized=normalizeHiringInput({...input,applicants:input.applicants.map(a=>({...a,age:99,gender:'PROTECTED_SENTINEL',religion:'PROTECTED_SENTINEL'}))}),report=buildHiringReport(normalized);
  const project=report.candidates.find((a:any)=>a.name==='Project evidence'),alias=report.candidates.find((a:any)=>a.name==='Alias evidence');
  expect(project.factor_scores).toEqual(scoreMatch({...normalized.applicants[0],skills:['Python','SQL']},{title:'',description:input.jd_text,listing_type:'internship'}).factors);
  expect(project.evidence.find((e:any)=>e.skill==='SQL').sources[0].source_path).toBe('applicants[0].projects[0].technologies[0]');expect(alias.evidence.find((e:any)=>e.skill==='JavaScript').sources[0].quote).toBe('JS');expect(project.facts.education[0].degree).toBe('B.Tech student');expect(project.facts.experience_years).toBeNull();expect(JSON.stringify(normalized)).not.toContain('PROTECTED_SENTINEL');
 });
 it('keeps deterministic tie order, empty/no-match behavior and strict CSV source facts',()=>{
  const tie=buildHiringReport(normalizeHiringInput({...input,shortlist_size:1,applicants:[{name:'First',skills:['Python']},{name:'Second',skills:['Python']}]}));expect(tie.shortlist[0].name).toBe('First');expect(buildHiringReport(normalizeHiringInput({...input,applicants:[]})).shortlist).toEqual([]);expect(buildHiringReport(normalizeHiringInput({...input,applicants:[{name:'None',skills:['COBOL']}]})).shortlist).toEqual([]);
  const csv='name,skills,experience_years,projects\n"Candidate, A",Python;SQL,0,"[{""name"":""Campus"",""technologies"" :[""SQL""]}]"\n';expect(normalizeHiringInput({...input,applicants:csv}).applicants[0]).toMatchObject({name:'Candidate, A',experience_years:0,projects:[{name:'Campus',technologies:['SQL']}]});expect(()=>parseHiringCsv('name,name\nA,B')).toThrow();expect(()=>parseHiringCsv('name,skills\n"Unclosed,Python')).toThrow();
 });
 it('accepts ordinary name/skills CSV without inventing or requiring experience years',async()=>{
  const report=await create({...input,applicants:'name,skills\n"CSV Candidate",Python;JS\nNo match,COBOL'});
  expect(report.applicant_count).toBe(2);expect(report.shortlist).toHaveLength(1);expect(report.shortlist[0]).toMatchObject({name:'CSV Candidate',facts:{experience_years:null}});expect(report.shortlist[0].matched_skills).toContain('JavaScript');
 });
 it('accepts a bounded applicant import above the ordinary profile payload cap and rejects an oversized request before storage',async()=>{
  const applicants=Array.from({length:7},(_,i)=>({name:`Candidate ${i}`,skills:['Python'],projects:Array.from({length:8},(_,j)=>({name:`Project ${j}`,description:'x'.repeat(1800),technologies:['Python']}))})),data={...input,applicants};
  expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeGreaterThan(100000);
  const report=await create(data);expect(report.state).toBe('completed');expect(report.applicant_count).toBe(7);
  expect((await request('/hiring/shortlist','POST',{...input,applicants:'x'.repeat(200001)})).status).toBe(413);expect((await db.prepare('SELECT count(*) AS n FROM shortlists').first<any>())!.n).toBe(1);
 });
 it.each([{applicants:[{name:'Bad',skills:'Python'}]},{applicants:[{name:'Bad',skills:[],experience_years:-1}]},{applicants:[{name:'Bad',skills:[],projects:[{}]}]},{applicants:'name,skills\nA,Python,extra'},{shortlist_size:0},{applicants:'x'.repeat(131073)}])('rejects invalid or oversized facts before storage: %j',async bad=>{
  expect((await request('/hiring/shortlist','POST',{...input,...bad})).status).toBeGreaterThanOrEqual(400);expect((await db.prepare('SELECT count(*) AS n FROM shortlists').first<any>())!.n).toBe(0);
 });
 it('persists complete private reports, escapes untrusted text, denies anonymous/cross-owner reads and paginates',async()=>{
  const report=await create({...input,applicants:[{name:'<script>candidate</script>',skills:['Python'],education:'Source college'}]});expect(report.state).toBe('completed');expect(report.report_hash).toMatch(/^[a-f0-9]{64}$/);const html=await request(report.html_url);expect(html.headers.get('cache-control')).toContain('no-store');expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");expect(await html.text()).toContain('&lt;script&gt;candidate&lt;/script&gt;');expect((await request(report.html_url,'GET',undefined,'')).status).toBe(401);
  const second=await request('/profile','POST',{name:'Other owner',email:'other-hiring@example.com',mode:'job'},''),otherCookie=second.headers.get('set-cookie')!.split(';')[0];expect((await request(`/hiring/shortlists/${report.id}`,'GET',undefined,otherCookie)).status).toBe(404);expect((await json('/hiring/shortlists','GET',undefined,otherCookie)).items).toHaveLength(0);
  expect((await json('/hiring/shortlists?page=1&page_size=1')).total).toBe(1);expect((await request('/hiring/shortlists?page_size=51')).status).toBe(422);await expect(db.prepare("UPDATE shortlists SET report_html='altered' WHERE id=?").bind(report.id).run()).rejects.toThrow();
 });
 it('durably queues production-size work, deduplicates redelivery and cancels publication on deletion',async()=>{
  const queue=async()=>{const r=await queuedCreate();expect(r.status).toBe(202);return r.json() as Promise<any>;};
  const ticket=await queue();expect(ticket.state).toBe('queued');expect((await db.prepare('SELECT report_hash FROM shortlists WHERE id=?').bind(ticket.id).first<any>())!.report_hash).toBeNull();
  await json('/__test/queue','POST',{kind:'hiring_score',shortlist_id:ticket.id});const report=await json(`/hiring/shortlists/${ticket.id}`);expect(report.state).toBe('completed');const before=await db.prepare('SELECT report_data FROM shortlists WHERE id=?').bind(report.id).first<any>();await json('/__test/queue','POST',{kind:'hiring_score',shortlist_id:report.id});expect(await db.prepare('SELECT report_data FROM shortlists WHERE id=?').bind(report.id).first()).toEqual(before);
  const stopped=await queue();await db.prepare("INSERT INTO workspace_deletions(id,user_id,profile_version,revision,state,preview_json,files_json,created_at,expires_at) VALUES(?,?,1,1,'queued','{}','[]',?,?)").bind(crypto.randomUUID(),owner,new Date().toISOString(),new Date(Date.now()+60000).toISOString()).run();await json('/__test/queue','POST',{kind:'hiring_score',shortlist_id:stopped.id});expect((await db.prepare('SELECT report_hash FROM shortlists WHERE id=?').bind(stopped.id).first<any>())!.report_hash).toBeNull();
 });
 it('bounds pending work, interrupted score attempts and the shared free daily allowance',async()=>{
  const queued=[];for(let index=0;index<3;index++){const response=await queuedCreate();expect(response.status).toBe(202);queued.push(await response.json() as any);}expect((await queuedCreate()).status).toBe(409);
  await db.prepare("UPDATE shortlists SET state='running',score_attempts=3,lease_expires_at='2000-01-01' WHERE id=?").bind(queued[0].id).run();await json('/__test/queue','POST',{kind:'maintenance'});expect((await json(`/hiring/shortlists/${queued[0].id}`)).state).toBe('failed');expect((await queuedCreate()).status).toBe(202);
  await db.prepare("UPDATE shortlists SET state='failed' WHERE state='queued'").run();await db.prepare('UPDATE login_attempts SET attempts=20 WHERE key=?').bind('hiring-report:'+new Date().toISOString().slice(0,10)).run();expect((await queuedCreate()).status).toBe(429);expect((await db.prepare('SELECT count(*) AS n FROM shortlists').first<any>())!.n).toBe(4);
 });
});
describe('explicit hiring report email',()=>{
 it('requires exact report review, confirmed allowlisted recipient and owner authorization before enqueue',async()=>{
  const report=await create();for(const data of [{reviewed:false},{report_hash:'stale'},{confirm_recipient:'different@example.com'},{recipient:'not-authorized@example.com',confirm_recipient:'not-authorized@example.com'}])expect((await request(`/hiring/shortlists/${report.id}/email`,'POST',{recipient:'reviewer@example.com',confirm_recipient:'reviewer@example.com',report_hash:report.report_hash,reviewed:true,...data})).status).toBeGreaterThanOrEqual(400);
  expect((await db.prepare('SELECT count(*) AS n FROM hiring_email_deliveries').first<any>())!.n).toBe(0);expect(messages).toEqual([]);const setup=await json('/hiring/email-readiness');expect(JSON.stringify(setup)).not.toContain('reviewer@example.com');expect(JSON.stringify(setup)).not.toContain('syntheticpassword');
 });
 it('sends one immutable snapshot, records acceptance and history, and never resends duplicate tasks/requests',async()=>{
  const report=await create(),ticket=await emailReport(report),same=await emailReport(report);expect(same.id).toBe(ticket.id);expect(messages).toEqual([]);await deliver(ticket.id);await deliver(ticket.id);expect(messages).toHaveLength(1);expect(messages[0].html).toContain('Campus records');expect(messages[0].messageId).toMatch(/^<[a-f0-9-]{36}@hireflow\.invalid>$/);const status=await json(ticket.status_url);expect(status.state).toBe('accepted');expect(status.accepted_at).toBeTruthy();expect(status.delivery_evidence).toBe('smtp_server_acceptance');expect(status.events.map((e:any)=>e.state)).toEqual(['queued','sending','accepted']);await expect(db.prepare("UPDATE hiring_email_deliveries SET recipient='changed@example.com' WHERE id=?").bind(ticket.id).run()).rejects.toThrow();
 });
 it('keeps uncertain outcomes in needs_action without an automatic or explicit blind resend',async()=>{
  response={state:'uncertain',provider_status:null,failure_reason:'Synthetic uncertain result'};const report=await create(),ticket=await emailReport(report);await deliver(ticket.id);await json('/__test/queue','POST',{kind:'maintenance'});await deliver(ticket.id);expect((await json(ticket.status_url)).state).toBe('needs_action');expect((await emailReport(report)).id).toBe(ticket.id);expect(messages).toHaveLength(1);
 });
 it('checks report integrity, recipient configuration and owner binding before outbound work',async()=>{
  const report=await create(),ticket=await emailReport(report);await expect(db.prepare('UPDATE hiring_email_deliveries SET payload_hash=? WHERE id=?').bind('not-the-original-hash',ticket.id).run()).rejects.toThrow();
  // Simulate a malformed operator import, not an API-authorized payload edit.
  const original=(await db.prepare('SELECT * FROM hiring_email_deliveries WHERE id=?').bind(ticket.id).first<any>())!;await db.prepare('DELETE FROM hiring_email_deliveries WHERE id=?').bind(ticket.id).run();
  await db.prepare('INSERT INTO hiring_email_deliveries(id,user_id,shortlist_id,recipient,sender,report_hash,payload,payload_hash,message_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(original.id,original.user_id,original.shortlist_id,original.recipient,original.sender,original.report_hash,original.payload,'invalid-envelope-hash',original.message_id,original.created_at,original.expires_at).run();await deliver(ticket.id);expect((await json(ticket.status_url)).state).toBe('failed');expect(messages).toEqual([]);await expect(db.prepare("UPDATE hiring_email_events SET state='accepted'").run()).rejects.toThrow();
 });
 it('recovers an interrupted sending lease as uncertain and expires queued work without SMTP',async()=>{
  const report=await create(),ticket=await emailReport(report);await db.prepare("UPDATE hiring_email_deliveries SET state='sending',attempts=1,lease_expires_at='2000-01-01' WHERE id=?").bind(ticket.id).run();await json('/__test/queue','POST',{kind:'maintenance'});expect((await json(ticket.status_url)).state).toBe('needs_action');expect(messages).toEqual([]);
 });
});
