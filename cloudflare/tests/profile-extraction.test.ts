import { applyTestMigrations } from './migrations';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'profile-extraction-test-private-code-24';
let bundle: string, mf: Miniflare, providerFails: boolean;
let providerStatus:number,providerCalls:number;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
const extracted = { name: 'Resume Candidate', email: 'resume@example.com', phone: '9999999999', skills: ['Python', 'LangGraph'],
  mode: 'internship', weekly_quota: 10, experience_years: 1, summary: 'Built internal tools.',
  experience: [{ title: 'Developer', company: 'Example', dates: '2025', bullets: ['Shipped the actual tool.'] }],
  projects: [{ name: 'Document Assistant', description: 'Searches notes.', tech: ['Python'] }],
  education: [{ degree: 'B.Tech', institution: 'Example University', year: '2026' }],
  links: [{ label: 'GitHub', url: 'https://github.com/example' }], certifications: ['Example certificate'], achievements: [], languages: ['English'] };
beforeAll(() => {
  bundle = buildSync({ entryPoints: [`${root}tests/runtime.ts`], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
});
beforeEach(async () => {
  providerFails = false;
  providerStatus=400;providerCalls=0;
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['FILES'], queueProducers: { APPLICATION_QUEUE: 'profile-test' },
    bindings: { ACCESS_CODE: code, GEMINI_API_KEY: 'mock-key', BROWSER_ENABLED: 'false' },
    outboundService: () => {providerCalls++;return providerFails ? new Response('{}', { status: providerStatus,headers:{'Retry-After':'45'} }) : Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(extracted) }] } }] });},
  }));
  db = await mf.getD1Database('DB');
  await applyTestMigrations(db);
}, 30000);
afterEach(async () => { await mf?.dispose(); }, 30000);
async function request(path: string, body: FormData | Record<string, unknown>, cookie?: string) {
  const headers: Record<string, string> = { 'X-HireFlow-Access-Code': code };
  if (cookie) headers.Cookie = cookie;
  let bytes: Uint8Array | string;
  if (body instanceof FormData) {
    const encoded = new Request('https://test.example', { method: 'POST', body });
    headers['Content-Type'] = encoded.headers.get('content-type')!;
    bytes = new Uint8Array(await encoded.arrayBuffer());
  } else { headers['Content-Type'] = 'application/json'; bytes = JSON.stringify(body); }
  return mf.dispatchFetch(`https://test.example${path}`, { method: path === '/profile' ? 'POST' : path.includes('/confirm') ? 'POST' : 'PATCH', headers, body: bytes });
}
function upload(values: Record<string, string> = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) form.append(name, value);
  form.append('resume', new Blob(['%PDF-1.4\nSynthetic fixture'], { type: 'application/pdf' }), 'resume.pdf');
  return form;
}

describe('resume profile saves retain complete facts', () => {
  it('extracts experience/projects and honors explicit identity and preferences', async () => {
    const response = await request('/profile', upload({ name: 'Preferred Name', email: 'preferred@example.com', mode: 'job', weekly_quota: '3', projects: '[]' }));
    expect(response.status, await response.clone().text()).toBe(201);
    const user = await response.json() as any;
    expect(user).toMatchObject({ name: 'Preferred Name', email: 'preferred@example.com', mode: 'job', weekly_quota: 3 });
    expect(user.master_profile).toMatchObject({ experience: extracted.experience, projects: extracted.projects, links: extracted.links, certifications: extracted.certifications });
    expect(user.master_profile.resume_extraction_warning).toBeUndefined();
  });

  it('refreshes a replacement PDF instead of retaining old empty facts and extraction warning', async () => {
    const created = await request('/profile', { name: 'Old Name', email: 'old@example.com', mode: 'job', weekly_quota: 3, skills: ['Java'], projects: [], experience: [], resume_extraction_warning: 'Old extraction failed' });
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    const form = upload({ name: 'Old Name', email: 'old@example.com', skills: '["Java"]', projects: '[]', experience: '[]' });
    const response = await request('/profile/1', form, cookie);
    expect(response.status, await response.clone().text()).toBe(200);
    const user = await response.json() as any;
    expect(user).toMatchObject({ name: 'Resume Candidate', email: 'resume@example.com', mode: 'job', weekly_quota: 3 });
    expect(user.master_profile).toMatchObject({ skills: extracted.skills, projects: extracted.projects, experience: extracted.experience, education: extracted.education });
    expect(user.master_profile.resume_extraction_warning).toBeUndefined();
  });

  it('rejects failed extraction even with manual identity and leaves saved data/file intact', async () => {
    providerFails = true;
    const rejected = await request('/profile', upload({ name: 'Manual Name', email: 'manual@example.com', mode: 'job' }));
    expect(rejected.status).toBe(503);
    expect((await db.prepare('SELECT count(*) AS n FROM users').first<any>())!.n).toBe(0);
    const created = await request('/profile', { name: 'Saved Candidate', email: 'saved@example.com', mode: 'job', skills: ['Python'], projects: extracted.projects });
    const before = await created.json() as any;
    const cookie = created.headers.get('set-cookie')!.split(';')[0];
    const response = await request('/profile/1', upload(), cookie);
    expect(response.status).toBe(503);
    const row = await db.prepare('SELECT master_profile,profile_version FROM users WHERE id=1').first<any>();
    expect(JSON.parse(row!.master_profile)).toEqual(before.master_profile); expect(row!.profile_version).toBe(1);
    expect((await (await mf.getR2Bucket('FILES')).list()).objects).toHaveLength(0);
  });

  it('blocks confirmation of a legacy partial extraction until its resume is read again', async () => {
    const created = await request('/profile', { name: 'Legacy', email: 'legacy@example.com', mode: 'job', resume_extraction_warning: 'Old extraction failed' });
    const response = await request('/weekly-plan/1/confirm', { confirmed_job_ids: [1] }, created.headers.get('set-cookie')!.split(';')[0]);
    expect(response.status).toBe(409); expect(await response.text()).toContain('upload it again');
  });
  it('returns a typed rate limit and Retry-After without automatically retrying or replacing saved facts',async()=>{
    const created=await request('/profile',{name:'Saved Candidate',email:'saved@example.com',mode:'job',skills:['Python'],projects:extracted.projects});
    const cookie=created.headers.get('set-cookie')!.split(';')[0],before=await created.json() as any;
    providerFails=true;providerStatus=429;
    const response=await request('/profile/1',upload(),cookie);
    expect(response.status).toBe(429);expect(response.headers.get('Retry-After')).toBe('45');expect(await response.json()).toMatchObject({provider_failure:{kind:'rate_limited',retryable:true,retry_after_seconds:45}});expect(providerCalls).toBe(1);
    const row=await db.prepare('SELECT master_profile,profile_version FROM users WHERE id=1').first<any>();expect(JSON.parse(row!.master_profile)).toEqual(before.master_profile);expect(row!.profile_version).toBe(1);
  });
});
