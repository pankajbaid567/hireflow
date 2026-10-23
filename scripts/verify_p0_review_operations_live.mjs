/** Explicit production P0 proof: one synthetic manual profile, one controlled
 * HireFlow QA opportunity, reviewed drafts and operations only. Never confirms
 * an application, sends email, searches employers or uploads a real resume.
 * Node22+: node scripts/verify_p0_review_operations_live.mjs --run-live
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash,randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync,chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
assert.ok(process.argv.includes('--run-live'),'Use --run-live for this explicitly gated synthetic production check.');
const site=(process.env.HIREFLOW_SITE || 'https://hireflow-dashboard.pages.dev').replace(/\/$/,''),origin=new URL(site);
assert.equal(origin.protocol,'https:');assert.equal(origin.origin,site);assert.ok(!origin.username&&!origin.password);
const runId=randomUUID().replaceAll('-','').slice(0,12),email=`p0-review-qa-${runId}@example.com`,dir=`/tmp/hireflow-p0-review-operations-live/${runId}`;
mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
const proof={status:'pending',run_id:runId,site,started_at:new Date().toISOString(),stage:'starting',scope:'one-synthetic-manual-profile-controlled-QA-review-only',user_id:null,job_id:null,application_id:null,fake_email:email,object_keys:[],versions:[],employer_submissions:0,queue_confirmations:0,email_sends:0,diagnostic_requests:0,blocked_requests:0,runtime_errors:0,request_statuses:[],synthetic_records_retained:true};
const save=stage=>{proof.stage=stage;writeFileSync(`${dir}/proof.json`,JSON.stringify(proof,null,2),{mode:0o600});};
const require=createRequire(new URL('../cloudflare/package.json',import.meta.url)),{chromium}=require('playwright-core');
let browser,context,page;
const ownPath=value=>{const path=value.split('?')[0];return /^\/api\/(?:session|session\/logout|profile|account\/security)$/.test(path)||!proof.user_id&&proof.stage==='signup'&&/^\/api\/operations\/\d+$/.test(path)||proof.user_id&&new RegExp(`^/api/(?:profile/${proof.user_id}|operations/${proof.user_id}(?:/diagnostics)?|jobs/${proof.user_id}|weekly-plan/${proof.user_id}|resumes/${proof.user_id}(?:/${proof.application_id}/download)?|applications/${proof.application_id}/(?:review|resume-draft|resume-reject|resume-regenerate)|applications/${proof.user_id})$`).test(path);};
async function api(path,method='GET',data){
  assert.ok(ownPath(`/api${path}`),'Request outside the synthetic owner scope');
  assert.ok(!/confirm|cancel|email|discover/.test(path),'This proof never queues or submits applications.');
  const response=await context.request.fetch(`${site}/api${path}`,{method,headers:{Origin:site},...(data===undefined?{}:{data}),timeout:60000});
  proof.request_statuses.push({path,method,status:response.status()});return response;
}
async function json(path,method='GET',data,expected=200){const response=await api(path,method,data);assert.equal(response.status(),expected,`${method} ${path} returned ${response.status()}`);return response.json();}
async function readyPlan(){for(let attempt=0;attempt<30;attempt++){const value=await json(`/weekly-plan/${proof.user_id}`);const found=value.plan?.find(job=>proof.job_id?job.job_id===proof.job_id:job.company_name==='HireFlow Controlled QA'&&job.role_title==='Python QA Intern');if(found?.resume_url&&!value.preparing)return found;await pause(2000);}throw new Error('Synthetic resume preparation did not finish');}
async function newPage(){const value=await context.newPage();value.on('pageerror',()=>{proof.runtime_errors++;});value.on('response',response=>{const url=new URL(response.url());if(url.origin===site&&url.pathname.startsWith('/api/'))proof.request_statuses.push({path:url.pathname,method:response.request().method(),status:response.status()});});return value;}
async function openReview(){await page.getByRole('button',{name:'Review Python QA Intern',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Review HireFlow Controlled QA'});await dialog.getByRole('button',{name:'PDF and answers',exact:true}).waitFor();return dialog;}
async function approve(dialog,answer){await dialog.getByLabel('Answer 1',{exact:true}).fill(answer);await dialog.getByRole('checkbox',{name:/I reviewed PDF v/}).check();await dialog.getByRole('button',{name:'Approve PDF and answers',exact:true}).click();await dialog.waitFor({state:'hidden'});}
async function pdf(version){
  for(let attempt=0;attempt<12;attempt++){const response=await api(`/resumes/${proof.user_id}/${proof.application_id}/download?version=${version}`);if(response.status()===200){const body=await response.body();assert.ok(body.subarray(0,5).toString()==='%PDF-');return body;}assert.ok([404,409,503].includes(response.status()));await pause(2000);}throw new Error('Synthetic immutable PDF is unavailable');
}
async function inventory(){
  if(!proof.user_id)return;
  const cwd=fileURLToPath(new URL('../cloudflare/',import.meta.url)),cli=fileURLToPath(new URL('../cloudflare/node_modules/wrangler/bin/wrangler.js',import.meta.url));
  const query=`SELECT r.version,r.object_key,a.id AS application_id,a.job_id FROM resumes r JOIN applications a ON a.id=r.application_id JOIN users u ON u.id=a.user_id WHERE u.id=${proof.user_id} AND u.email='${email}' ORDER BY r.version`;
  try{const child=spawnSync(process.execPath,[cli,'d1','execute','DB','--remote','--json','--command',query],{cwd,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});const result=JSON.parse(child.stdout);const rows=result.flatMap(item=>item.results||[]);proof.object_keys=rows.map(row=>row.object_key);proof.versions=rows.map(({version,application_id,job_id})=>({version,application_id,job_id}));proof.inventory_state='recorded';}catch{proof.inventory_state='unavailable; use the synthetic owner/application IDs to query cleanup inventory';}
}
try{
  save('launching');browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==site||url.pathname.startsWith('/api/')&&(!ownPath(url.pathname)||/\/confirm|\/cancel|\/email|\/discover/.test(url.pathname))){proof.blocked_requests++;await route.abort();return;}if(url.pathname.endsWith('/diagnostics')&&request.method()==='POST'){proof.diagnostic_requests++;assert.equal(proof.diagnostic_requests,1,'Diagnostics may only be requested once.');}await route.continue();});
  page=await newPage();assert.equal((await json('/session')).authenticated,false);
  await page.goto(`${site}/profile`,{waitUntil:'domcontentloaded',timeout:60000});
  assert.equal(await page.getByLabel(/access code/i).count(),0);await page.getByLabel('Full name',{exact:true}).fill('P0 Review Synthetic QA');await page.getByLabel('Email address',{exact:true}).fill(email);await page.getByLabel('Phone number',{exact:true}).fill('9999999999');await page.getByLabel(/^Skills/).fill('Python, SQL');await page.getByLabel(/^Applications per week/).fill('1');
  await page.getByText('Resume details',{exact:true}).click();await page.getByLabel('Professional summary',{exact:true}).fill('Built a Python notes project for a synthetic deployment check.');await page.getByRole('button',{name:'Add project',exact:true}).click();await page.getByLabel('Project 1 name',{exact:true}).fill('Safe QA Notes');await page.getByLabel('Project 1 description',{exact:true}).fill('Built Python note lookup for this controlled verification fixture.');await page.getByLabel('Project 1 technologies',{exact:true}).fill('Python, SQL');
  save('signup');const signupWait=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/profile'&&response.request().method()==='POST');await page.getByRole('button',{name:'Save profile',exact:true}).click();const signup=await signupWait;assert.equal(signup.status(),201,'Synthetic signup was limited or failed; do not bypass the limit.');const owner=await signup.json();assert.ok(Number.isSafeInteger(owner.id));proof.user_id=owner.id;const master=JSON.stringify(owner.master_profile);save('adding_controlled_opportunity');
  const fixture=`${site}/assets/hireflow-qa-form?run=${runId}`;const check=await context.request.get(fixture);assert.equal(check.status(),200);assert.ok((await check.text()).includes('HireFlow deployment QA form'));
  await page.goto(`${site}/weekly-plan`,{waitUntil:'domcontentloaded'});await page.getByText('Add an opportunity',{selector:'summary'}).click();await page.getByLabel('Role title',{exact:true}).fill('Python QA Intern');await page.getByLabel('Company',{exact:true}).fill('HireFlow Controlled QA');await page.getByLabel('Application URL',{exact:true}).fill(fixture);await page.getByLabel('Job description',{exact:true}).fill('Controlled HireFlow deployment fixture only. Practice Python SQL note lookup and factual documentation. This is not an employer vacancy.');await page.getByRole('button',{name:'Add to opportunities',exact:true}).click();
  const first=await readyPlan();proof.job_id=first.job_id;proof.application_id=first.application_id;assert.equal(first.resume_version,1);save('reviewing_v1');
  const originalPdf=await pdf(1),originalHash=createHash('sha256').update(originalPdf).digest('hex');
  await page.getByRole('button',{name:'Review Python QA Intern',exact:true}).waitFor({state:'visible'});assert.equal(await page.getByRole('button',{name:'Confirm and Apply',exact:true}).isDisabled(),true);
  await approve(await openReview(),'I built the Safe QA Notes Python project and reviewed this controlled opportunity.');
  const approvedFirst=await readyPlan();assert.ok(approvedFirst.review_id);proof.initial_review_approved=true;save('editing_immutable_v2');
  let dialog=await openReview();await dialog.getByRole('button',{name:'Edit this resume',exact:true}).click();
  const editedSummary='Built a Python notes project for a synthetic deployment check. Reviewed wording for the controlled QA opportunity.';
  await dialog.getByLabel('Professional summary',{exact:true}).fill(editedSummary);await dialog.getByRole('button',{name:'Save new PDF version',exact:true}).click();
  await dialog.getByRole('link',{name:'Open PDF v2',exact:true}).waitFor({timeout:30000});
  const edited=await json(`/applications/${proof.application_id}/resume-draft`);assert.equal(edited.resume_version,2);assert.equal(edited.draft.summary,editedSummary);assert.equal(JSON.stringify((await json(`/profile/${proof.user_id}`)).master_profile),master);
  const secondPdf=await pdf(2),secondHash=createHash('sha256').update(secondPdf).digest('hex');assert.notEqual(secondHash,originalHash);assert.equal(createHash('sha256').update(await pdf(1)).digest('hex'),originalHash);
  assert.equal((await readyPlan()).review_id,null);proof.edit_v2_immutable=true;proof.master_profile_unchanged=true;
  await dialog.getByRole('button',{name:'Compare versions',exact:true}).click();assert.ok((await dialog.locator('.resume-comparison section').last().innerText()).includes(editedSummary));assert.ok(!(await dialog.locator('.resume-comparison section').first().innerText()).includes('Reviewed wording for the controlled QA opportunity.'));
  await dialog.getByRole('link',{name:'Version 1',exact:true}).waitFor();await dialog.getByRole('link',{name:'Version 2',exact:true}).waitFor();proof.comparison_ui=true;await page.screenshot({path:`${dir}/comparison-desktop.png`,fullPage:true,animations:'disabled'});save('rejecting_v2');
  const rejectWait=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/applications/${proof.application_id}/resume-reject`);await dialog.getByRole('button',{name:'Reject this PDF',exact:true}).click();assert.equal((await rejectWait).status(),200);await dialog.getByText('This resume is rejected. Edit it or request a new draft before approval.',{exact:true}).waitFor();
  const denied=await api(`/applications/${proof.application_id}/review`,'POST',{resume_version:2,profile_version:edited.profile_version,reviewed:true,answers:{}});assert.equal(denied.status(),409);proof.rejected_version_approval_denied=true;save('regenerating_v3');
  const regenWait=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/applications/${proof.application_id}/resume-regenerate`);await dialog.getByRole('button',{name:'Request a new draft',exact:true}).click();assert.equal((await regenWait).status(),200);await dialog.waitFor({state:'hidden'});
  const third=await readyPlan();assert.equal(third.resume_version,3);assert.equal(third.review_id,null);proof.ui_regeneration_requires_review=true;
  // Close the UI poller while testing the request allowance, so it cannot race
  // generation between these two explicit invalidations. No response is mocked.
  await page.close();save('checking_regeneration_allowance');
  await json(`/applications/${proof.application_id}/resume-regenerate`,'POST',{resume_version:3});await json(`/applications/${proof.application_id}/resume-regenerate`,'POST',{resume_version:3});
  const limited=await api(`/applications/${proof.application_id}/resume-regenerate`,'POST',{resume_version:3});assert.equal(limited.status(),429);proof.regeneration_limit={accepted_requests:3,next_status:429,window_minutes:10};
  const finalDraft=await readyPlan();assert.equal(finalDraft.resume_version,4);assert.equal(finalDraft.review_id,null);
  page=await newPage();await page.goto(`${site}/weekly-plan`,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Review Python QA Intern',exact:true}).waitFor();dialog=await openReview();await dialog.getByRole('link',{name:'Open PDF v4',exact:true}).waitFor();
  const reviewedAnswer='I reviewed Safe QA Notes and its Python SQL lookup for this controlled deployment test.';await approve(dialog,reviewedAnswer);
  const approvedFinal=await readyPlan();assert.ok(approvedFinal.review_id);assert.notEqual(approvedFinal.review_id,approvedFirst.review_id);const finalReview=await json(`/applications/${proof.application_id}/review`);assert.equal(finalReview.questions[0].answer,reviewedAnswer);proof.answer_editing_and_reapproval=true;proof.current_version=4;
  assert.equal(JSON.stringify((await json(`/profile/${proof.user_id}`)).master_profile),master);assert.equal(createHash('sha256').update(await pdf(1)).digest('hex'),originalHash);
  save('checking_operations_and_models');const beforeOps=await json(`/operations/${proof.user_id}`);assert.ok(beforeOps.capacity.submission_delay_seconds>=21);assert.ok(beforeOps.capacity.remaining_application_slots>=0);assert.equal(beforeOps.telemetry.cpu_time_ms,null);assert.equal(beforeOps.telemetry.memory_bytes,null);proof.capacity={submission_delay_seconds:beforeOps.capacity.submission_delay_seconds,remaining_application_slots:beforeOps.capacity.remaining_application_slots,queued_applications:beforeOps.capacity.queued_applications};
  await page.locator('.operations-status > summary').click();const checkModels=page.getByRole('button',{name:'Check configured models',exact:true});await checkModels.waitFor();await checkModels.waitFor({state:'visible'});for(let n=0;await checkModels.isDisabled()&&n<30;n++)await pause(250);
  const diagnosticsWait=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/operations/${proof.user_id}/diagnostics`,{timeout:20000});await checkModels.click();const diagnosticsResponse=await diagnosticsWait;assert.equal(diagnosticsResponse.status(),200);const diagnostics=await diagnosticsResponse.json();const configured=new Set(beforeOps.providers.filter(provider=>provider.configured).map(provider=>`${provider.provider}:${provider.model}`));assert.ok(diagnostics.checks.length<=3);assert.ok(diagnostics.checks.every(check=>configured.has(`${check.provider}:${check.model}`)));proof.diagnostics_checks=diagnostics.checks.map(check=>({provider:check.provider,model:check.model,state:check.state,...(check.failure?{failure_kind:check.failure.kind}:{})}));
  await page.getByText('Diagnostics use a small synthetic prompt, never your resume or profile. Results describe these checks, not a guarantee of availability.',{exact:true}).waitFor();assert.equal(proof.diagnostic_requests,1);proof.operations_ui=true;
  await page.screenshot({path:`${dir}/operations-desktop.png`,fullPage:true,animations:'disabled'});await page.setViewportSize({width:390,height:844});await pause(300);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${dir}/operations-mobile.png`,fullPage:true,animations:'disabled'});proof.mobile_no_overflow=true;
  const apps=await json(`/applications/${proof.user_id}`);assert.equal(apps.items.find(app=>app.id===proof.application_id)?.status,'planned');assert.equal(proof.blocked_requests,0);assert.equal(proof.runtime_errors,0);proof.final_status='planned_not_queued';proof.status='passed';proof.finished_at=new Date().toISOString();save('complete');
}catch(error){proof.status='failed';proof.error_type=error?.name||'UnknownError';save(proof.stage);process.exitCode=1;}
finally{
  await inventory();
  if(context&&proof.user_id)try{const response=await context.request.post(`${site}/api/session/logout`,{headers:{Origin:site},data:{}});proof.session_revoked=response.status()===200;}catch{proof.session_revoked=false;}
  save(proof.stage);await browser?.close();console.log(JSON.stringify({status:proof.status,stage:proof.stage,user_id:proof.user_id,job_id:proof.job_id,application_id:proof.application_id,proof:`${dir}/proof.json`,object_keys:proof.object_keys}));
}
