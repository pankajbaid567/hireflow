import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from './migrations';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'synthetic-signup-bootstrap-code-24-characters';
let apiBundle: string, pagesBundle: string, mf: Miniflare, providerRequests: number, providerFails: boolean;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(() => {
  apiBundle = buildSync({ entryPoints: [`${root}src/index.ts`], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
  pagesBundle = buildSync({ stdin: { contents: `import {onRequest} from ${JSON.stringify(fileURLToPath(new URL('../../frontend/functions/api/[[path]].js', import.meta.url)))};export default {fetch(request,env){return onRequest({request,env});}};`, sourcefile: 'signup-pages.js', resolveDir: root }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' }).outputFiles[0].text;
});
beforeEach(async () => {
  providerRequests = 0; providerFails = false;
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'pages', modules: true, script: pagesBundle, compatibilityDate: '2026-10-21', serviceBindings: { API: 'api' }, bindings: { WORKER_API_URL: 'https://api.example', WORKSPACE_ACCESS_CODE: code } },
    { name: 'api', modules: true, script: apiBundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], kvNamespaces: ['FILES_KV'], queueProducers: { APPLICATION_QUEUE: 'signup-limits' }, bindings: { ACCESS_CODE: code, GEMINI_API_KEY: 'synthetic-provider-key', ALLOWED_ORIGINS: 'https://pages.example', BROWSER_ENABLED: 'false' }, outboundService: () => {
      providerRequests++;
      if (providerFails) return new Response('{}', { status: 400 });
      const profile = { name: 'PDF Signup Candidate', email: `pdf-signup-${providerRequests}@example.com`, mode: 'internship', skills: ['Python'], projects: [{ name: 'Actual fixture project', description: 'Built a Python API.' }] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(profile) }] } }] });
    } },
  ] }));
  db = await mf.getD1Database('DB', 'api'); await applyTestMigrations(db);
}, 30000);
afterEach(async () => { await mf?.dispose(); }, 30000);
async function create(body: FormData | Record<string, unknown>, ip = '203.0.113.1') {
  const headers: Record<string, string> = { Origin: 'https://pages.example', 'CF-Connecting-IP': ip };
  let bytes: string | ArrayBuffer;
  if (body instanceof FormData) {
    const encoded = new Request('https://upload.example', { method: 'POST', body });
    headers['Content-Type'] = encoded.headers.get('Content-Type')!; bytes = await encoded.arrayBuffer();
  } else { headers['Content-Type'] = 'application/json'; bytes = JSON.stringify(body); }
  return mf.dispatchFetch('https://pages.example/api/profile', { method: 'POST', headers, body: bytes });
}
function pdf(signature = '%PDF-1.4\nSynthetic resume') {
  const form = new FormData();
  // Legitimate PDF-only signup has no manually entered identity.
  form.set('name', ''); form.set('email', ''); form.set('mode', 'internship');
  form.set('resume', new Blob([signature], { type: 'application/pdf' }), 'resume.pdf');
  return form;
}
const signupRows = () => db.prepare("SELECT key,attempts FROM login_attempts WHERE key LIKE 'signup:%' OR key LIKE 'signup-ip:%'").all<any>();

describe('public Pages signup budgets', () => {
  it('rejects fifty invalid JSON profiles without spending either signup budget, then accepts a valid profile', async () => {
    for (let index = 0; index < 50; index++) expect((await create({})).status).toBe(422);
    expect((await signupRows()).results).toEqual([]); expect(providerRequests).toBe(0);
    const valid = await create({ name: 'Valid Candidate', email: 'valid-signup@example.com', mode: 'internship', skills: ['Python'] });
    expect(valid.status, await valid.clone().text()).toBe(201);
    expect((await signupRows()).results.every(row => row.attempts === 1)).toBe(true);
    expect((await db.prepare('SELECT count(*) AS n FROM users').first<any>())!.n).toBe(1);
  }, 30000);

  it('rejects malformed multipart and non-PDF uploads before reservations or provider requests', async () => {
    const malformed = await mf.dispatchFetch('https://pages.example/api/profile', { method: 'POST', headers: { Origin: 'https://pages.example', 'Content-Type': 'multipart/form-data; boundary=missing' }, body: 'not a multipart form' });
    expect(malformed.status).toBe(400);
    expect((await create(pdf('not a PDF'))).status).toBe(400);
    expect((await signupRows()).results).toEqual([]); expect(providerRequests).toBe(0);
    expect((await create(pdf())).status).toBe(201); expect(providerRequests).toBe(1);
  });

  it('atomically allows at most five concurrent PDF-only provider calls per IP while keeping the operator counter separate', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => create(pdf())));
    expect(results.map(response => response.status).sort()).toEqual([201, 201, 201, 201, 201, 429]);
    expect(providerRequests).toBe(5);
    const counters = (await signupRows()).results;
    expect(counters).toHaveLength(2); expect(counters.every(row => row.attempts === 5)).toBe(true);
    expect(counters.find(row => row.key.startsWith('signup-ip:'))!.key).not.toContain('203.0.113.1');
    // A new address receives its own limit; the daily global counter is shared.
    expect((await create(pdf(), '203.0.113.2')).status).toBe(201); expect(providerRequests).toBe(6);
  });

  it('counts failed extraction attempts, returns clean errors, and permits another attempt after ten minutes', async () => {
    providerFails = true;
    for (let index = 0; index < 5; index++) {
      const result = await create(pdf()); expect(result.status).toBe(503);
      const body = await result.text(); expect(body).toContain('could not finish reading'); expect(body).not.toContain('synthetic-provider-key');
    }
    expect((await create(pdf())).status).toBe(429); expect(providerRequests).toBe(5);
    await db.prepare("UPDATE login_attempts SET window_start=? WHERE key LIKE 'signup-ip:%'").bind(Date.now() - 600001).run();
    providerFails = false;
    expect((await create(pdf())).status).toBe(201); expect(providerRequests).toBe(6);
    expect((await db.prepare("SELECT attempts FROM login_attempts WHERE key LIKE 'signup:%'").first<any>())!.attempts).toBe(6);
  });
});
