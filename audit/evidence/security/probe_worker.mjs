// Phase 3 local-only security probe. Runs the Worker in Miniflare with a local D1 and a
// STUBBED outbound network (no real egress). Never targets production. Run from repo root:
//   node audit/evidence/security/probe_worker.mjs > audit/evidence/security/probe-results.json
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const req = createRequire(`${root}cloudflare/package.json`);
const { buildSync } = req('esbuild');
const { Miniflare, convertV4MiniflareOptions } = req('miniflare');
const { unstable_splitSqlQuery } = req('wrangler');
const ORIGIN = 'https://dashboard.example', CODE = 'probe-owner-code-at-least-24-characters-long';
const egress = [];
const script = buildSync({ entryPoints: [`${root}cloudflare/tests/runtime.ts`], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script, cf: false, logRequests: false, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], r2Buckets: ['FILES'], queueProducers: { APPLICATION_QUEUE: 'probe' },
  bindings: { ACCESS_CODE: CODE, ALLOWED_ORIGINS: ORIGIN, PUBLIC_BASE_URL: `${ORIGIN}/api`, COOKIE_SAME_SITE: 'Lax', BROWSER_ENABLED: 'false', LLM_PROVIDER: 'none' },
  outboundService: async (r) => { egress.push(`${r.method} ${r.url}`); return new Response('<html><title>stub</title>stub body</html>', { status: 200, headers: { 'content-type': 'text/html' } }); },
}));
const db = await mf.getD1Database('DB');
for (const f of readdirSync(`${root}cloudflare/migrations/`).filter(f => /^\d+.*\.sql$/.test(f)).sort())
  await db.batch(unstable_splitSqlQuery(readFileSync(`${root}cloudflare/migrations/${f}`, 'utf8')).map(s => db.prepare(s)));
await mf.ready;
let ip = 1;
async function call(path, o = {}) {
  const h = { 'cf-connecting-ip': o.ip || `203.0.113.${ip++}`, ...(o.headers || {}) };
  if (o.origin !== null) h.Origin = o.origin || ORIGIN;
  if (o.cookie) h.Cookie = o.cookie;
  if (o.code) h['X-HireFlow-Access-Code'] = o.code;
  let body = o.raw;
  if (o.body !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
  const r = await mf.dispatchFetch(`https://worker.example${path}`, { method: o.method || (body !== undefined ? 'POST' : 'GET'), headers: h, body });
  const text = await r.text(); return { status: r.status, headers: Object.fromEntries(r.headers), text };
}
const out = { generated: new Date().toISOString(), note: 'local Miniflare only; outbound stubbed', sections: {} };
const S = (k, v) => (out.sections[k] = v);

// --- users
async function signup(email) {
  const r = await call('/profile', { code: CODE, body: { name: 'Probe ' + email, email, skills: ['Python'], mode: 'internship', weekly_quota: 2 } });
  return { r, id: JSON.parse(r.text).id, cookie: (r.headers['set-cookie'] || '').split(';')[0], setCookie: r.headers['set-cookie'] };
}
const A = await signup('a@probe.example'), B = await signup('b@probe.example');
S('cookie_flags', { setCookie: A.setCookie, httpsRequestWouldAddSecure: 'auth.ts:63 sets Secure only when request URL is https (Worker sees https in prod)', note: 'this probe used https://worker.example so Secure expected' });
// seed A data
for (const n of ['one', 'two']) await call(`/jobs/${A.id}`, { cookie: A.cookie, body: { title: `AI ${n} Intern`, company: `Co${n}`, url: `https://example.com/careers/${n}`, description: 'AI internship. Python required. ' + 'x'.repeat(80) } });
const plan = await call(`/weekly-plan/${A.id}`, { cookie: A.cookie });
const appRows = (await db.prepare('SELECT id FROM applications WHERE user_id=?').bind(A.id).all()).results;
const appId = appRows[0]?.id; const uuid = '11111111-1111-4111-8111-111111111111';
S('seed', { A: A.id, B: B.id, planStatus: plan.status, applicationsForA: appRows.length });

// --- IDOR sweep: B's cookie (and no cookie) against A's resources
const routes = [
  ['GET', `/profile/${A.id}`], ['PATCH', `/profile/${A.id}`, { name: 'Hijack' }],
  ['GET', `/jobs/${A.id}/discover/${uuid}`], ['GET', `/jobs/${A.id}/discovery-cycles`], ['POST', `/jobs/${A.id}`, { title: 'X Intern', company: 'X', url: 'https://example.org/x', description: 'x'.repeat(120) }],
  ['POST', `/jobs/${A.id}/discover`, {}],
  ['GET', `/weekly-plan/${A.id}`], ['POST', `/weekly-plan/${A.id}/confirm`, {}], ['POST', `/weekly-plan/${A.id}/swap`, {}], ['POST', `/weekly-plan/${A.id}/refresh-matches`, {}],
  ['GET', `/applications/${A.id}`], ['GET', `/resumes/${A.id}`], ['GET', `/resumes/${A.id}/${appId}/download`],
  ['GET', `/applications/${appId}/prep-guide`], ['POST', `/applications/${appId}/prep-guide/refresh`, {}], ['GET', `/applications/${appId}/prep-guide/exports`], ['POST', `/applications/${appId}/prep-guide/exports`, {}], ['GET', `/applications/${appId}/prep-guide/exports/${uuid}/html`],
  ['GET', `/applications/${appId}/resume-draft`], ['PUT', `/applications/${appId}/resume-draft`, {}], ['POST', `/applications/${appId}/resume-reject`, {}], ['POST', `/applications/${appId}/resume-regenerate`, {}], ['POST', `/applications/${appId}/review`, { reviewed: true }], ['POST', `/applications/${appId}/cancel`, {}],
  ['GET', `/report/${A.id}/email-readiness`], ['POST', `/report/${A.id}/generate`, {}], ['GET', `/report/${A.id}/latest`], ['GET', `/report/${A.id}/latest/html`], ['POST', `/report/${A.id}/latest/email`, {}], ['GET', `/report/${A.id}/email-deliveries/${uuid}`],
  ['GET', `/operations/${A.id}`], ['POST', `/operations/${A.id}/diagnostics`, {}],
  ['GET', `/hiring/shortlists/1`], ['GET', `/hiring/shortlists/1/report.html`], ['GET', `/hiring/email-deliveries/${uuid}`],
  ['GET', `/account/backups`], ['GET', `/account/backups/${uuid}`], ['GET', `/account/schedule`], ['GET', `/account/security`],
];
const idor = [];
for (const [m, p, b] of routes) {
  const opt = (cookie) => ({ method: m, cookie, body: b });
  const own = await call(p, opt(A.cookie)); const other = await call(p, opt(B.cookie)); const anon = await call(p, opt(undefined));
  idor.push({ route: `${m} ${p.replace(String(A.id), '{A}').replace(String(appId), '{appA}')}`, owner: own.status, otherUser: other.status, anonymous: anon.status,
    leak: other.status < 300 && /Probe a@probe|a@probe\.example|AI one Intern/.test(other.text) });
}
S('idor_sweep', idor);
S('idor_summary', { total: idor.length, otherUser2xx: idor.filter(r => r.otherUser < 300).map(r => r.route), anon2xx: idor.filter(r => r.anonymous < 300).map(r => r.route), leaks: idor.filter(r => r.leak).map(r => r.route), server5xx: idor.filter(r => r.owner >= 500 || r.otherUser >= 500 || r.anonymous >= 500).map(r => r.route) });
// app-id existence oracle: nonexistent vs A's app, as B
const o1 = await call(`/applications/${appId}/prep-guide`, { cookie: B.cookie }), o2 = await call(`/applications/999999/prep-guide`, { cookie: B.cookie });
S('existence_oracle', { realAppAsB: o1.status, realBody: o1.text.slice(0,120), missingAppAsB: o2.status, missingBody: o2.text.slice(0,120), indistinguishable: o1.status === o2.status && o1.text === o2.text });

// --- CSRF / origin
S('origin', {
  evilOriginGet: (await call('/health', { origin: 'https://evil.example' })).status,
  evilOriginMutate: (await call(`/profile/${A.id}`, { method: 'PATCH', cookie: A.cookie, origin: 'https://evil.example', body: { name: 'x' } })).status,
  noOriginMutateWithCookie: (await call(`/profile/${A.id}`, { method: 'PATCH', cookie: A.cookie, origin: null, body: { name: 'Probe a@probe.example' } })).status,
  note: 'Missing Origin is accepted (non-browser clients). SameSite=Lax is the remaining browser-side defence.',
});

// --- signup gate & rate limits
const noCode = await call('/profile', { body: { name: 'n', email: 'n@probe.example', skills: [], mode: 'job', weekly_quota: 1 } });
const sameIp = '198.51.100.7', su = [];
for (let i = 0; i < 7; i++) su.push((await call('/profile', { ip: sameIp, code: CODE, body: { name: 'r', email: `r${i}@probe.example`, skills: ['x'], mode: 'job', weekly_quota: 1 } })).status);
S('signup_limits', { withoutCode: noCode.status, sevenFromOneIp: su });
const lg = []; for (let i = 0; i < 12; i++) lg.push((await call('/session/login', { ip: '198.51.100.9', body: { email: 'a@probe.example', access_code: 'wrong-' + i } })).status);
S('login_bruteforce', { twelveWrongFromOneIp: lg, note: 'rate limit is per IP only (auth.ts:25-36); distributed attempts are not throttled per account' });
// ACCESS_CODE as shared secret: anyone holding it logs in as any email
const shared = await call('/session/login', { body: { email: 'b@probe.example', access_code: CODE } });
S('shared_access_code_login_as_any_user', { status: shared.status, gotCookie: !!shared.headers['set-cookie'], note: 'W-004: holding the single ACCESS_CODE grants any existing user' });

// --- session lifecycle
const tok = await call('/session/transfer', { method: 'POST', cookie: A.cookie, body: {} });
S('session_transfer', { create: tok.status, bodyKeys: tok.status < 300 ? Object.keys(JSON.parse(tok.text)) : tok.text.slice(0, 120) });
try {
  const u = JSON.parse(tok.text).transfer_url; const t = (u.match(/[0-9a-f]{64}/) || [])[0];
  S('session_transfer_url_shape', { hasTokenInFragmentOrQuery: u.includes('#') ? 'fragment' : u.includes('?') ? 'query' : 'path', tokenFound: !!t, urlHost: new URL(u).host });
  const c1 = await call('/session/transfer/consume', { body: { token: t }, origin: new URL(u).origin });
  const c2 = await call('/session/transfer/consume', { body: { token: t }, origin: new URL(u).origin });
  const c3wrongOrigin = await call('/session/transfer/consume', { body: { token: t }, origin: 'https://evil.example' });
  const bogus = await call('/session/transfer/consume', { body: { token: 'a'.repeat(64) } });
  S('session_transfer_replay', { consume1: c1.status, consume1Cookie: !!c1.headers['set-cookie'], consume2Replay: c2.status, wrongOrigin: c3wrongOrigin.status, bogus: bogus.status });
} catch (e) { S('session_transfer_replay', { error: String(e).slice(0, 160) }); }
const lo = await call('/session/logout', { method: 'POST', cookie: B.cookie, body: {} });
S('logout_revokes', { logout: lo.status, reuseOldCookie: (await call(`/profile/${B.id}`, { cookie: B.cookie })).status });

// --- SSRF probes on user-supplied listing URLs
const bad = ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://10.0.0.5/x', 'http://192.168.1.1/', 'http://metadata.google.internal/', 'http://foo.internal/', 'http://user:pw@example.com/', 'file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'http://example.com:22/', 'http://example.com:6379/', 'http://127.0.0.1.nip.io/'];
const ssrf = [];
for (const url of bad) {
  const before = egress.length;
  const r = await call(`/jobs/${A.id}`, { cookie: A.cookie, body: { title: 'SSRF Intern', company: 'SSRF Co', url, description: 'AI internship role. Python. ' + 'y'.repeat(100) } });
  ssrf.push({ url, status: r.status, accepted: r.status < 300, detail: r.status >= 300 ? r.text.slice(0, 90) : undefined, outboundDuringRequest: egress.slice(before) });
}
S('ssrf_add_listing', ssrf);
S('ssrf_accepted', ssrf.filter(s => s.accepted).map(s => s.url));
S('egress_total', { count: egress.length, sample: egress.slice(0, 12) });

// --- input handling
const inp = {};
inp.malformedJson = (await call(`/profile/${A.id}`, { method: 'PATCH', cookie: A.cookie, raw: '{not json', headers: { 'Content-Type': 'application/json' } })).status;
inp.hugeJson = (await call(`/profile/${A.id}`, { method: 'PATCH', cookie: A.cookie, body: { name: 'x'.repeat(300000) } })).status;
inp.nullBody = (await call(`/profile/${A.id}`, { method: 'PATCH', cookie: A.cookie, raw: 'null', headers: { 'Content-Type': 'application/json' } })).status;
inp.arrayBody = (await call(`/profile/${A.id}`, { method: 'PATCH', cookie: A.cookie, raw: '[]', headers: { 'Content-Type': 'application/json' } })).status;
inp.unicodeName = (await call(`/profile/${A.id}`, { method: 'PATCH', cookie: A.cookie, body: { name: 'पंकज बैद 🚀 ' + '‮' } })).status;
inp.badModeSignup = (await call('/profile', { code: CODE, body: { name: 'm', email: 'm@probe.example', skills: [], mode: 'admin', weekly_quota: 1 } })).status;
inp.negativeQuota = (await call('/profile', { code: CODE, body: { name: 'm', email: 'q@probe.example', skills: [], mode: 'job', weekly_quota: -5 } })).status;
inp.sqlLikeEmail = (await call('/profile', { code: CODE, body: { name: "x'; DROP TABLE users;--", email: "o'brien+1@probe.example", skills: ["'; DROP TABLE jobs;--"], mode: 'job', weekly_quota: 1 } })).status;
inp.usersTableStillExists = (await db.prepare('SELECT count(*) c FROM users').first()).c;
inp.pathLikeIds = [(await call('/profile/..%2f..%2fetc', { cookie: A.cookie })).status, (await call('/applications/abc/prep-guide', { cookie: A.cookie })).status, (await call(`/resumes/${A.id}/abc/download`, { cookie: A.cookie })).status];
async function pdfUpload(bytes, name = 'r.pdf', type = 'application/pdf') {
  const fd = new FormData(); fd.set('file', new File([bytes], name, { type })); fd.set('name', 'Pdf Probe'); fd.set('email', `pdf${Math.random().toString(36).slice(2)}@probe.example`); fd.set('mode', 'job'); fd.set('weekly_quota', '1');
  const enc = new Request('https://x.example', { method: 'POST', body: fd });
  return call('/profile', { code: CODE, raw: await enc.text(), headers: { 'Content-Type': enc.headers.get('content-type') } });
}
const pdf = {};
pdf.zeroByte = (await pdfUpload(new Uint8Array(0))).status;
pdf.textRenamedPdf = (await pdfUpload(new TextEncoder().encode('hello not a pdf'))).status;
pdf.htmlAsPdf = (await pdfUpload(new TextEncoder().encode('<script>alert(1)</script>'), 'x.pdf', 'text/html')).status;
pdf.oversize = (await pdfUpload(new Uint8Array(3.3 * 1024 * 1024).fill(32))).status;
const th = await pdfUpload(new TextEncoder().encode('%PDF-1.7\n')); pdf.truncatedHeaderOnly = th.status; pdf.truncatedHeaderBody = th.text.slice(0, 400);

S('input_handling', inp); S('pdf_upload_validation', pdf);

// --- stored XSS / output encoding via report & guide HTML
const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>';
await call(`/profile/${A.id}`, { method: 'PATCH', cookie: A.cookie, body: { name: xss } });
await call(`/jobs/${A.id}`, { cookie: A.cookie, body: { title: xss + ' Intern', company: xss, url: 'https://example.com/careers/xss', description: xss + ' AI internship Python ' + 'z'.repeat(100) } });
await call(`/weekly-plan/${A.id}`, { cookie: A.cookie });
await call(`/report/${A.id}/generate`, { method: 'POST', cookie: A.cookie, body: {} });
const em = await call(`/report/${A.id}/latest/email`, { method: 'POST', cookie: A.cookie, body: {} }); S('email_when_unconfigured', { status: em.status, body: em.text.slice(0, 200) });
const rep = await call(`/report/${A.id}/latest/html`, { cookie: A.cookie });
S('report_html_encoding', { status: rep.status, contentType: rep.headers['content-type'], csp: rep.headers['content-security-policy'] || null, xContentTypeOptions: rep.headers['x-content-type-options'] || null, rawScriptPresent: /<script>alert\(2\)/.test(rep.text), rawImgOnerrorPresent: /<img src=x onerror/.test(rep.text), escapedPresent: /&lt;script&gt;/.test(rep.text) });
// --- response headers
const hh = {}; for (const [k, p, c] of [['health', '/health'], ['private_json', `/profile/${A.id}`, A.cookie], ['docs', '/docs']]) { const r = await call(p, { cookie: c }); hh[k] = { status: r.status, headers: Object.fromEntries(Object.entries(r.headers).filter(([h]) => /^(content-security|strict-transport|x-|referrer|permissions|cache-control|access-control|content-type|cross-origin)/.test(h))) }; }
S('api_headers', hh);
// --- health depth
S('health', { body: JSON.parse((await call('/health')).text) });
console.log(JSON.stringify(out, null, 1));
await mf.dispose();
