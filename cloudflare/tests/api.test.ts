import { applyTestMigrations } from './migrations';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://dashboard.example';
const accessCode = 'integration-owner-code-at-least-24-characters';
let bundle: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;

async function request(path: string, options: { method?: string; body?: unknown; cookie?: string; code?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ Origin: origin, ...options.headers });
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.code) headers.set('X-HireFlow-Access-Code', options.code);
  let body: string | undefined;
  if (options.body instanceof FormData) {
    const encoded = new Request('https://upload.example', { method: 'POST', body: options.body });
    body = await encoded.text(); headers.set('Content-Type', encoded.headers.get('Content-Type')!);
  }
  else if (options.body !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(options.body); }
  return mf.dispatchFetch(`https://worker.example${path}`, { method: options.method || (body ? 'POST' : 'GET'), headers: Object.fromEntries(headers.entries()), body });
}
async function profile(email = 'owner@example.com') {
  const result = await request('/profile', { code: accessCode, body: { name: 'Test Owner', email, skills: ['Python', 'LangChain'], mode: 'internship', weekly_quota: 2 } });
  expect(result.status, await result.clone().text()).toBe(201);
  const user = await result.json() as any;
  const cookie = result.headers.get('Set-Cookie')!.split(';', 1)[0];
  return { user, cookie, setCookie: result.headers.get('Set-Cookie')! };
}
async function job(userId: number, cookie: string, suffix = 'python') {
  const result = await request(`/jobs/${userId}`, { cookie, body: { title: `AI ${suffix} Intern`, company: 'AIBridge', url: `https://example.com/careers/${suffix}`, description: 'AI internship. Python, LangChain, RAG and Docker. Two rounds: technical and HR.', listing_type: 'internship', location: 'Remote' } });
  expect(result.status, await result.clone().text()).toBeLessThan(300);
}
async function plan(userId: number, cookie: string) {
  const response = await request(`/weekly-plan/${userId}`, { cookie }); expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<any>;
}
async function reviewed(userId:number,cookie:string,items:any[]){
  const user=await (await request(`/profile/${userId}`,{cookie})).json() as any;
  const review_ids=[];
  for(const item of items){const response=await request(`/applications/${item.application_id}/review`,{cookie,body:{resume_version:item.resume_version,profile_version:user.profile_version,reviewed:true,answers:{}}});expect(response.status,await response.clone().text()).toBe(201);review_ids.push((await response.json() as any).review_id);}
  return{confirmed_job_ids:items.map(item=>item.job_id),review_ids};
}

beforeAll(() => {
  bundle = buildSync({ entryPoints: [`${root}tests/runtime.ts`], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
}, 30000);
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['FILES'], queueProducers: { APPLICATION_QUEUE: 'hireflow-applications' },
    bindings: { ACCESS_CODE: accessCode, ALLOWED_ORIGINS: origin, PUBLIC_BASE_URL: `${origin}/api`, COOKIE_SAME_SITE: 'Lax', BROWSER_ENABLED: 'false', BROWSER_DAILY_BUDGET_SECONDS: '540' },
  }));
  db = await mf.getD1Database('DB');
  await applyTestMigrations(db);
}, 30000);
afterEach(async () => { await mf?.dispose(); }, 30000);

describe('Cloudflare API with isolated D1 and R2', () => {
  it('serves health and requires an owner code before creating a profile', async () => {
    expect((await request('/health')).status).toBe(200);
    expect((await request('/session')).status).toBe(200);
    expect(await (await request('/session')).json()).toMatchObject({ authenticated: false });
    const denied = await request('/profile', { body: { name: 'Test Owner', email: 'owner@example.com', mode: 'internship' } });
    expect(denied.status).toBe(401);
    expect((await db.prepare('SELECT count(*) AS count FROM users').first<any>())!.count).toBe(0);
  });

  it('creates secure owner sessions, stores hashed tokens, and denies cross-profile access', async () => {
    const first = await profile(); const second = await profile('second@example.com');
    expect(first.setCookie).toContain('HttpOnly'); expect(first.setCookie).toContain('Secure'); expect(first.setCookie).toContain('SameSite=Lax'); expect(first.setCookie).not.toContain('Domain=');
    expect(await (await request('/session', { cookie: first.cookie })).json()).toMatchObject({ authenticated: true, user_id: first.user.id });
    expect((await request(`/profile/${first.user.id}`)).status).toBe(401);
    expect((await request(`/profile/${second.user.id}`, { cookie: first.cookie })).status).toBe(404);
    expect((await request(`/applications/${second.user.id}`, { cookie: first.cookie })).status).toBe(404);
    const token = first.cookie.split('=')[1]; const session = await db.prepare('SELECT token_hash FROM sessions WHERE user_id=?').bind(first.user.id).first<any>();
    expect(session!.token_hash).not.toBe(token); expect(session!.token_hash).toHaveLength(64);
  });

  it('recovers an existing profile by email and code and revokes the cookie on logout', async () => {
    const owner = await profile();
    const invalid = await request('/session/login', { body: { email: owner.user.email, access_code: 'incorrect' } }); expect(invalid.status).toBe(401);
    const login = await request('/session/login', { body: { email: owner.user.email, access_code: accessCode } }); expect(login.status).toBe(200);
    const cookie = login.headers.get('Set-Cookie')!.split(';', 1)[0]; expect(await login.json()).toMatchObject({ authenticated: true, user_id: owner.user.id });
    const out = await request('/session/logout', { method: 'POST', cookie }); expect(out.status).toBe(200); expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await request(`/profile/${owner.user.id}`, { cookie })).status).toBe(401);
  });

  it('stores multipart resume uploads in private R2 and rejects files over 3 MB', async () => {
    const form = new FormData();
    Object.entries({ name: 'PDF Owner', email: 'pdf@example.com', mode: 'internship', skills: '["Python"]', education: 'B.Tech, NST', weekly_quota: '2' }).forEach(([key, value]) => form.append(key, value));
    form.append('resume', new Blob(['%PDF-1.4\nA local resume fixture\n%%EOF'], { type: 'application/pdf' }), 'resume.pdf');
    const created = await request('/profile', { code: accessCode, body: form }); expect(created.status, await created.clone().text()).toBe(201);
    const owner = await created.json() as any; const bucket = await mf.getR2Bucket('FILES');
    expect(owner.master_profile.education).toBe('B.Tech, NST'); expect(await (await bucket.get(owner.master_profile.master_resume_path))!.text()).toContain('%PDF-');
    const oversized = new FormData(); oversized.append('resume', new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: 'application/pdf' }), 'large.pdf');
    const cookie = created.headers.get('Set-Cookie')!.split(';', 1)[0];
    expect((await request(`/profile/${owner.id}`, { method: 'PATCH', cookie, body: oversized })).status).toBe(413);
  });

  it('adds listings, prepares real resume PDFs, swaps the plan, and queues confirmed applications', async () => {
    const owner = await profile(); for (const suffix of ['python', 'rag', 'backend']) await job(owner.user.id, owner.cookie, suffix);
    const draft = await plan(owner.user.id, owner.cookie); expect(draft.plan).toHaveLength(2); expect(draft.alternatives).toHaveLength(1);
    const first = draft.plan[0]; const preview = await request(first.resume_url, { cookie: owner.cookie }); expect(preview.status).toBe(200); expect(preview.headers.get('Content-Type')).toContain('application/pdf'); expect(new TextDecoder().decode((await preview.arrayBuffer()).slice(0, 5))).toBe('%PDF-');
    expect((await request(first.resume_url)).status).toBe(401);
    const swapped = await request(`/weekly-plan/${owner.user.id}/swap`, { cookie: owner.cookie, body: { remove_job_id: first.job_id, add_job_id: draft.alternatives[0].job_id } }); expect(swapped.status, await swapped.clone().text()).toBe(200);
    const current = await swapped.json() as any; expect(current.plan.some((item: any) => item.job_id === draft.alternatives[0].job_id)).toBe(true);
    const confirmed = await request(`/weekly-plan/${owner.user.id}/confirm`, { cookie: owner.cookie, body:await reviewed(owner.user.id,owner.cookie,current.plan) }); expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    const rows = await db.prepare("SELECT status FROM applications WHERE user_id=? AND status='confirmed'").bind(owner.user.id).all<any>(); expect(rows.results).toHaveLength(2);
    const outbox = await db.prepare("SELECT dispatched_at FROM outbox WHERE kind='apply'").all<any>(); expect(outbox.results).toHaveLength(2); expect(outbox.results.every(row => row.dispatched_at)).toBe(true);
    const duplicate = await request(`/weekly-plan/${owner.user.id}/confirm`, { cookie: owner.cookie, body: { confirmed_job_ids: current.plan.map((item: any) => item.job_id) } }); expect(duplicate.status).toBeGreaterThanOrEqual(400);
  });

  it('records manual recovery, status history, prep guidance, and private weekly reports', async () => {
    const owner = await profile(); await job(owner.user.id, owner.cookie); const draft = await plan(owner.user.id, owner.cookie); const item = draft.plan[0];
    const payload=await reviewed(owner.user.id,owner.cookie,[item]);
    expect((await request(`/weekly-plan/${owner.user.id}/confirm`, { cookie: owner.cookie, body:payload })).status).toBe(200);
    const processed = await request('/__test/queue', { body: { application_id: item.application_id, kind: 'apply',review_id:payload.review_ids[0] } }); expect(processed.status).toBe(200); expect(await processed.json()).toMatchObject({ acknowledged: true });
    const tracker = await request(`/applications/${owner.user.id}?status=needs_action&page=1&page_size=1`, { cookie: owner.cookie }); expect(tracker.status).toBe(200); const data = await tracker.json() as any;
    expect(data.total).toBe(1); expect(data.items[0].failure_reason).toContain('disabled'); expect(data.items[0].manual_action_url).toBe('https://example.com/careers/python');
    expect(data.items[0].status_history.map((event: any) => event.status)).toEqual(expect.arrayContaining(['pending', 'planned', 'confirmed', 'needs_action']));
    await request('/__test/queue', { body: { application_id: item.application_id, kind: 'prep' } });
    const prep = await request(`/applications/${item.application_id}/prep-guide`, { cookie: owner.cookie }); expect(prep.status, await prep.clone().text()).toBe(200); const guide = await prep.json() as any;
    expect(guide.rounds.length).toBeGreaterThan(0); expect(guide.questions.length).toBeGreaterThan(0); expect(guide.warnings.length).toBeGreaterThan(0);
    const report = await request(`/report/${owner.user.id}/generate`, { cookie: owner.cookie, method: 'POST' }); expect(report.status, await report.clone().text()).toBeLessThan(300); const result = await report.json() as any; expect(result.html_url).toBeTruthy();
    const html = await request(`/report/${owner.user.id}/latest/html`, { cookie: owner.cookie }); expect(html.status).toBe(200); expect(await html.text()).toContain('AIBridge'); expect((await request(`/report/${owner.user.id}/latest/html`)).status).toBe(401);
  });
});
