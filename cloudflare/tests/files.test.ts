import { applyTestMigrations } from './migrations';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { files } from '../src/files';
import type { Env } from '../src/types';

const root = fileURLToPath(new URL('../', import.meta.url));
const accessCode = 'kv-owner-private-workspace-code-24-characters';
let bundle: string, mf: Miniflare, env: Env;
let kv: Awaited<ReturnType<Miniflare['getKVNamespace']>>;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(() => {
  bundle = buildSync({ entryPoints: [`${root}src/index.ts`], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
});
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], kvNamespaces: ['FILES_KV'], queueProducers: { APPLICATION_QUEUE: 'kv-applications' }, bindings: { ACCESS_CODE: accessCode, BROWSER_ENABLED: 'false' } }));
  kv = await mf.getKVNamespace('FILES_KV'); db = await mf.getD1Database('DB');
  env = { FILES_KV: kv } as unknown as Env;
  await applyTestMigrations(db);
}, 30000);
afterEach(async () => { await mf?.dispose(); }, 30000);

describe('private binary KV file fallback', () => {
  it('round-trips raw PDF bytes and subarray boundaries with content metadata, then deletes them', async () => {
    const bytes = new Uint8Array([99, 37, 80, 68, 70, 45, 0, 255, 99]).subarray(1, 8);
    await files(env).put('resumes/1/version-1.pdf', bytes, { httpMetadata: { contentType: 'application/pdf' } });
    const entry = await kv.getWithMetadata('resumes/1/version-1.pdf', { type: 'arrayBuffer' });
    expect(entry.metadata).toEqual({ contentType: 'application/pdf', size: 7 }); expect(new Uint8Array(entry.value!)).toEqual(bytes);
    const file = await files(env).get('resumes/1/version-1.pdf'); expect(file!.size).toBe(7); expect(file!.httpMetadata?.contentType).toBe('application/pdf'); expect(new Uint8Array(await file!.arrayBuffer())).toEqual(bytes);
    const streamed = await files(env).get('resumes/1/version-1.pdf'); expect(new Uint8Array(await new Response(streamed!.body).arrayBuffer())).toEqual(bytes);
    await files(env).delete('resumes/1/version-1.pdf'); expect(await files(env).get('resumes/1/version-1.pdf')).toBeNull();
  });

  it('stores UTF-8 reports with accurate byte sizes and reads legacy metadata-free values', async () => {
    const html = '<h1>Résumé — 学生 🌊</h1>';
    await files(env).put('reports/immutable-id.html', html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    const report = await files(env).get('reports/immutable-id.html'); expect(report!.size).toBe(new TextEncoder().encode(html).byteLength); expect(report!.httpMetadata?.contentType).toBe('text/html; charset=utf-8'); expect(await report!.text()).toBe(html);
    await kv.put('legacy', 'legacy text'); const legacy = await files(env).get('legacy');
    expect(legacy!.size).toBe(11); expect(legacy!.httpMetadata?.contentType).toBe('application/octet-stream'); expect(await legacy!.text()).toBe('legacy text');
  });

  it('reports missing bindings explicitly and keeps missing keys nullable', async () => {
    expect(() => files({} as Env)).toThrow('Configure private file storage'); expect(await files(env).get('missing')).toBeNull();
  });

  it('supports profile PDF upload, plan generation, authenticated downloads and immutable reports with KV only', async () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ name: 'KV Owner', email: 'kv@example.com', mode: 'internship', skills: '["Python"]', weekly_quota: '1' })) form.append(key, value);
    const resume = '%PDF-1.4\nSynthetic uploaded resume\n%%EOF'; form.append('resume', new Blob([resume], { type: 'application/pdf' }), 'resume.pdf');
    const encoded = new Request('https://upload.example', { method: 'POST', body: form });
    const created = await mf.dispatchFetch('https://worker.example/profile', { method: 'POST', headers: { 'Content-Type': encoded.headers.get('Content-Type')!, 'X-HireFlow-Access-Code': accessCode }, body: await encoded.text() });
    expect(created.status, await created.clone().text()).toBe(201); const user = await created.json() as any; const cookie = created.headers.get('Set-Cookie')!.split(';')[0];
    expect(await kv.get(user.master_profile.master_resume_path)).toBe(resume);
    const call = (path: string, body?: unknown) => mf.dispatchFetch(`https://worker.example${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const added = await call(`/jobs/${user.id}`, { title: 'Python Intern', company: 'KV Example', url: 'https://example.org/jobs/kv-role', description: 'Python Docker internship', listing_type: 'internship' }); expect(added.status).toBe(201);
    const planResponse = await call(`/weekly-plan/${user.id}`); expect(planResponse.status, await planResponse.clone().text()).toBe(200); const plan = await planResponse.json() as any; expect(plan.plan[0].resume_url).toBeTruthy();
    const pdf = await call(plan.plan[0].resume_url); expect(pdf.status).toBe(200); expect(pdf.headers.get('Content-Type')).toBe('application/pdf'); expect(pdf.headers.get('Cache-Control')).toBe('private, no-store'); expect((await pdf.text()).startsWith('%PDF-')).toBe(true);
    expect((await mf.dispatchFetch(`https://worker.example${plan.plan[0].resume_url}`)).status).toBe(401);
    const generate = () => mf.dispatchFetch(`https://worker.example/report/${user.id}/generate`, { method: 'POST', headers: { Cookie: cookie } });
    const first = await generate(); expect(first.status, await first.clone().text()).toBeLessThan(300); const firstReport = await first.json() as any;
    const second = await generate(); expect(second.status).toBeLessThan(300); const latest = await second.json() as any;
    expect(latest.id).toBe(firstReport.id); expect(latest.html_path).not.toBe(firstReport.html_path); expect(latest.html_path).toMatch(/week_\d{4}-\d{2}-\d{2}_[a-f0-9-]+\.html$/);
    expect((await kv.get(latest.html_path))!).toContain('KV Example');
    const html = await call(`/report/${user.id}/latest/html`); expect(html.status).toBe(200); expect(await html.text()).toContain('KV Owner');
    expect((await mf.dispatchFetch(`https://worker.example/report/${user.id}/latest/html`)).status).toBe(401);
    expect((await db.prepare('SELECT count(*) AS n FROM weekly_reports').first<any>())!.n).toBe(1);
  });
});
