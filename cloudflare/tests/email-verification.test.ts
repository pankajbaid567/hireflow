/** Email ownership verification: real Worker module + D1, Gmail transport replaced by a recording stub. */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from './migrations';

const root = fileURLToPath(new URL('../', import.meta.url));
const stub = `let sent=[];let mode='accepted';
export function setMode(m){mode=m;} export function sentMail(){return sent;}
export const profileEmailDelivery=env=>String(env.GMAIL_ALLOW_PROFILE_EMAIL||'')==='true';
export function gmailReadiness(env){return{ready:Boolean(env.GMAIL_USER&&env.GMAIL_APP_PASSWORD),reason:'x'};}
export function gmailRecipientAllowed(env,to){return String(env.GMAIL_USER).toLowerCase()===String(to).toLowerCase();}
export async function sendGmailMessage(env,message){sent.push(message);return mode==='accepted'?{state:'accepted',provider_message_id:message.messageId,provider_status:250}:{state:'rejected',provider_status:550,failure_reason:'nope'};}`;
const harness = `import {emailVerificationStatus,requestEmailVerification,confirmEmailVerification} from './src/email_verification';import {setMode,sentMail} from './src/gmail_transport';import {ApiError} from './src/types';
export default{async fetch(request,env){try{const url=new URL(request.url),p=url.pathname;setMode(request.headers.get('X-Mode')||'accepted');
if(p==='/status')return Response.json(await emailVerificationStatus(env,1));
if(p==='/request')return Response.json(await requestEmailVerification(env,1));
if(p==='/confirm')return Response.json({ok:await confirmEmailVerification(env,url.searchParams.get('token')||'')});
if(p==='/mail')return Response.json(sentMail());
return new Response(null,{status:404});}catch(e){return Response.json({detail:e instanceof ApiError?e.message:'fail'},{status:e instanceof ApiError?e.status:500});}}};`;
let mf: Miniflare, db: Awaited<ReturnType<Miniflare['getD1Database']>>, bundle: string;
beforeAll(async () => {
  bundle = (await build({ stdin: { contents: harness, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent',
    plugins: [{ name: 'stub-gmail', setup(b) { b.onResolve({ filter: /gmail_transport$/ }, () => ({ path: 'gmail-stub', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub, loader: 'js' })); } }] })).outputFiles[0].text;
}, 30000);
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { GMAIL_USER: 'owner@gmail.com', GMAIL_APP_PASSWORD: 'abcdabcdabcdabcd', GMAIL_ALLOW_PROFILE_EMAIL: 'true', PUBLIC_BASE_URL: 'https://app.example/api' } }));
  db = await mf.getD1Database('DB'); await applyTestMigrations(db);
  await db.prepare("INSERT INTO users(id,name,email,mode) VALUES(1,'Newcomer','new@example.com','internship')").run();
}, 30000);
afterEach(async () => { await mf?.dispose(); }, 30000);
const call = async (path: string, headers: Record<string, string> = {}) => { const r = await mf.dispatchFetch('https://v.example' + path, { headers }); return { status: r.status, body: await r.json() as any }; };
const tokenFromMail = async () => { const mail = (await call('/mail')).body; const html = mail.at(-1).html as string; return new URL(/href="([^"]+)"/.exec(html)![1]).searchParams.get('token')!; };

describe('email ownership verification', () => {
  it('starts unverified and required for an ordinary address', async () => {
    expect((await call('/status')).body).toMatchObject({ email: 'new@example.com', verified: false, required: true });
  });
  it('sends one link to the profile address only, with a high-entropy single-use token stored hashed', async () => {
    const r = await call('/request'); expect(r.body.state).toBe('sent');
    const mail = (await call('/mail')).body; expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: 'new@example.com', from: 'owner@gmail.com', profile_recipient: true });
    expect(mail[0].html).not.toContain('Newcomer');   // no user-controlled text in a mail to an unproven address
    const token = await tokenFromMail(); expect(token).toMatch(/^[a-f0-9]{64}$/);
    const rows = (await db.prepare('SELECT token_hash FROM email_verifications').all<any>()).results;
    expect(rows).toHaveLength(1); expect(rows[0].token_hash).not.toBe(token); expect(rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('confirms once, marks the account verified, and rejects replay', async () => {
    await call('/request'); const token = await tokenFromMail();
    expect((await call('/confirm?token=' + token)).body.ok).toBe(true);
    expect((await call('/status')).body).toMatchObject({ verified: true });
    expect((await call('/confirm?token=' + token)).body.ok).toBe(false);
  });
  it('rejects unknown, malformed and expired tokens', async () => {
    expect((await call('/confirm?token=' + 'a'.repeat(64))).body.ok).toBe(false);
    expect((await call('/confirm?token=short')).body.ok).toBe(false);
    await call('/request'); const token = await tokenFromMail();
    await db.prepare("UPDATE email_verifications SET expires_at='2000-01-01T00:00:00.000Z'").run();
    expect((await call('/confirm?token=' + token)).body.ok).toBe(false);
    expect((await call('/status')).body.verified).toBe(false);
  });
  it('does not verify if the profile email changed after the link was sent', async () => {
    await call('/request'); const token = await tokenFromMail();
    await db.prepare("UPDATE users SET email='other@example.com' WHERE id=1").run();
    expect((await call('/confirm?token=' + token)).body.ok).toBe(false);
    expect((await call('/status')).body.verified).toBe(false);
  });
  it('limits link requests to 2 per day per account and reports already-verified without sending', async () => {
    await call('/request'); await call('/request');
    expect((await call('/request')).status).toBe(429);
    await db.prepare("UPDATE users SET email_verified_at='2026-11-02T00:00:00.000Z'").run();
    await db.prepare('DELETE FROM email_verifications').run();
    const before = (await call('/mail')).body.length;
    expect((await call('/request')).body.state).toBe('already_verified'); expect((await call('/mail')).body).toHaveLength(before);
  });
  it('invalidates the token when Gmail rejects the send', async () => {
    const r = await call('/request', { 'X-Mode': 'rejected' }); expect(r.body.state).toBe('failed');
    const row = await db.prepare('SELECT used_at FROM email_verifications').first<any>(); expect(row.used_at).not.toBeNull();
  });
  it('treats the operator mailbox as already verified and not required', async () => {
    await db.prepare("UPDATE users SET email='owner@gmail.com' WHERE id=1").run();
    expect((await call('/status')).body).toMatchObject({ verified: true, required: false });
  });
  it('is off when profile-email delivery is not enabled', async () => {
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { GMAIL_USER: 'owner@gmail.com', GMAIL_APP_PASSWORD: 'abcdabcdabcdabcd' } }));
    db = await mf.getD1Database('DB'); await applyTestMigrations(db); await db.prepare("INSERT INTO users(id,name,email,mode) VALUES(1,'N','new@example.com','internship')").run();
    expect((await call('/status')).body).toMatchObject({ required: false });
    expect((await call('/request')).status).toBe(403);
  });
});
