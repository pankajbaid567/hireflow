/** Explicit synthetic production account proof; no jobs, models, email or employers. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

assert.ok(process.argv.includes('--run-live'), 'Pass --run-live to enable synthetic production account verification.');
const site = (process.env.HIREFLOW_SITE || 'https://hireflow-dashboard.pages.dev').replace(/\/$/, '');
const target = new URL(site);
assert.equal(target.protocol, 'https:', 'Use the canonical HTTPS dashboard origin.');
assert.equal(target.origin, site, 'The dashboard target must be an origin without a path.');
assert.ok(!target.username && !target.password, 'The dashboard URL must not contain credentials.');
const require = createRequire(new URL('../cloudflare/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const email = `passkey-live-qa-${runId}@example.com`;
const directory = `/tmp/hireflow-account-security-live/${runId}`;
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync('/tmp/hireflow-account-security-live', 0o700);
chmodSync(directory, 0o700);
const proofPath = `${directory}/proof.json`;
const proof = { status: 'pending', site, runId, fake_email: email, started_at: new Date().toISOString(),
  scope: 'one-synthetic-profile-account-recovery-only', user_id: null, stage: 'starting',
  synthetic_record_retained: true, employer_submissions: 0, email_sends: 0, model_requests: 0,
  passkey_registration: false, second_device_signed_assertion_login: false,
  recovery_key_new_browser: false, key_replay_rejected: false, old_sessions_revoked: false,
  revoke_all: false, browser_runtime_errors: 0, blocked_requests: 0 };
let browser;
function save(stage) {
  proof.stage = stage;
  writeFileSync(proofPath, JSON.stringify(proof, null, 2), { mode: 0o600 });
  chmodSync(proofPath, 0o600);
}
function ensure(condition, label) { assert.ok(condition, label); }
async function context() {
  const value = await browser.newContext();
  // Fail closed if navigation accidentally reaches an employer or a feature
  // capable of model work. All credential data remains in browser memory.
  await value.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const safeApi = method === 'GET' && /^\/api\/(?:session|profile\/\d+|operations\/\d+)$/.test(url.pathname)
      || method === 'POST' && url.pathname === '/api/profile'
      || ['GET', 'POST', 'DELETE'].includes(method) && url.pathname.startsWith('/api/account/');
    if (url.origin !== site || url.pathname.startsWith('/api/') && !safeApi) {
      proof.blocked_requests++; await route.abort(); return;
    }
    await route.continue();
  });
  return value;
}
async function openProfile(value) {
  const page = await value.newPage();
  page.on('pageerror', () => { proof.browser_runtime_errors++; });
  await page.goto(`${site}/profile`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByRole('button', { name: 'Save profile', exact: true }).waitFor();
  return page;
}
async function openRecovery(page) {
  if (!await page.getByRole('heading', { name: 'Recover your workspace' }).isVisible())
    await page.getByText('Already have a workspace? Sign in', { exact: true }).click();
  await page.getByRole('heading', { name: 'Recover your workspace' }).waitFor();
}
async function virtualAuthenticator(value, page, credentials = []) {
  const cdp = await value.newCDPSession(page); await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  for (const credential of credentials) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  return { cdp, authenticatorId };
}
async function session(value) {
  const response = await value.request.get(`${site}/api/session`, { timeout: 30000 });
  ensure(response.status() === 200, 'Session status check failed'); return response.json();
}
try {
  save('launching'); browser = await chromium.launch({ headless: true });
  const first = await context(), page = await openProfile(first), auth = await virtualAuthenticator(first, page);
  ensure((await session(first)).authenticated === false, 'A new context must start signed out');
  save('signup');
  await page.getByLabel('Full name', { exact: true }).fill('Passkey Live QA');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/profile' && response.request().method() === 'POST', { timeout: 65000 });
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  const signup = await created;
  ensure(signup.status() === 201, 'Synthetic profile creation failed');
  const owner = await signup.json();
  ensure(Number.isSafeInteger(owner.id) && owner.id > 0, 'Synthetic owner ID is missing');
  proof.user_id = owner.id; save('enrolling_passkey');
  await page.getByRole('heading', { name: 'Account security and recovery' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
  await page.getByText(/^Passkey added\./).waitFor({ timeout: 30000 });
  const { credentials } = await auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: auth.authenticatorId });
  ensure(credentials.length === 1, 'The authenticator did not retain one passkey');
  proof.passkey_registration = true; save('second_device_login');
  // Simulate a passkey provider making the resident credential available on
  // another device. No site cookies or session tokens are copied.
  const second = await context(), secondPage = await openProfile(second);
  await virtualAuthenticator(second, secondPage, credentials);
  ensure((await session(second)).authenticated === false, 'Second device was already signed in');
  await openRecovery(secondPage);
  await secondPage.getByRole('button', { name: 'Continue with a passkey', exact: true }).click();
  await secondPage.getByRole('heading', { name: 'Account security and recovery' }).waitFor({ timeout: 30000 });
  ensure((await session(second)).user_id === owner.id, 'The signed assertion did not restore its owner');
  proof.second_device_signed_assertion_login = true; save('generating_keys');
  await page.getByRole('button', { name: 'Generate recovery keys', exact: true }).click();
  const keyArea = page.getByLabel('Recovery keys to save'); await keyArea.waitFor({ timeout: 30000 });
  const keys = (await keyArea.inputValue()).split('\n');
  ensure(keys.length === 8 && keys.every(key => /^hf-recovery-[a-f0-9]{64}$/.test(key)), 'Recovery keys have an unexpected shape');
  await page.getByRole('button', { name: 'I saved these keys', exact: true }).click();
  ensure(await keyArea.count() === 0, 'Recovery keys remained visible after hiding');
  save('third_device_recovery');
  const third = await context(), thirdPage = await openProfile(third);
  ensure((await session(third)).authenticated === false, 'Third device was already signed in');
  await openRecovery(thirdPage);
  await thirdPage.getByLabel('Recovery key', { exact: true }).fill(keys[0]);
  await thirdPage.getByRole('button', { name: 'Use recovery key', exact: true }).click();
  await thirdPage.getByRole('heading', { name: 'Account security and recovery' }).waitFor({ timeout: 30000 });
  ensure((await session(third)).user_id === owner.id, 'Key recovery did not restore its owner');
  proof.recovery_key_new_browser = true; save('checking_revocation');
  for (const old of [first, second]) ensure((await old.request.get(`${site}/api/profile/${owner.id}`)).status() === 401, 'A lost-device session remained valid');
  proof.old_sessions_revoked = true;
  const replay = await third.request.post(`${site}/api/account/recover`, { headers: { Origin: site }, data: { recovery_key: keys[0] } });
  ensure(replay.status() === 401, 'A spent recovery key was accepted'); proof.key_replay_rejected = true;
  const securityResponse = await third.request.get(`${site}/api/account/security`);
  ensure(securityResponse.status() === 200, 'Account security status failed');
  const security = await securityResponse.json();
  ensure(security.recovery_keys.remaining === 7 && security.sessions.length === 1, 'Unexpected recovery/session totals');
  save('revoking_all');
  await thirdPage.getByRole('button', { name: 'Sign out all devices', exact: true }).click();
  await openRecovery(thirdPage);
  ensure((await third.request.get(`${site}/api/profile/${owner.id}`)).status() === 401, 'Sign-out-all did not revoke the active session');
  proof.revoke_all = true;
  ensure(proof.browser_runtime_errors === 0, 'A browser runtime error occurred');
  ensure(proof.blocked_requests === 0, 'The page attempted an out-of-scope request');
  proof.status = 'passed'; proof.finished_at = new Date().toISOString(); save('complete');
  console.log(JSON.stringify({ status: proof.status, user_id: proof.user_id, fake_email: email, proof: proofPath }));
} catch (error) {
  // Never serialize exception messages, request bodies, cookies or credential
  // responses. A failed stage and safe type are enough to coordinate diagnosis.
  proof.status = 'failed'; proof.error_type = error instanceof Error ? error.name : 'UnknownError'; save(proof.stage);
  console.error(JSON.stringify({ status: 'failed', stage: proof.stage, error_type: proof.error_type, user_id: proof.user_id, proof: proofPath }));
  process.exitCode = 1;
} finally { await browser?.close(); }
