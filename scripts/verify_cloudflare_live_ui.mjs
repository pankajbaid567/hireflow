/**
 * Explicit live UI verification using synthetic data and HireFlow's own fixture.
 * Run: npm exec --prefix cloudflare --package=node@22 -- node scripts/verify_cloudflare_live_ui.mjs --run-live
 * The Pages flow uses the public React UI. Retired-site migration fixtures use
 * the legacy profile/logout API only for synthetic setup/cleanup.
 * No owner credentials, cookies, traces, HAR files, emails or employer submissions
 * are printed or persisted. Synthetic records remain for scoped owner cleanup.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

assert.ok(process.argv.includes('--run-live'), 'Pass --run-live to enable controlled synthetic production UI verification.');
const root = fileURLToPath(new URL('../', import.meta.url));
const requireCloud = createRequire(new URL('../cloudflare/package.json', import.meta.url));
const { chromium } = requireCloud('playwright-core');
const site = (process.env.HIREFLOW_SITE || process.env.HIRELOW_SITE || 'https://hireflow-dashboard.pages.dev').replace(/\/$/, '');
const previousSite = (process.env.HIREFLOW_PREVIOUS_SITE || 'https://hireflow-blue-seven.vercel.app').replace(/\/$/, '');
const fixture = `${site}/assets/hireflow-qa-form.html`;
const proofRoot = '/tmp/hireflow-live-ui-proof';
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const transferOnly = process.argv.includes('--transfer-only');
const output = `${proofRoot}/${runId}`;
const email = `full-ui-qa-${runId}@example.com`;
const primaryCompany = `UI QA Primary ${runId}`;
const finalCompany = `UI QA Alternate ${runId}`;
const role = 'Python LangChain AI Engineer Intern';
const python = `${root}venv/bin/python`;
const inputPdf = `${output}/uploaded-resume.pdf`;
const tailoredPdf = `${output}/tailored-resume.pdf`;
const proofFile = `${output}/proof.json`;
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(proofRoot, 0o700);
chmodSync(output, 0o700);
const proof = {
  status: 'failed', startedAt: new Date().toISOString(), site, runId,
  scope: transferOnly ? 'session-transfer-only' : 'production-ui-and-session-transfer',
  syntheticRecordsRetained: true, emailsSent: 0, screenshots: [],
  pageErrors: [], requestFailures: [], httpResponses: [],
};
let browser, context, page;
const pendingResponses = new Set();

function safeMessage(error) {
  return String(error?.message || error)
    .replace(/(?:gsk_|AIza|github_pat_|ghp_)[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .replace(/([#?&]transfer=)[a-f0-9]{64}/gi, '$1[redacted]')
    .replace(/hireflow_session=[a-f0-9]{64}/gi, 'hireflow_session=[redacted]');
}
function writeProof() {
  for (const path of [proofFile, `${proofRoot}/proof.json`]) {
    writeFileSync(path, JSON.stringify(proof, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}
function phase(stage) {
  proof.stage = stage;
  writeProof();
  console.log(JSON.stringify({ stage, runId }));
}
async function shot(name, tab = page) {
  const path = `${output}/${name}.png`;
  await tab.evaluate(() => window.scrollTo(0, 0));
  await pause(150);
  await tab.screenshot({ path, fullPage: true, animations: 'disabled' });
  chmodSync(path, 0o600);
  proof.screenshots.push(path);
}
async function until(operation, label, timeout = 180000, delay = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await pause(delay);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function jsonGet(path, expected = 200) {
  assert.ok(path.startsWith('/api/'), 'Read-only API checks must stay on the production API.');
  const response = await context.request.get(`${site}${path}`, { timeout: 65000 });
  assert.equal(response.status(), expected, `GET ${path}`);
  return response.json();
}
async function readPdf(path) {
  assert.ok(path.startsWith('/api/resumes/'), 'Only private resume downloads are inspected.');
  let response;
  await until(async () => {
    response = await context.request.get(`${site}${path}`, { timeout: 30000 });
    if (response.status() === 404) return false; // KV visibility grace period.
    assert.equal(response.status(), 200, 'Private resume download failed');
    return true;
  }, 'private PDF visibility', 130000, 4000);
  const bytes = await response.body();
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(response.headers()['content-type'], /^application\/pdf/);
  assert.match(response.headers()['cache-control'], /no-store/);
  return bytes;
}
function pdfText(path) {
  return execFileSync(python, ['-c', 'from pypdf import PdfReader; import sys; print("\\n".join(p.extract_text() or "" for p in PdfReader(sys.argv[1]).pages))', path], { encoding: 'utf8' });
}
async function navigation(label) {
  if (await page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  }
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: label, exact: true }).click();
}
async function addOpportunity(company, suffix) {
  const detail = page.locator('.opportunity-discovery details');
  if (!await detail.evaluate(el => el.open)) await detail.locator('summary').click();
  await page.getByLabel('Role title', { exact: true }).fill(role);
  await page.getByLabel('Company', { exact: true }).fill(company);
  await page.getByLabel('Application URL', { exact: true }).fill(`${fixture}?qa=ui-${runId}-${suffix}`);
  await page.getByLabel('Location', { exact: true }).fill('Remote');
  await page.getByLabel('Job description', { exact: true }).fill('Synthetic deployment QA only, not a real vacancy. Build an assistant using Python and LangChain. Learn Docker and RAG. 2 interview rounds: technical and HR.');
  const saved = page.waitForResponse(r => r.url() === `${site}/api/jobs/${proof.userId}` && r.request().method() === 'POST', { timeout: 65000 });
  await page.getByRole('button', { name: 'Add to opportunities', exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  assert.equal((await response.json()).imported, 1);
  await page.getByText('Opportunity added. Refresh your plan.', { exact: true }).waitFor();
}

async function verifyWorkspaceTransfer() {
  phase('old_website_to_pages_one_time_workspace_transfer');
  assert.notEqual(site, previousSite, 'Session transfer must cross the old and new website origins.');
  const transferContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const transferPage = await transferContext.newPage();
  transferPage.on('pageerror', error => proof.pageErrors.push(safeMessage(error)));
  try {
    // The old SPA is intentionally retired. Set up only the synthetic legacy
    // owner fixture through its still-private API; no technical credential is
    // supplied or read, and the cookie remains in this isolated browser.
    const created = await transferContext.request.post(`${previousSite}/api/profile`, {
      headers: { Origin: previousSite }, timeout: 65000,
      data: { name: 'Workspace Transfer QA', email: `transfer-qa-${runId}@example.com`, phone: '9999999999', skills: ['Python'], mode: 'internship', weekly_quota: 1, experience_years: 0 },
    });
    assert.equal(created.status(), 201, 'Synthetic old-site workspace creation failed');
    const owner = await created.json();
    proof.transfer = { userId: owner.id, previousSite, site, setup: 'Synthetic legacy API fixture; retired site has no profile UI.' };

    // The same browser retains its old-origin cookie. Pages must initially be
    // anonymous and link to the authenticated old-origin bridge.
    await transferPage.goto(`${site}/profile`, { waitUntil: 'networkidle' });
    const bridgeLink = transferPage.getByRole('link', { name: /Continue an existing workspace/ });
    await bridgeLink.waitFor();
    await shot('15-pages-existing-workspace-entrypoint', transferPage);
    assert.equal((await (await transferContext.request.get(`${site}/api/session`)).json()).authenticated, false);
    assert.equal(await bridgeLink.getAttribute('href'), `${previousSite}/api/workspace-migrate`);
    const bridgeResponse = transferPage.waitForResponse(r => r.url() === `${previousSite}/api/workspace-migrate`, { timeout: 65000 });
    const consumedResponse = transferPage.waitForResponse(r => r.url() === `${site}/api/session/transfer/consume` && r.request().method() === 'POST', { timeout: 65000 });
    await bridgeLink.click();
    const bridge = await bridgeResponse;
    assert.equal(bridge.status(), 303);
    // Retain the bearer token in memory only for the replay check. Never put
    // this URL, response header, cookie or token into proof output or logs.
    const transferUrl = new URL(await bridge.headerValue('location'));
    assert.equal(transferUrl.origin, site);
    const token = new URLSearchParams(transferUrl.hash.slice(1)).get('transfer');
    assert.ok(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'Migration bridge returned an invalid transfer token.');
    assert.equal((await consumedResponse).status(), 200);
    await transferPage.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    await until(async () => await transferPage.getByLabel('Full name', { exact: true }).inputValue() === owner.name, 'transferred owner profile');
    assert.equal(await transferPage.getByLabel('Email address', { exact: true }).inputValue(), owner.email);
    assert.equal(new URL(transferPage.url()).hash, '', 'Transfer token was not removed from browser history.');
    const session = await (await transferContext.request.get(`${site}/api/session`)).json();
    assert.equal(session.user_id, owner.id);
    const newCookie = (await transferContext.cookies(site)).find(cookie => cookie.name === 'hireflow_session');
    assert.ok(newCookie?.httpOnly && newCookie?.secure && newCookie?.sameSite === 'Lax');
    assert.equal(await transferPage.evaluate(() => localStorage.getItem('hireflow.userId')), null);
    await shot('16-pages-transferred-workspace', transferPage);
    proof.transfer.sameOwner = true;
    proof.transfer.fragmentRemoved = true;
    proof.transfer.privateNewOriginCookie = true;

    const replayContext = await browser.newContext();
    try {
      const replayPage = await replayContext.newPage();
      replayPage.on('pageerror', error => proof.pageErrors.push(safeMessage(error)));
      const rejected = replayPage.waitForResponse(r => r.url() === `${site}/api/session/transfer/consume` && r.request().method() === 'POST');
      await replayPage.goto(`${site}/profile#transfer=${token}`, { waitUntil: 'networkidle' });
      assert.equal((await rejected).status(), 401, 'A used transfer token was accepted again.');
      await replayPage.getByRole('alert').filter({ hasText: /expired or already been used/i }).waitFor();
      assert.equal((await (await replayContext.request.get(`${site}/api/session`)).json()).authenticated, false);
      assert.equal(new URL(replayPage.url()).hash, '');
      proof.transfer.replayRejected = true;
      await shot('17-transfer-replay-rejected', replayPage);
    } finally { await replayContext.close(); }

    await transferPage.getByRole('button', { name: 'Sign out', exact: true }).click();
    await transferPage.getByText(/^You have signed out\./).waitFor();
    assert.equal((await transferContext.request.get(`${site}/api/profile/${owner.id}`)).status(), 401);
    // Retired-origin cleanup uses its private logout endpoint, not a removed
    // SPA. New-origin sign-out above is exercised through the actual UI.
    assert.equal((await transferContext.request.post(`${previousSite}/api/session/logout`, { headers: { Origin: previousSite }, data: {}, timeout: 65000 })).status(), 200);
    assert.equal((await transferContext.request.get(`${previousSite}/api/profile/${owner.id}`, { timeout: 65000 })).status(), 401);
    proof.transfer.bothOriginLogoutsVerified = true;
  } finally { await transferContext.close(); }
}

try {
  phase('create_valid_synthetic_resume');
  execFileSync(python, ['-c', `
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
import sys
c=canvas.Canvas(sys.argv[1],pagesize=A4)
c.setTitle('Full UI QA - synthetic resume')
c.setFont('Helvetica-Bold',18); c.drawString(45,795,'Full UI QA')
c.setFont('Helvetica',11)
lines=[sys.argv[2], 'Phone: 9999999999', '', 'SKILLS', 'Python, LangChain', '', 'EDUCATION', 'B.Tech Computer Science, Example University, 2026', '', 'PROJECTS', 'Orbit Note Assistant', 'Built a Python and LangChain study assistant that summarizes five notes.', '', 'EXPERIENCE', 'Student project work only. Zero years of professional experience.', '', 'PREFERENCES', 'AI Engineer internship, Remote. Synthetic test profile only.']
for i,line in enumerate(lines):c.drawString(45,770-i*20,line)
c.save()
`, inputPdf, email]);
  chmodSync(inputPdf, 0o600);
  assert.match(pdfText(inputPdf), /Orbit Note Assistant/);
  execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-r', '110', '-png', '-singlefile', inputPdf, `${output}/uploaded-resume-render`]);
  chmodSync(`${output}/uploaded-resume-render.png`, 0o600);

  // The lightweight headless shell cannot render/navigate native PDFs. Use the
  // full browser so preview and download checks exercise the actual viewer.
  browser = await chromium.launch({ channel: 'chromium', headless: false });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  context.setDefaultTimeout(20000);
  context.on('page', tab => {
    tab.on('pageerror', error => proof.pageErrors.push(safeMessage(error)));
  });
  context.on('requestfailed', request => proof.requestFailures.push({ path: new URL(request.url()).pathname, resourceType: request.resourceType(), error: safeMessage(request.failure()?.errorText || 'request failed') }));
  context.on('response', response => {
    if (!response.url().startsWith(`${site}/api/`)) return;
    const record = (async () => {
      const entry = { method: response.request().method(), path: new URL(response.url()).pathname, status: response.status(), cfRay: await response.headerValue('cf-ray') };
      if (entry.status >= 500) entry.cpuLimitExceeded = /\b1102\b|exceeded resource limits/i.test(await response.text().catch(() => ''));
      proof.httpResponses.push(entry);
    })();
    pendingResponses.add(record);
    record.catch(() => {}).finally(() => pendingResponses.delete(record));
  });
  page = await context.newPage();
  if (!transferOnly) {
  phase('public_website_preflight');
  const fixtureResponse = await context.request.get(fixture);
  assert.equal(fixtureResponse.status(), 200);
  assert.match(await fixtureResponse.text(), /HireFlow deployment QA form/);
  assert.equal((await jsonGet('/api/health')).runtime, 'cloudflare-workers');
  await page.goto(`${site}/profile`, { waitUntil: 'networkidle' });
  await page.getByLabel('Resume PDF', { exact: true }).waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0, 'Normal profile creation must not require an owner access code');
  assert.equal(await page.getByLabel('Profile ID', { exact: true }).count(), 0, 'Cloud profiles must not use ID-only authentication');
  proof.noOwnerAccessField = true;
  await shot('01-profile-before-upload');

  phase('resume_upload_and_profile_save_via_ui');
  assert.equal(await page.getByLabel('Full name', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('Email address', { exact: true }).inputValue(), '');
  await page.getByRole('radio', { name: /Internship/ }).click();
  await page.getByLabel(/^Applications per week/).fill('1');
  await page.getByLabel('Resume PDF', { exact: true }).setInputFiles(inputPdf);
  const profileResponse = page.waitForResponse(r => r.url() === `${site}/api/profile` && r.request().method() === 'POST', { timeout: 75000 });
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  const saved = await profileResponse;
  assert.equal(saved.status(), 201, 'Profile resume upload did not succeed');
  const profile = await saved.json();
  proof.userId = profile.id;
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor({ timeout: 70000 });
  await until(async () => await page.getByLabel('Full name', { exact: true }).inputValue() === 'Full UI QA', 'extracted name in the profile UI');
  assert.equal(await page.getByLabel('Email address', { exact: true }).inputValue(), email);
  assert.equal((await page.getByLabel('Phone number', { exact: true }).inputValue()).replace(/\D/g, ''), '9999999999');
  assert.match(await page.getByLabel(/^Skills/).inputValue(), /Python/);
  assert.match(await page.getByLabel(/^Skills/).inputValue(), /LangChain/);
  assert.match(await page.getByLabel('Education', { exact: true }).inputValue(), /Example University/);
  proof.resumeOnlyProfileCreation = true;
  const projectFacts = JSON.stringify(profile.master_profile?.projects || []);
  assert.match(projectFacts, /Orbit Note Assistant/i, 'Gemini extraction lost the project present only in the uploaded PDF');
  assert.ok(profile.master_profile.master_resume_path, 'Original uploaded PDF was not saved');
  proof.resumeExtraction = {
    model: profile.master_profile.resume_extraction_model || null,
    fallbackUsed: profile.master_profile.resume_extraction_fallback_used === true,
    hasNotice: Boolean(profile.master_profile.resume_extraction_warning),
  };
  proof.uploadObjectKey = profile.master_profile.master_resume_path;
  proof.uploadedProjectPreservedInProfile = true;
  proof.originalResumeSaved = true;
  const cookie = (await context.cookies()).find(c => c.name === 'hireflow_session');
  proof.sessionCookie = { httpOnly: cookie?.httpOnly === true, secure: cookie?.secure === true, sameSiteLax: cookie?.sameSite === 'Lax' };
  assert.ok(Object.values(proof.sessionCookie).every(Boolean));
  assert.equal(await page.evaluate(() => localStorage.getItem('hireflow.userId')), null);
  await shot('02-profile-after-resume-upload');

  phase('structured_profile_options_edit_and_preserve_uploaded_facts');
  await page.getByLabel('Professional summary', { exact: true }).fill('Student developer building Python and LangChain study tools.');
  await page.getByRole('button', { name: 'Add experience', exact: true }).click();
  const addedExperience = await page.getByLabel(/^Experience \d+ role$/).count();
  await page.getByLabel(`Experience ${addedExperience} role`, { exact: true }).fill('Synthetic QA project contributor');
  await page.getByLabel(`Experience ${addedExperience} company`, { exact: true }).fill('Independent academic project');
  await page.getByLabel(`Experience ${addedExperience} dates`, { exact: true }).fill('2026');
  await page.getByLabel(`Experience ${addedExperience} highlights`, { exact: true }).fill('Built the Orbit Note Assistant using Python and LangChain.\nTested summaries against five synthetic notes.');
  await page.getByRole('button', { name: 'Add link', exact: true }).click();
  const addedLink = await page.getByLabel(/^Link \d+ label$/).count();
  await page.getByLabel(`Link ${addedLink} label`, { exact: true }).fill('QA portfolio');
  await page.getByLabel(`Link ${addedLink} URL`, { exact: true }).fill('https://example.com/qa-portfolio');
  await page.getByLabel('Certifications', { exact: true }).fill('Synthetic course completion (QA fixture)');
  await page.getByLabel('Achievements', { exact: true }).fill('Created five reproducible study-note tests (QA fixture)');
  await page.getByLabel('Spoken languages', { exact: true }).fill('English');
  await page.getByLabel(/^Review applications/).selectOption('individual');
  await page.getByLabel(/^Excluded companies/).fill('Unrelated QA Employer');
  const editedResponse = page.waitForResponse(r => r.url() === `${site}/api/profile/${proof.userId}` && r.request().method() === 'PATCH', { timeout: 65000 });
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  const edited = await editedResponse; assert.equal(edited.status(), 200);
  const updated = await edited.json();
  assert.match(JSON.stringify(updated.master_profile.projects), /Orbit Note Assistant/i);
  assert.match(JSON.stringify(updated.master_profile.education), /Example University/);
  assert.match(JSON.stringify(updated.master_profile.experience), /Synthetic QA project contributor/);
  assert.match(JSON.stringify(updated.master_profile.links), /example.com\/qa-portfolio/);
  assert.equal(updated.confirmation_mode, 'individual');
  proof.structuredProfileEditorVerified = true;
  proof.individualConfirmationMode = true;
  await shot('02b-structured-profile-details');

  phase('opportunities_plan_and_swap_via_ui');
  await navigation('Weekly plan');
  await page.getByRole('heading', { name: 'Your weekly plan.', exact: true }).waitFor();
  await addOpportunity(primaryCompany, 'primary');
  await until(() => page.getByRole('button', { name: 'Preview resume', exact: true }).isEnabled().catch(() => false), 'first tailored PDF');
  await addOpportunity(finalCompany, 'alternate');
  await pause(1000);
  let plan = await jsonGet(`/api/weekly-plan/${proof.userId}`);
  assert.equal(plan.plan.length, 1);
  assert.equal(plan.alternatives.length, 1);
  proof.jobIds = [plan.plan[0].job_id, plan.alternatives[0].job_id];
  proof.applicationIds = [plan.plan[0].application_id, plan.alternatives[0].application_id];
  proof.resumeObjectKeys = [`resumes/${proof.userId}/${plan.plan[0].job_id}_resume_v${plan.plan[0].resume_version}.pdf`];
  const alternate = plan.alternatives.find(a => a.company_name === finalCompany);
  assert.ok(alternate, 'Alternate controlled fixture was not ranked');
  const swapResponse = page.waitForResponse(r => r.url() === `${site}/api/weekly-plan/${proof.userId}/swap` && r.request().method() === 'POST');
  await page.getByLabel(`Swap ${role}`, { exact: true }).selectOption(String(alternate.job_id));
  assert.equal((await swapResponse).status(), 200);
  await page.locator('.job-card').filter({ hasText: finalCompany }).waitFor();
  if (await page.locator('.opportunity-discovery details').evaluate(el => el.open)) await page.locator('.opportunity-discovery summary').click();
  await until(() => page.getByRole('button', { name: 'Preview resume', exact: true }).isEnabled().catch(() => false), 'swapped tailored PDF');
  plan = await jsonGet(`/api/weekly-plan/${proof.userId}`);
  const application = plan.plan[0];
  assert.equal(application.company_name, finalCompany);
  proof.applicationId = application.application_id;
  proof.jobId = application.job_id;
  proof.company = finalCompany;
  proof.resumeObjectKeys.push(`resumes/${proof.userId}/${application.job_id}_resume_v${application.resume_version}.pdf`);
  proof.swapVerified = true;
  await shot('03-weekly-plan-after-swap');

  phase('actual_pdf_preview_and_fact_preservation');
  await page.getByRole('button', { name: 'Preview resume', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const pdfPath = await dialog.locator('iframe').getAttribute('src');
  assert.equal(pdfPath, `/api/resumes/${proof.userId}/${proof.applicationId}/download`);
  const bytes = await readPdf(pdfPath);
  writeFileSync(tailoredPdf, bytes, { mode: 0o600 });
  const extracted = pdfText(tailoredPdf);
  assert.match(extracted, /Full UI QA/);
  assert.match(extracted, /Orbit Note Assistant/i);
  assert.match(extracted, /Example University/);
  assert.match(extracted, /Python/);
  assert.match(extracted, /LangChain/);
  assert.match(extracted, /Synthetic QA project contributor/);
  assert.match(extracted, /Independent academic project/);
  assert.match(extracted, /example.com\/qa-portfolio/);
  assert.match(extracted, /Synthetic course completion/);
  assert.match(extracted, /Created five reproducible study-note tests/);
  assert.match(extracted, /English/);
  proof.tailoredPdfFacts = { name: true, project: true, education: true, skills: true, editedExperience: true, profileLink: true, certification: true, achievement: true, language: true, bytes: bytes.length };
  execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-r', '110', '-png', '-singlefile', tailoredPdf, `${output}/tailored-resume-render`]);
  chmodSync(`${output}/tailored-resume-render.png`, 0o600);
  await pause(1500);
  await shot('04-real-pdf-preview');
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('link', { name: 'Open PDF', exact: true }).click();
  const pdfPopup = await popupPromise;
  await pdfPopup.waitForURL(new RegExp(`/api/resumes/${proof.userId}/${proof.applicationId}/download`), { waitUntil: 'commit' });
  await pause(1000);
  await pdfPopup.close();
  proof.openPdfViaUiVerified = true;
  await page.getByRole('button', { name: 'Close resume preview', exact: true }).click();

  phase('confirm_only_controlled_fixture_via_ui');
  const confirmResponse = page.waitForResponse(r => r.url() === `${site}/api/weekly-plan/${proof.userId}/confirm` && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirm this opportunity', exact: true }).click();
  assert.equal((await confirmResponse).status(), 200);
  await page.getByText(/1 applications confirmed and queued/).waitFor();
  await shot('05-confirmed-from-ui');

  phase('actual_cloudflare_browser_and_tracker_ui');
  await navigation('Applications');
  const row = page.getByRole('row').filter({ hasText: finalCompany });
  await row.waitFor();
  await until(async () => {
    const status = await row.locator('.status-badge').textContent();
    if (/failed|needs action/.test(status)) throw new Error('Controlled form needs attention; inspect the retained synthetic application');
    return status.trim() === 'applied';
  }, 'live tracker applied state', 180000);
  const tracker = await jsonGet(`/api/applications/${proof.userId}`);
  const applied = tracker.items.find(a => a.id === proof.applicationId);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.attempts, 1);
  assert.equal(applied.failure_reason, null);
  assert.ok(applied.applied_at);
  assert.ok(applied.status_history.every(event => event.timestamp));
  proof.attempts = applied.attempts;
  proof.applicationStatus = applied.status;
  proof.statusHistory = applied.status_history.map(event => event.status);
  for (const status of ['planned', 'confirmed', 'applying', 'applied']) assert.ok(proof.statusHistory.includes(status));
  await shot('06-tracker-applied');

  phase('prep_guide_questions_and_resources_ui');
  await row.getByRole('link', { name: 'Prep guide', exact: true }).click();
  await until(async () => {
    if (await page.getByRole('heading', { name: 'Your study compass', exact: true }).isVisible()) return true;
    const retry = page.getByRole('button', { name: 'Try again', exact: true });
    if (await retry.isVisible()) await retry.click();
    return false;
  }, 'saved prep guide to render', 180000, 4000);
  assert.equal(await page.locator('.round-list li').count(), 2);
  assert.ok(await page.locator('.questions details').count() >= 3);
  const categoryLabels = (await page.locator('.question-label').allTextContents()).map(label => label.toLowerCase());
  for (const category of ['technical', 'behavioral', 'design']) assert.ok(categoryLabels.some(label => label.includes(category)), `Missing ${category} mock questions`);
  const technicalQuestion = page.locator('.questions details').filter({ hasText: 'technical question' }).first();
  await technicalQuestion.locator('summary').click();
  assert.equal(await page.locator('.questions details[open]').count(), 1);
  assert.match(await technicalQuestion.locator('.question-body').innerText(), /Python|LangChain|Docker|RAG/i);
  await page.getByRole('heading', { name: 'Know the company', exact: true }).waitFor();
  const resources = await page.locator('#resources a').evaluateAll(links => links.map(link => ({ href: link.href, target: link.target, rel: link.rel })));
  assert.ok(resources.length > 0, 'The saved prep guide has no learning resources to inspect.');
  for (const link of resources) { assert.match(link.href, /^https?:\/\//); assert.equal(link.target, '_blank'); assert.match(link.rel, /noopener/); }
  proof.prepGuide = { rounds: 2, questions: await page.locator('.questions details').count(), resources: resources.length, expandedQuestion: true, companyIntelVisible: true };
  await shot('07-prep-guide-questions-resources');

  phase('resume_library_download_via_ui');
  await navigation('Resume library');
  await page.getByRole('heading', { name: 'Your resume library.', exact: true }).waitFor();
  const resumeCard = page.locator('.resume-card').filter({ hasText: finalCompany });
  await resumeCard.waitFor();
  const downloadLink = resumeCard.getByRole('link', { name: 'Download PDF', exact: true });
  const downloadPath = await downloadLink.getAttribute('href');
  const downloadPopupPromise = page.waitForEvent('popup');
  await downloadLink.click();
  const downloadPopup = await downloadPopupPromise;
  await downloadPopup.waitForURL(new RegExp(`/api/resumes/${proof.userId}/${proof.applicationId}/download`), { waitUntil: 'commit' });
  assert.ok((await readPdf(downloadPath)).equals(bytes));
  await downloadPopup.close();
  proof.resumeLibraryDownloadVerified = true;
  await shot('08-resume-library');

  phase('weekly_report_generate_and_open_via_ui');
  await navigation('Weekly report');
  await page.getByRole('button', { name: 'Generate this week', exact: true }).click();
  const reportLink = page.getByRole('link', { name: 'Open weekly report', exact: true });
  await reportLink.waitFor({ timeout: 65000 });
  assert.equal(await page.getByRole('alert').count(), 0, 'An obsolete report error remains visible after generation');
  const reportPopupPromise = page.waitForEvent('popup');
  await reportLink.click();
  const reportPopup = await reportPopupPromise;
  await reportPopup.waitForLoadState('domcontentloaded');
  await reportPopup.getByText(finalCompany, { exact: false }).waitFor();
  assert.match(await reportPopup.locator('body').innerText(), /1 applied/);
  const reportShot = `${output}/10-private-html-report.png`;
  await reportPopup.screenshot({ path: reportShot, fullPage: true, animations: 'disabled' });
  chmodSync(reportShot, 0o600); proof.screenshots.push(reportShot);
  const reportArticle = reportPopup.locator('article').filter({ hasText: finalCompany });
  const reportPrepLink = reportArticle.getByRole('link', { name: 'Prep guide', exact: true });
  assert.equal(await reportPrepLink.getAttribute('href'), `${site}/applications/${proof.applicationId}/prep-guide`);
  assert.equal(await reportArticle.getByRole('link', { name: 'Resume PDF', exact: true }).getAttribute('href'), `${site}${pdfPath}`);
  await reportPrepLink.click();
  await reportPopup.getByRole('heading', { name: 'Your study compass', exact: true }).waitFor();
  proof.reportPrepGuideLinkVerified = true;
  const reportPrepShot = `${output}/14-report-link-to-prep-guide.png`;
  await reportPopup.screenshot({ path: reportPrepShot, fullPage: true, animations: 'disabled' });
  chmodSync(reportPrepShot, 0o600); proof.screenshots.push(reportPrepShot);
  await reportPopup.close();
  const report = await jsonGet(`/api/report/${proof.userId}/latest`);
  proof.reportId = report.id;
  proof.reportObjectKey = report.html_path;
  proof.reportGeneratedViaUi = true;
  await shot('09-weekly-report-dashboard');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'Open weekly report', exact: true }).waitFor();
  assert.equal((await jsonGet('/api/session')).authenticated, true);
  proof.sessionReloadVerified = true;

  phase('mobile_navigation_and_overflow');
  await page.setViewportSize({ width: 390, height: 844 });
  proof.mobileChecks = [];
  for (const [label, heading] of [['Weekly report', 'Your weekly report.'], ['Resume library', 'Your resume library.'], ['Applications', 'Your applications.'], ['Weekly plan', 'Your weekly plan.']]) {
    await navigation(label);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    await pause(500);
    await until(async () => await page.locator('.loading').count() === 0, `mobile ${label} data`);
    assert.equal(await page.getByRole('alert').count(), 0, `Mobile ${label} has a visible error`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Mobile overflow on ${label}`);
    const sidebar = await page.locator('.sidebar').boundingBox();
    assert.ok(sidebar.x + sidebar.width <= 0.5, 'Mobile navigation did not close');
    proof.mobileChecks.push(label);
  }
  await shot('11-mobile-weekly-plan');
  await page.getByRole('link', { name: 'Your profile', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await shot('12-mobile-profile');

  phase('logout_and_private_access_revocation_via_ui');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByText(/^You have signed out\./).waitFor();
  assert.equal((await jsonGet('/api/session')).authenticated, false);
  await jsonGet(`/api/profile/${proof.userId}`, 401);
  await jsonGet(pdfPath, 401);
  proof.logoutRevokesPrivateAccess = true;
  await shot('13-signed-out');
  proof.pagesPipelineStatus = 'passed';
  }
  await verifyWorkspaceTransfer();
  await Promise.allSettled([...pendingResponses]);
  assert.deepEqual(proof.pageErrors, []);
  assert.ok(!proof.httpResponses.some(r => r.cpuLimitExceeded), 'Cloudflare reported a CPU limit failure');
  proof.status = 'passed';
  proof.stage = 'complete';
} catch (error) {
  proof.error = safeMessage(error);
  if (page) await shot('failure-state').catch(() => {});
  if (proof.userId && context) {
    const retained = await jsonGet(`/api/applications/${proof.userId}`).catch(() => null);
    if (retained?.items) {
      proof.applicationIds = retained.items.map(item => item.id);
      proof.jobIds = retained.items.map(item => item.job_id);
    }
  }
} finally {
  await Promise.allSettled([...pendingResponses]);
  if (browser) await browser.close().catch(() => { proof.cleanupError = 'Browser close did not complete'; });
  proof.finishedAt = new Date().toISOString();
  writeProof();
}
console.log(JSON.stringify(proof, null, 2));
if (proof.status !== 'passed') process.exitCode = 1;
