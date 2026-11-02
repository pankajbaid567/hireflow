// Sends ONE test mail from the repo's own Gmail transport to the sender's own mailbox. Reads GMAIL_* from the git-ignored .env;
// never prints the password. Usage: node audit/evidence/email_selftest.mjs
import { createRequire } from 'node:module'; import { readFileSync, mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url)); const { build } = createRequire(`${root}cloudflare/package.json`)('esbuild');
const env = Object.fromEntries(readFileSync(`${root}.env`, 'utf8').split('\n').filter(l => /^GMAIL_(USER|APP_PASSWORD)=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { Miniflare, convertV4MiniflareOptions } = createRequire(`${root}cloudflare/package.json`)('miniflare');
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(""); } }', compatibilityDate: '2026-10-21', d1Databases: ['DB'] }));
const DB = await mf.getD1Database('DB'); await DB.exec('CREATE TABLE gmail_daily_usage(day TEXT PRIMARY KEY, attempts INTEGER NOT NULL)'); env.DB = DB;  // throwaway local allowance table; production's allowance is untouched
const dir = mkdtempSync(join(tmpdir(), 'hf-mail-'));
try {
  const out = join(dir, 't.mjs'); await build({ entryPoints: [`${root}cloudflare/src/gmail_transport.ts`], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent', target: 'node22' });
  const { gmailReadiness, sendGmailMessage } = await import(out);
  console.log('readiness:', JSON.stringify(gmailReadiness(env).ready));
  const stamp = Date.now();
  const r = await sendGmailMessage(env, { from: env.GMAIL_USER, to: env.GMAIL_USER, subject: 'HireFlow Gmail transport test', html: `<p>This is a one-off test from the HireFlow audit (${new Date(stamp).toISOString()}). If you can read this, the Gmail app password and transport work.</p>`, messageId: `<hf-audit-test-${stamp}@hireflow.local>` });
  console.log('outcome:', JSON.stringify(r));
} finally { rmSync(dir, { recursive: true, force: true }); await mf.dispose(); }
