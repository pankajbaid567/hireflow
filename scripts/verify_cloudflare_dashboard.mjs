/**
 * Local browser E2E: real React + Worker routes, isolated D1/R2, no credentials
 * and no employer submissions. All test resources are disposed on exit.
 * Run after npm ci in frontend/ and cloudflare/: node scripts/verify_cloudflare_dashboard.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireCloud = createRequire(new URL('../cloudflare/package.json', import.meta.url));
const { buildSync } = requireCloud('esbuild');
const { Miniflare, convertV4MiniflareOptions } = requireCloud('miniflare');
const { unstable_splitSqlQuery } = requireCloud('wrangler');
const { chromium } = requireCloud('playwright-core');
const dashboard = 'http://127.0.0.1:3101';
const backend = 'http://127.0.0.1:8795';
const code = 'local-browser-qa-owner-code-not-a-production-secret';
const errors = [];
let mf;
let vite;
let browser;

async function ready(url) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (vite?.exitCode !== null && vite?.exitCode !== undefined) throw new Error('Vite exited before becoming ready.');
    try { if ((await fetch(url)).ok) return; } catch { /* Server is starting. */ }
    await pause(200);
  }
  throw new Error(`Server did not start: ${url}`);
}
async function processTask(applicationId, kind) {
  const db=await mf.getD1Database('DB'),row=await db.prepare('SELECT confirmed_review_id FROM applications WHERE id=?').bind(applicationId).first();
  const response = await mf.dispatchFetch(`${backend}/__test/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ application_id: applicationId, kind,...(kind==='apply'?{review_id:row.confirmed_review_id}:{}) }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).acknowledged, true);
}

try {
  const script = buildSync({ entryPoints: [`${root}cloudflare/tests/runtime.ts`], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, port: 8795, host: '127.0.0.1', cf: false, logRequests: false,
    compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['FILES'], queueProducers: { APPLICATION_QUEUE: 'dashboard-qa' },
    bindings: { ACCESS_CODE: code, ALLOWED_ORIGINS: dashboard, PUBLIC_BASE_URL: `${dashboard}/api`, COOKIE_SAME_SITE: 'Lax', BROWSER_ENABLED: 'false', BROWSER_DAILY_BUDGET_SECONDS: '540' },
  }));
  const db = await mf.getD1Database('DB');
  const migrations = `${root}cloudflare/migrations/`;
  for (const file of readdirSync(migrations).filter(file => /^\d+.*\.sql$/.test(file)).sort()) {
    const statements = unstable_splitSqlQuery(readFileSync(`${migrations}${file}`, 'utf8'));
    await db.batch(statements.map(sql => db.prepare(sql)));
  }
  await mf.ready;
  vite = spawn(process.execPath, [`${root}frontend/node_modules/vite/bin/vite.js`, '--host', '127.0.0.1', '--port', '3101', '--strictPort'], {
    cwd: `${root}frontend`, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_DEPLOYMENT_TARGET: 'cloudflare', VITE_API_URL: '/api', API_PROXY_TARGET: backend, WORKSPACE_ACCESS_CODE: code },
  });
  let viteLogs = '';
  vite.stdout.on('data', data => { viteLogs += data.toString(); });
  vite.stderr.on('data', data => { viteLogs += data.toString(); });
  await ready(`${dashboard}/profile`);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${dashboard}/profile`, { waitUntil: 'networkidle' });
  await page.getByLabel('Full name', { exact: true }).fill('Cloud QA Owner');
  await page.getByLabel('Email address', { exact: true }).fill('browser-owner@example.com');
  await page.getByLabel(/^Skills/).fill('Python, LangChain');
  assert.equal(await page.getByLabel(/access code/i).count(), 0);
  assert.equal(await page.getByLabel('Profile ID', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await page.getByText('Profile saved. Your private workspace is ready.').waitFor();
  const session = await (await context.request.get(`${dashboard}/api/session`)).json();
  assert.equal(session.authenticated, true);
  const ownerId = session.user_id;
  const sessionCookie = (await context.cookies()).find(cookie => cookie.name === 'hireflow_session');
  assert.equal(sessionCookie?.httpOnly, true);
  assert.equal(await page.evaluate(() => localStorage.getItem('hireflow.userId')), null);
  await page.getByRole('button', { name: 'Add experience', exact: true }).click();
  await page.getByLabel('Experience 1 role', { exact: true }).fill('Student Developer');
  await page.getByLabel('Experience 1 company', { exact: true }).fill('College Software Club');
  await page.getByLabel('Experience 1 highlights', { exact: true }).fill('Built a Python API\nAdded integration tests');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByLabel('Project 1 name', { exact: true }).fill('Course Archive');
  await page.getByLabel('Project 1 technologies', { exact: true }).fill('Python, SQL');
  await page.getByLabel('Project 1 description', { exact: true }).fill('Built a searchable course archive.');
  await page.getByLabel('Professional summary', { exact: true }).fill('Computer science student building Python APIs.');
  await page.getByRole('button', { name: 'Add link', exact: true }).click();
  await page.getByLabel('Link 1 label', { exact: true }).fill('Portfolio');
  await page.getByLabel('Link 1 URL', { exact: true }).fill('https://portfolio.example.com');
  await page.getByLabel(/^Minimum stipend/).fill('10000');
  await page.getByLabel(/^Excluded companies/).fill('Excluded Example Co');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/profile/${ownerId}`) && response.request().method() === 'PATCH' && response.ok()),
    page.getByRole('button', { name: 'Save profile', exact: true }).click(),
  ]);
  const edited = await (await context.request.get(`${dashboard}/api/profile/${ownerId}`)).json();
  assert.deepEqual(edited.master_profile.experience[0].bullets, ['Built a Python API', 'Added integration tests']);
  assert.deepEqual(edited.master_profile.projects[0].tech, ['Python', 'SQL']);
  assert.equal(edited.master_profile.links[0].url, 'https://portfolio.example.com');
  assert.equal(edited.master_profile.min_stipend, 10000);
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('link', { name: 'Weekly plan', exact: true }).click();
  await page.getByText('Add an opportunity', { exact: true }).click();
  await page.getByLabel('Role title', { exact: true }).fill('AI Engineer Intern');
  await page.getByLabel('Company', { exact: true }).fill('Cloud QA Co');
  await page.getByLabel('Application URL', { exact: true }).fill('https://example.com/careers/local-qa');
  await page.getByLabel('Job description', { exact: true }).fill('AI Engineer Internship. Build RAG applications with Python, LangChain and Docker. Two rounds: technical and HR.');
  await page.getByRole('button', { name: 'Add to opportunities', exact: true }).click();
  await page.getByRole('heading', { name: 'AI Engineer Intern', exact: true }).waitFor();
  await page.getByText('Add an opportunity', { exact: true }).click();
  const previewButton = page.getByRole('button', { name: 'Preview resume', exact: true });
  await previewButton.waitFor();
  const plan = await (await context.request.get(`${dashboard}/api/weekly-plan/${ownerId}`)).json();
  const application = plan.plan[0];
  const pdf = await context.request.get(`${dashboard}/api${application.resume_url}`);
  assert.equal(pdf.status(), 200); assert.equal((await pdf.body()).subarray(0, 5).toString(), '%PDF-');
  await previewButton.click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').locator('iframe').getAttribute('src'), /^\/api\/resumes\//);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/hireflow-cloudflare-desktop.png', fullPage: true, animations: 'disabled' });
  assert.equal(await page.getByRole('button',{name:'Confirm and Apply',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Review AI Engineer Intern',exact:true}).click();
  await page.getByRole('button',{name:'Edit this resume',exact:true}).click();
  await page.getByLabel('Professional summary',{exact:true}).fill('Computer science student who built Python APIs and integration tests.');
  await page.getByRole('button',{name:'Save new PDF version',exact:true}).click();
  await page.getByRole('link',{name:'Open PDF v2',exact:true}).waitFor();
  await page.getByRole('button',{name:'Compare versions',exact:true}).click();
  assert.equal(await page.getByRole('link',{name:'Version 1',exact:true}).count(),1);
  await page.getByRole('button',{name:'PDF and answers',exact:true}).click();
  await page.getByRole('checkbox',{name:/I reviewed PDF v2/}).check();
  await page.getByRole('button',{name:'Approve PDF and answers',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button', { name: 'Confirm and Apply', exact: true }).click();
  await page.getByText(/1 applications confirmed and queued/).waitFor();
  const firstAuthorization=(await db.prepare('SELECT confirmed_review_id FROM applications WHERE id=?').bind(application.application_id).first()).confirmed_review_id;
  await navigation.getByRole('link',{name:'Applications',exact:true}).click();
  await page.getByRole('button',{name:'Cancel queued application',exact:true}).click();
  await page.getByText(/Cancelled before execution/).waitFor();
  await navigation.getByRole('link',{name:'Weekly plan',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Confirm and Apply',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Review AI Engineer Intern',exact:true}).click();
  await page.getByRole('checkbox',{name:/I reviewed PDF v2/}).check();
  await page.getByRole('button',{name:'Approve PDF and answers',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Confirm and Apply',exact:true}).click();
  await page.getByText(/1 applications confirmed and queued/).waitFor();
  const stale=await mf.dispatchFetch(`${backend}/__test/queue`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({application_id:application.application_id,kind:'apply',review_id:firstAuthorization})});
  assert.equal((await stale.json()).acknowledged,true);
  assert.equal((await db.prepare('SELECT status FROM applications WHERE id=?').bind(application.application_id).first()).status,'confirmed');
  await processTask(application.application_id, 'apply');
  await navigation.getByRole('link', { name: 'Applications', exact: true }).click();
  await page.getByText('Browser automation is disabled. Apply manually using the reviewed resume.').waitFor();
  assert.equal(await page.getByRole('link', { name: 'Complete manually' }).getAttribute('href'), 'https://example.com/careers/local-qa');
  await processTask(application.application_id, 'prep');
  await page.getByRole('link', { name: 'Prep guide', exact: true }).click();
  await page.getByRole('heading', { name: 'Your study compass', exact: true }).waitFor();
  await page.locator('.questions summary').first().click();
  assert.equal(await page.locator('.questions details[open]').count(), 1);
  await navigation.getByRole('link', { name: 'Weekly report', exact: true }).click();
  await page.getByRole('button', { name: 'Generate this week', exact: true }).click();
  const reportLink = page.getByRole('link', { name: 'Open weekly report', exact: true });
  await reportLink.waitFor();
  const report = await context.request.get(new URL(await reportLink.getAttribute('href'), dashboard).href);
  assert.equal(report.status(), 200); const reportHtml = await report.text(); assert.match(reportHtml, /Cloud QA Co/);
  writeFileSync('/tmp/hireflow-cloudflare-report.html', reportHtml);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'Open weekly report', exact: true }).waitFor();
  assert.equal((await (await context.request.get(`${dashboard}/api/session`)).json()).authenticated, true);
  await navigation.getByRole('link',{name:'Hiring shortlist',exact:true}).click();
  await page.getByLabel('Role title',{exact:true}).fill('Synthetic AI internship');
  await page.getByLabel('Job description',{exact:true}).fill('AI engineering internship: Python, LangChain and RAG. Build a supervised retrieval project with tests.');
  await page.getByLabel('Shortlist size',{exact:true}).fill('2');
  await page.getByRole('button',{name:'Load synthetic sample',exact:true}).click();
  const creation=page.waitForResponse(response=>response.url().endsWith('/api/hiring/shortlist')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Create shortlist',exact:true}).click();
  const hiring=await(await creation).json();assert.equal(hiring.state,'completed');assert.equal(hiring.shortlisted_count,2);assert.equal(hiring.applicant_count,3);
  // Exercise the actual queue dispatcher as well as the synchronous local UI
  // fixture: seed the already-validated snapshot, then run its private task.
  const queued=await db.prepare("INSERT INTO shortlists(user_id,jd_text,candidates,applicant_count,state,input_snapshot) SELECT user_id,jd_text,'[]',applicant_count,'queued',input_snapshot FROM shortlists WHERE id=? RETURNING id").bind(hiring.id).first();
  const executed=await mf.dispatchFetch(`${backend}/__test/queue`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'hiring_score',shortlist_id:queued.id})});assert.equal(executed.status,200);assert.equal((await executed.json()).acknowledged,true);assert.equal((await db.prepare('SELECT state FROM shortlists WHERE id=?').bind(queued.id).first()).state,'completed');
  await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:new RegExp('^Report '+queued.id+' ·')}).click();
  await page.getByRole('heading',{name:'Your hiring report',exact:true}).waitFor();
  const hiringLink=page.getByRole('link',{name:'Open private HTML report',exact:true});await hiringLink.waitFor();
  const hiringUrl=new URL(await hiringLink.getAttribute('href'),dashboard).href,hiringDownload=await context.request.get(hiringUrl);assert.equal(hiringDownload.status(),200);const hiringHtml=await hiringDownload.text();assert.ok(hiringHtml.includes('applicants[0].skills[0]'));assert.ok(hiringHtml.includes('Human')||hiringHtml.includes('human'));assert.ok(hiringDownload.headers()['cache-control'].includes('no-store'));
  assert.equal(await page.getByRole('button',{name:'Send reviewed hiring report',exact:true}).isDisabled(),true);assert.equal((await db.prepare('SELECT count(*) AS n FROM hiring_email_deliveries').first()).n,0);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'/tmp/hireflow-cloudflare-hiring-mobile.png',fullPage:true,animations:'disabled'});await page.setViewportSize({width:1440,height:1000});
  await page.goto(`${dashboard}/profile`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/hireflow-cloudflare-mobile.png', fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const bounds = await page.locator('.sidebar').boundingBox(); assert.ok(bounds.x + bounds.width <= 0.5);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).first().click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByText('You have signed out. This browser no longer has access to that profile.', { exact: true }).waitFor();
  assert.equal((await context.request.get(`${dashboard}/api/profile/${ownerId}`)).status(), 401);
  assert.equal((await context.request.get(`${dashboard}/api${application.resume_url}`)).status(), 401);
  assert.equal((await context.request.get(hiringUrl)).status(),401);
  assert.equal((await (await context.request.get(`${dashboard}/api/session`)).json()).authenticated, false);
  assert.deepEqual(errors, []);
  const proof = { status: 'passed', checkedAt: new Date().toISOString(), checks: ['private profile/session', 'structured experience/project editor', 'summary/links/compensation/preferences persisted', 'manual job import', 'ranked plan and actual PDF preview', 'immutable per-opportunity resume edit and PDF v2', 'version comparison and exact PDF/answer approval', 'queued cancellation and stale delivery rejection', 'confirmation queue', 'needs_action tracker', 'prep guide', 'private HTML report', 'session reload', 'hiring JSON intake and source evidence', 'actual hiring Queue dispatcher and private HTML', 'hiring mobile and missing Gmail setup', 'expanded profile mobile navigation and overflow', 'logout revokes private downloads'], pageErrors: errors, reportHtml: '/tmp/hireflow-cloudflare-report.html', screenshots: ['/tmp/hireflow-cloudflare-desktop.png', '/tmp/hireflow-cloudflare-mobile.png'] };
  writeFileSync('/tmp/hireflow-cloudflare-e2e-proof.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally {
  await browser?.close();
  if (vite) { vite.kill('SIGTERM'); await Promise.race([new Promise(resolve => vite.once('exit', resolve)), pause(3000)]); }
  await mf?.dispose();
}
