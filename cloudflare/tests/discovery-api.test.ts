import { applyTestMigrations } from './migrations';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const access = 'discovery-test-private-owner-access-code';
const description = 'Work on Python and LangChain APIs in a supervised engineering internship. Write unit tests, investigate data issues, document the interface, and complete one scoped delivery project.';
let bundle: string, mf: Miniflare, cookie: string, userId: number, providerStatus: number;
beforeAll(() => { bundle = buildSync({ entryPoints: [`${root}src/index.ts`], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text; });
async function request(path: string) { return mf.dispatchFetch(`https://worker.example${path}`, { method: 'POST', headers: { Cookie: cookie } }); }
beforeEach(async () => {
  providerStatus = 200;
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], kvNamespaces: ['FILES_KV'], queueProducers: { APPLICATION_QUEUE: 'discovery' }, bindings: { ACCESS_CODE: access, TAVILY_API_KEY: 'mock-provider-key', BROWSER_ENABLED: 'false' }, outboundService: request => {
    if (new URL(request.url).hostname === 'api.tavily.com') return Response.json({ results: [{ title: 'AI Engineer Intern at Actual Co', url: 'https://wellfound.com/jobs/123-active-intern', content: description }], error: providerStatus === 200 ? undefined : 'private error detail mock-provider-key' }, { status: providerStatus });
    return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'AI Engineer Intern', hiringOrganization: { name: 'Actual Co' }, description, employmentType: 'INTERN', datePosted: new Date().toISOString() })}</script>`);
  } }));
  const db = await mf.getD1Database('DB'); await applyTestMigrations(db);
  const profile = await mf.dispatchFetch('https://worker.example/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HireFlow-Access-Code': access }, body: JSON.stringify({ name: 'Synthetic Owner', email: 'discovery@example.com', mode: 'internship', skills: ['Python'], target_roles: ['AI Engineer'] }) });
  expect(profile.status, await profile.clone().text()).toBe(201); userId = ((await profile.json()) as any).id; cookie = profile.headers.get('Set-Cookie')!.split(';')[0];
}, 30000);
afterEach(async () => { await mf?.dispose(); }, 30000);

describe('discovery API import truthfulness', () => {
  it('imports verified full JDs once and reports already-known listings without inflating additions', async () => {
    const first = await request(`/jobs/${userId}/discover`); expect(first.status, await first.clone().text()).toBe(200);
    const result = await first.json() as any;
    expect(result).toMatchObject({ imported: 1, discovered: 1, already_known: 0 });
    expect(result.sources.map((source:any)=>source.id).sort()).toEqual(['greenhouse','internshala','lever','linkedin','wellfound']);
    expect(result.sources.reduce((n:number,source:any)=>n+source.search_calls,0)).toBe(5);
    expect(result.sources.find((source:any)=>source.id==='wellfound')).toMatchObject({verified:1,status:'ok'});
    expect(result.sources.reduce((n:number,source:any)=>n+source.verified,0)).toBe(1);
    const second = await request(`/jobs/${userId}/discover`); expect(second.status).toBe(200); const duplicate = await second.json() as any;
    expect(duplicate).toMatchObject({ imported: 0, discovered: 1, already_known: 1 }); expect(duplicate.message).toContain('already in your opportunities');
    const db = await mf.getD1Database('DB'); const applications = await db.prepare('SELECT count(*) AS n FROM applications').first<any>(); expect(applications!.n).toBe(1);
    const job = await db.prepare('SELECT company,description FROM jobs').first<any>(); expect(job!.company).toBe('Actual Co'); expect(job!.description).toBe(description);
  });
  it('refreshes actual verified facts on an existing URL while manual clients cannot assert verification',async()=>{
    const url='https://wellfound.com/jobs/123-active-intern';
    let response=await mf.dispatchFetch(`https://worker.example/jobs/${userId}`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({title:'Old manual title',company:'Old Manual Company',url,description:'A manually entered Python description with a different employer and old role requirements.',listing_type:'internship',provenance:{kind:'json_ld',url}})});expect(response.status).toBe(201);
    const db=await mf.getD1Database('DB');expect(JSON.parse((await db.prepare('SELECT provenance FROM jobs').first<any>())!.provenance).kind).toBe('manual');
    const result=await (await request(`/jobs/${userId}/discover`)).json() as any;expect(result).toMatchObject({imported:0,already_known:1,discovered:1});
    const updated=await db.prepare('SELECT title,company,description,provenance FROM jobs').first<any>();expect(updated).toMatchObject({title:'AI Engineer Intern',company:'Actual Co',description});expect(JSON.parse(updated!.provenance).kind).toBe('json_ld');
  });
  it('returns an actionable sanitized provider failure without adding listings or exposing credentials', async () => {
    providerStatus = 401; const response = await request(`/jobs/${userId}/discover`); expect(response.status).toBe(503); const body = await response.text();
    expect(body).toContain('paste a current job-detail URL'); expect(body).not.toContain('mock-provider-key'); expect(body).not.toContain('private error detail');
    const failure=JSON.parse(body);expect(failure.sources).toHaveLength(5);expect(failure.sources.every((source:any)=>source.status==='unavailable'&&source.verified===0&&source.search_calls===1)).toBe(true);
    const db = await mf.getD1Database('DB'); expect((await db.prepare('SELECT count(*) AS n FROM jobs').first<any>())!.n).toBe(0);
  });
});
