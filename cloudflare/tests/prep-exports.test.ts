/** Actual workerd/D1/R2/Queue exports; no provider or employer requests. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
import {prepDocument} from '../src/prep_document';
const root=fileURLToPath(new URL('../',import.meta.url)),access='prep-exports-private-fixture-code',path='/applications/1/prep-guide/exports';
const proofDir='/tmp/hireflow-prep-export-qa';
const pdfPython=process.env.HIREFLOW_PDF_PYTHON || (existsSync(`${root}../venv/bin/python`)?`${root}../venv/bin/python`:'python3');
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,bucket:Awaited<ReturnType<Miniflare['getR2Bucket']>>,cookie:string;
let gate:{entered:Promise<void>;release:()=>void;wait:Promise<void>;notify:()=>void;used:boolean}|null;
const guide=()=>({prediction_kind:'jd_explicit',topic_evidence:[{topic:'Docker',level:'gaps',basis:'missing',explanation:'TOPIC_EVIDENCE_TOKEN'}],rounds:[{number:1,type:'technical',focus:'Python APIs and Docker',estimated:false,evidence:{kind:'jd',quote:'JD_EVIDENCE_TOKEN Python API interview'}},{number:2,type:'HR',focus:'Projects and communication'}],topics:{strong:['Python'],moderate:['FastAPI'],gaps:['Docker']},resources:{Python:[{title:'Python tutorial',url:'https://docs.python.org/3/tutorial/',description:'Official language guide.'}],Docker:[{title:'Docker documentation',url:'https://docs.docker.com/get-started/'}]},questions:[{category:'technical',question:'How would you test this Python API?'},{category:'behavioral',question:'Explain your course project.'},{category:'design',question:'Design a small Docker deployment.'}],warnings:['Synthetic fixture: interview stages are predictions.']});
const intel=()=>({claim_evidence:{tech_stack:[{value:'Python',url:'https://example.com/company',quote:'COMPANY_EVIDENCE_TOKEN Python',kind:'public_page',checked_at:'2026-10-25T00:00:00Z'}]},career_sources:[{title:'Careers',url:'https://example.com/careers',text:'CAREER_EVIDENCE_TOKEN',kind:'public_page'}],stage:'unknown',team_size:'unknown',tech_stack:['Python'],recent_news:[{title:'Synthetic company update',date:'2026-10-25',url:'https://example.com/news/update'}],interview_patterns:[],sources:[{title:'Company source',url:'https://example.com/company'}],interview_review_status:'No interview reviews found',fallback_guidance:'Ask the recruiter about confirmed stages.'});
const harness=`
import runtime from './tests/runtime';
export default {async fetch(request,env,context){
 const bound={...env,FILES:{put:async(...args)=>{await env.FILES.put(...args);if(request.headers.get('X-Test-Put-Failure')==='true'&&args[0].endsWith('.pdf'))throw new Error('private storage upstream marker');if(request.headers.get('X-Test-Hold-Put')==='true')await fetch('https://upload.fixture.example/gate',{method:'POST'});},get:key=>env.FILES.get(key),delete:key=>env.FILES.delete(key)}};
 if(request.headers.get('X-Test-Queue-Outage')==='true')bound.APPLICATION_QUEUE={send:async()=>{throw new Error('controlled queue outage');}};
 return runtime.fetch(request,bound,context);
}};`;
beforeAll(()=>{bundle=buildSync({stdin:{contents:harness,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;mkdirSync(proofDir,{recursive:true,mode:0o700});});
async function request(url:string,method='GET',body?:unknown,options:{session?:string;hold?:boolean;outage?:boolean;putFailure?:boolean}={}){return mf.dispatchFetch(`https://prep.fixture.example${url}`,{method,headers:{Cookie:options.session??cookie,'Content-Type':'application/json','X-HireFlow-Access-Code':access,...(options.hold?{'X-Test-Hold-Put':'true'}:{}),...(options.outage?{'X-Test-Queue-Outage':'true'}:{}),...(options.putFailure?{'X-Test-Put-Failure':'true'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function json(url:string,method='GET',body?:unknown,options:Parameters<typeof request>[3]={}){const response=await request(url,method,body,options);expect(response.status,await response.clone().text()).toBeLessThan(300);return response.json() as Promise<Record<string,any>>;}
async function start(options:Parameters<typeof request>[3]={},regenerate=false){const response=await request(path,'POST',{regenerate},options);expect(response.status).toBe(202);return response.json() as Promise<Record<string,any>>;}
async function deliver(id:string,hold=false){return json('/__test/queue','POST',{kind:'prep_export',export_id:id},{hold});}
async function complete(){const ticket=await start();await deliver(ticket.id);const state=await json(`${path}/${ticket.id}`);expect(state.state,state.failure_reason).toBe('ready');return state;}
async function pdf(row:Record<string,any>){const response=await request(row.pdf_url);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('content-type')).toBe('application/pdf');return new Uint8Array(await response.arrayBuffer());}
function readPdf(bytes:Uint8Array){const result=JSON.parse(execFileSync(pdfPython,['-c',`from pypdf import PdfReader
import io,json,sys
r=PdfReader(io.BytesIO(sys.stdin.buffer.read()))
links=[str(a.get_object().get('/A',{}).get('/URI','')) for p in r.pages for a in p.get('/Annots',[])]
print(json.dumps({'visual_order_text':'\\n'.join(p.extract_text() or '' for p in r.pages),'pages':len(r.pages),'links':links},ensure_ascii=False))`],{input:bytes,encoding:'utf8'}));return{...result,text:execFileSync('pdftotext',['-layout','-','-'],{input:bytes,encoding:'utf8'})};}
beforeEach(async()=>{
 cookie='';gate=null;
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'prep-export-fixture'},bindings:{ACCESS_CODE:access,BROWSER_ENABLED:'false'},outboundService:async request=>{if(new URL(request.url).hostname!=='upload.fixture.example')throw new Error('Unexpected provider/employer request');if(gate&&!gate.used){gate.used=true;gate.notify();await gate.wait;}return new Response('controlled local gate');}}));
 db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('FILES');await applyTestMigrations(db);
 const profile=await request('/profile','POST',{name:'Export QA',email:'export-qa@example.com',mode:'internship',skills:['Python']});expect(profile.status).toBe(201);cookie=profile.headers.get('set-cookie')!.split(';')[0];
 await db.prepare("INSERT INTO jobs(title,company,url,description,listing_type) VALUES('Python Intern','किरण Café','https://example.com/jobs/python','A supervised Python internship.','internship')").run();
 await db.prepare("INSERT INTO applications(user_id,job_id,status) VALUES(1,1,'planned')").run();
 await db.prepare('INSERT INTO prep_guides(application_id,structured_data,company_intel,source_profile_version,source_job_version) VALUES(1,?,?,1,1)').bind(JSON.stringify(guide()),JSON.stringify(intel())).run();
},30000);
afterEach(async()=>{gate?.release();await mf?.dispose();},30000);
describe('private versioned standalone prep exports',()=>{
 it('renders all guide sections and working link targets in actual HTML/PDF, with Unicode text and no submission authorization',async()=>{
  const ready=await complete();expect(ready).toMatchObject({state:'ready',version:1,stale:false,source:{profile_version:1,job_version:1,guide_revision:1}});
  const bytes=await pdf(ready),reader=readPdf(bytes);writeFileSync(`${proofDir}/complete-guide.pdf`,bytes,{mode:0o600});
  for(const text of ['किरण Café','Interview rounds','Topics to study','Python','Docker','Mock interview questions','Company evidence','Recent news','Evidence limits and notes','No interview reviews found','JD_EVIDENCE_TOKEN','TOPIC_EVIDENCE_TOKEN','COMPANY_EVIDENCE_TOKEN','CAREER_EVIDENCE_TOKEN'])expect(reader.text).toContain(text);
  expect(reader.links).toEqual(expect.arrayContaining(['https://docs.python.org/3/tutorial/','https://docs.docker.com/get-started/','https://example.com/company']));expect(reader.pages).toBeGreaterThan(1);
  const html=await request(ready.html_url);expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");const body=await html.text();expect(body).toContain('target="_blank" rel="noopener noreferrer"');expect(body).toContain('captured profile version 1');expect(body).not.toContain('export-qa@example.com');
  expect(JSON.stringify(ready)).not.toMatch(/input_snapshot|prep-guides\/|html_key|pdf_key/);
  expect((await db.prepare('SELECT count(*) AS n FROM submission_reviews').first<{n:number}>())!.n).toBe(0);expect((await db.prepare('SELECT count(*) AS n FROM outbox').first<{n:number}>())!.n).toBe(0);
 });
 it('deduplicates active queue deliveries and reuses a ready unchanged snapshot',async()=>{
  const ticket=await start();let notify!:()=>void,release!:()=>void;gate={entered:new Promise<void>(r=>{notify=r;}),wait:new Promise<void>(r=>{release=r;}),notify:()=>notify(),release:()=>release(),used:false};
  const pending=deliver(ticket.id,true);await gate.entered;expect((await deliver(ticket.id)).acknowledged).toBe(true);gate.release();await pending;
  const again=await request(path,'POST',{});expect(again.status).toBe(200);expect((await again.json() as any).id).toBe(ticket.id);expect((await bucket.list()).objects).toHaveLength(2);expect((await db.prepare('SELECT count(*) AS n FROM prep_guide_exports').first<{n:number}>())!.n).toBe(1);
 });
 it('exports real documentation chevrons without dropping evidence or citation links',async()=>{
  const saved={...guide(),resources:{...guide().resources,SQL:[{title:'SQL tutorial',url:'https://www.w3schools.com/sql/',description:'SQL_REFERENCE_START ❮ and ❯ SQL_REFERENCE_END'}]}};await db.prepare('UPDATE prep_guides SET structured_data=? WHERE application_id=1').bind(JSON.stringify(saved)).run();
  const ready=await complete(),bytes=await pdf(ready),reader=readPdf(bytes);expect(reader.text).toContain('SQL_REFERENCE_START < and > SQL_REFERENCE_END');expect(reader.links).toContain('https://www.w3schools.com/sql/');const html=await(await request(ready.html_url)).text();expect(html).toContain('SQL_REFERENCE_START ❮ and ❯ SQL_REFERENCE_END');
 });
 it('keeps immutable older downloads, labels stale snapshots and creates a new guide revision',async()=>{
  const original=await complete(),before=await pdf(original);const next=guide();next.questions.push({category:'technical',question:'Explain NEW_REVISION_TOKEN in your Python project.'});await db.prepare('UPDATE prep_guides SET structured_data=? WHERE application_id=1').bind(JSON.stringify(next)).run();
  expect((await json(`${path}/${original.id}`)).stale).toBe(true);expect(await pdf(original)).toEqual(before);
  const updated=await complete();expect(updated.version).toBe(2);expect(updated.source.guide_revision).toBe(2);expect(readPdf(await pdf(updated)).text).toContain('NEW_REVISION_TOKEN');expect((await json(path)).versions).toHaveLength(2);
 });
 it('uses the refreshed guide generation time in document metadata, HTML and PDF without rewriting older exports',async()=>{
  const created='2026-10-26T17:51:00.000Z',generated='2026-10-26T18:04:00.000Z';
  await db.prepare('UPDATE prep_guides SET created_at=?,structured_data=? WHERE application_id=1').bind(created,JSON.stringify({...guide(),generated_at:created})).run();const original=await complete(),before=await pdf(original);
  await db.prepare('UPDATE prep_guides SET structured_data=? WHERE application_id=1').bind(JSON.stringify({...guide(),generated_at:generated})).run();expect((await db.prepare('SELECT created_at FROM prep_guides WHERE application_id=1').first<any>())!.created_at).toBe(created);
  const ticket=await start(),row=(await db.prepare('SELECT input_snapshot FROM prep_guide_exports WHERE id=?').bind(ticket.id).first<any>())!,snapshot=JSON.parse(row.input_snapshot),document=prepDocument(snapshot,ticket.version,'2026-10-26T18:05:00.000Z');expect(document.generated_at).toBe(generated);expect(document.sections[0].paragraphs[0].text).toContain('Generated '+generated);
  await deliver(ticket.id);const ready=await json(`${path}/${ticket.id}`),html=await(await request(ready.html_url)).text(),bytes=await pdf(ready),reader=readPdf(bytes);expect(html).toContain('Generated '+generated);expect(html).toContain(`Generated ${generated}.</footer>`);expect(reader.text).toContain('Generated '+generated);expect(html).not.toContain('Generated '+created);expect(reader.text).not.toContain('Generated '+created);expect(await pdf(original)).toEqual(before);writeFileSync(`${proofDir}/refreshed-guide.pdf`,bytes,{mode:0o600});
 });
 it.each([{name:'legacy guide',value:undefined},{name:'malformed timestamp',value:'not-a-timestamp'},{name:'impossible ISO calendar date',value:'2026-02-30T18:04:00.000Z'}])('preserves the original creation timestamp for a $name',async({value})=>{
  const created='2026-10-25 09:41:00';await db.prepare('UPDATE prep_guides SET created_at=?,structured_data=? WHERE application_id=1').bind(created,JSON.stringify({...guide(),generated_at:value})).run();const ticket=await start(),row=(await db.prepare('SELECT input_snapshot FROM prep_guide_exports WHERE id=?').bind(ticket.id).first<any>())!,snapshot=JSON.parse(row.input_snapshot);expect(prepDocument(snapshot,ticket.version,'2026-10-26T18:05:00.000Z').generated_at).toBe(created);await deliver(ticket.id);const ready=await json(`${path}/${ticket.id}`),html=await(await request(ready.html_url)).text();expect(html).toContain(`Generated ${created}.</footer>`);expect(readPdf(await pdf(ready)).text).toContain('Generated '+created);
 });
 it('creates a corrected renderer version instead of reusing a historical renderer snapshot',async()=>{
  const ticket=await start(),snapshot=JSON.parse((await db.prepare('SELECT input_snapshot FROM prep_guide_exports WHERE id=?').bind(ticket.id).first<any>())!.input_snapshot);expect(snapshot.renderer_version).toBe(2);await deliver(ticket.id);const original=await json(`${path}/${ticket.id}`),before=await pdf(original);
  const oldHash=createHash('sha256').update(JSON.stringify({...snapshot,renderer_version:1})).digest('hex');await db.prepare('UPDATE prep_guide_exports SET snapshot_hash=? WHERE id=?').bind(oldHash,original.id).run();const replacement=await start();expect(replacement.id).not.toBe(original.id);expect(replacement.version).toBe(2);await deliver(replacement.id);expect((await json(`${path}/${replacement.id}`)).state).toBe('ready');expect(await pdf(original)).toEqual(before);
 });
 it('keeps generation provenance honest when exporting an old guide for a newer profile',async()=>{
  await db.prepare('UPDATE users SET profile_version=2 WHERE id=1').run();const ready=await complete();expect(ready).toMatchObject({state:'ready',stale:true,source:{profile_version:2,guide_profile_version:1}});expect(readPdf(await pdf(ready)).text).toContain('earlier profile version');
 });
 it.each(['profile','guide','job'] as const)('does not publish files after a concurrent %s change at the upload boundary',async kind=>{
  const ticket=await start();let notify!:()=>void,release!:()=>void;gate={entered:new Promise<void>(r=>{notify=r;}),wait:new Promise<void>(r=>{release=r;}),notify:()=>notify(),release:()=>release(),used:false};
  const pending=deliver(ticket.id,true);await gate.entered;
  if(kind==='profile')await db.prepare('UPDATE users SET profile_version=profile_version+1 WHERE id=1').run();else if(kind==='guide')await db.prepare("UPDATE prep_guides SET company_intel='{}' WHERE application_id=1").run();else await db.prepare("UPDATE jobs SET title='Changed role' WHERE id=1").run();
  gate.release();await pending;const failed=await json(`${path}/${ticket.id}`);expect(failed.state).toBe('failed');expect(failed.failure_reason).toContain('changed');expect((await bucket.list()).objects).toHaveLength(0);
 });
 it('denies anonymous/cross-owner list, status and both artifact downloads',async()=>{
  const ready=await complete();const created=await request('/profile','POST',{name:'Other',email:'other-export@example.com',mode:'job',skills:['SQL']},{session:''});expect(created.status).toBe(201);const other=created.headers.get('set-cookie')!.split(';')[0];
  for(const url of [path,`${path}/${ready.id}`,ready.html_url,ready.pdf_url]){expect((await request(url,'GET',undefined,{session:''})).status).toBe(401);expect((await request(url,'GET',undefined,{session:other})).status).toBe(404);}
  expect((await request(path,'POST',{}, {session:other})).status).toBe(404);
 });
 it('expires exports with410, cleans both files and reports deleted files with404',async()=>{
  const ready=await complete();const key=(await db.prepare('SELECT pdf_key FROM prep_guide_exports WHERE id=?').bind(ready.id).first<{pdf_key:string}>())!.pdf_key;await bucket.delete(key);expect((await request(ready.pdf_url)).status).toBe(404);
  await db.prepare("UPDATE prep_guide_exports SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(ready.id).run();expect((await json(`${path}/${ready.id}`)).state).toBe('expired');expect((await request(ready.html_url)).status).toBe(410);
  await json('/__test/queue','POST',{kind:'maintenance'});expect((await bucket.list()).objects).toHaveLength(0);
 });
 it('recovers queue outage without inference and times out abandoned work cleanly',async()=>{
  const ticket=await start({outage:true});expect((await db.prepare('SELECT dispatched_at FROM prep_guide_exports WHERE id=?').bind(ticket.id).first<{dispatched_at:string|null}>())!.dispatched_at).toBeNull();
  await json('/__test/queue','POST',{kind:'maintenance'});expect((await db.prepare('SELECT dispatched_at FROM prep_guide_exports WHERE id=?').bind(ticket.id).first<{dispatched_at:string|null}>())!.dispatched_at).toBeTruthy();
  await db.prepare("UPDATE prep_guide_exports SET work_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(ticket.id).run();await json('/__test/queue','POST',{kind:'maintenance'});expect((await json(`${path}/${ticket.id}`)).state).toBe('failed');await deliver(ticket.id);expect((await bucket.list()).objects).toHaveLength(0);
 });
 it('cleans a partial storage write and never publishes one file from a failed pair',async()=>{
  const ticket=await start();await json('/__test/queue','POST',{kind:'prep_export',export_id:ticket.id},{putFailure:true});const failed=await json(`${path}/${ticket.id}`);expect(failed.state).toBe('failed');expect(JSON.stringify(failed)).not.toContain('private storage upstream marker');expect((await bucket.list()).objects).toHaveLength(0);
 });
 it('rate limits explicit replacement versions while allowing safe reuse of a ready one',async()=>{
  const first=await complete();for(let index=0;index<2;index++){const next=await start({},true);await deliver(next.id);}expect((await request(path,'POST',{regenerate:true})).status).toBe(429);const reuse=await request(path,'POST',{});expect(reuse.status).toBe(200);expect((await reuse.json() as any).version).toBe(3);expect((await request(first.pdf_url)).status).toBe(200);
 });
 it('fails visibly on unsupported content, escapes HTML and never emits unsafe link annotations',async()=>{
  const changed=guide();changed.resources.Python.push({title:'<script>unsafe title</script>',url:'javascript:alert(1)',description:'A rejected link remains plain text.'});await db.prepare('UPDATE prep_guides SET structured_data=? WHERE application_id=1').bind(JSON.stringify(changed)).run();const ready=await complete();expect(readPdf(await pdf(ready)).links.every((url:string)=>/^https?:\/\//.test(url))).toBe(true);const html=await(await request(ready.html_url)).text();expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('href="javascript:');
  changed.questions.push({category:'technical',question:'你好 unsupported PDF font test'});await db.prepare('UPDATE prep_guides SET structured_data=? WHERE application_id=1').bind(JSON.stringify(changed)).run();const ticket=await start();await deliver(ticket.id);expect((await json(`${path}/${ticket.id}`)).state).toBe('failed');expect((await bucket.list()).objects).toHaveLength(2);
 });
 it('exports a long guide without losing its last question or link targets',async()=>{
  const long=guide();long.questions=Array.from({length:24},(_,index)=>({category:'technical',question:`Question ${index}: ${'Explain the Python API design, failures and tradeoffs. '.repeat(12)} ${index===23?'FINAL_GUIDE_FACT':''}`}));await db.prepare('UPDATE prep_guides SET structured_data=? WHERE application_id=1').bind(JSON.stringify(long)).run();const ready=await complete(),bytes=await pdf(ready),reader=readPdf(bytes);writeFileSync(`${proofDir}/long-guide.pdf`,bytes,{mode:0o600});expect(reader.pages).toBeGreaterThanOrEqual(5);expect(reader.text).toContain('FINAL_GUIDE_FACT');expect(reader.links).toContain('https://docs.docker.com/get-started/');
 });
});
