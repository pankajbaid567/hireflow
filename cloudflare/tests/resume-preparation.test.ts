import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from './migrations';
import { addJobs, getPlan } from '../src/plans';
import type { Env } from '../src/types';

// These tests exercise real plan SQL/R2 and provider timing in Node. Browser
// launch is never part of draft preparation and stays in its Worker tests.
vi.mock('@cloudflare/playwright', () => ({ launch: vi.fn() }));

let mf: Miniflare, env: Env;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
const profile = {
  name: 'Synthetic Candidate', email: 'synthetic@example.com', mode: 'internship', skills: ['Python', 'SQL'],
  projects: [
    { name: 'Data Explorer', description: 'Built Python dashboards for public datasets.', tech: ['Python', 'SQL'] },
    { name: 'Task Planner', description: 'Built a searchable task planner for coursework.', tech: ['Python'] },
    { name: 'Archive Search', description: 'Indexed public archives with SQL search.', tech: ['SQL'] },
  ],
};
const selection = { summary_fact_ids: ['project:0:fact:0'], project_indices: [0, 2] };
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(selection) } }] }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-10-21', d1Databases: ['DB'], r2Buckets: ['FILES'] }));
  db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('FILES');
  await applyTestMigrations(db);
  env = { DB: db, FILES: bucket, GROQ_API_KEY: 'not-a-real-key', GROQ_MODEL: 'test-model' } as unknown as Env;
  await db.prepare('INSERT INTO users(name,email,mode,weekly_quota,master_profile) VALUES(?,?,?,3,?)').bind(profile.name, profile.email, profile.mode, JSON.stringify(profile)).run();
  await addJobs(env, 1, [{ title: 'Python Data Intern', company: 'Synthetic Co', description: 'Python and SQL data analysis.', url: 'https://example.com/apply/1', listing_type: 'internship' }]);
}, 30000);
afterEach(async () => { vi.unstubAllGlobals(); await mf?.dispose(); }, 30000);

describe('atomic resume preparation and provenance', () => {
  it('shares an active lease across concurrent polls and caches the exact reviewed provenance', async () => {
    const entered = deferred<void>(), pending = deferred<Response>();
    const fetcher = vi.fn(() => { entered.resolve(); return pending.promise; }); vi.stubGlobal('fetch', fetcher);
    const first = getPlan(env, 1); await entered.promise;
    const parallel = await getPlan(env, 1);
    expect(parallel.preparing).toBe(true); expect(parallel.plan[0].resume_url).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    pending.resolve(reply()); const completed = await first;
    expect(completed.preparing).toBe(false);
    expect(completed.plan[0].resume_tailoring).toMatchObject({ method: 'llm_grounded', model: 'test-model', profile_version: 1, ...selection });
    expect(completed.plan[0].resume_summary).toContain('Built Python dashboards for public datasets.');
    const cached = await getPlan(env, 1);
    expect(cached.plan[0]).toEqual(completed.plan[0]); expect(fetcher).toHaveBeenCalledTimes(1);
    const resumes = await db.prepare('SELECT * FROM resumes').all<any>(); expect(resumes.results).toHaveLength(1);
    expect(JSON.parse(resumes.results[0].tailoring_metadata)).toEqual(completed.plan[0].resume_tailoring);
    expect((await bucket.list()).objects).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM resume_preparations').all()).results).toHaveLength(0);
  });

  it('attaches a bounded factual fallback with a visible warning when the provider fails', async () => {
    const fetcher = vi.fn(async () => new Response('unavailable', { status: 503 })); vi.stubGlobal('fetch', fetcher);
    const completed = await getPlan(env, 1);
    expect(completed.preparing).toBe(false);
    expect(completed.plan[0].resume_tailoring).toMatchObject({ method: 'deterministic', model: null, reason: 'provider_unavailable' });
    expect(completed.warnings.join(' ')).toContain('Automatic summary tailoring was unavailable');
    expect(completed.plan[0].resume_summary).not.toContain('unavailable');
    await getPlan(env, 1); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never attaches old facts after a profile edit or deletes a newer preparation lease', async () => {
    const entered = [deferred<void>(), deferred<void>()], pending = [deferred<Response>(), deferred<Response>()];
    let calls = 0; vi.stubGlobal('fetch', vi.fn(() => { const index = calls++; entered[index].resolve(); return pending[index].promise; }));
    const oldRequest = getPlan(env, 1); await entered[0].promise;
    const edited = { ...profile, projects: [{ ...profile.projects[0], description: 'Built Python dashboards with verified chart exports.' }, ...profile.projects.slice(1)] };
    await db.prepare('UPDATE users SET profile_version=2,master_profile=? WHERE id=1').bind(JSON.stringify(edited)).run();
    const newRequest = getPlan(env, 1); await entered[1].promise;
    const currentLease = await db.prepare('SELECT token,profile_version FROM resume_preparations').first<any>(); expect(currentLease!.profile_version).toBe(2);
    pending[0].resolve(reply()); const outdated = await oldRequest;
    expect(outdated.preparing).toBe(true); expect(outdated.plan[0].resume_url).toBeNull();
    expect(await db.prepare('SELECT token FROM resume_preparations').first<any>()).toEqual({ token: currentLease!.token });
    expect((await db.prepare('SELECT * FROM resumes').all()).results).toHaveLength(0);
    expect((await bucket.list()).objects).toHaveLength(0);
    pending[1].resolve(reply()); const completed = await newRequest;
    expect(completed.preparing).toBe(false); expect(completed.plan[0].resume_version).toBe(2);
    expect(completed.plan[0].resume_summary).toContain('verified chart exports');
    expect(completed.plan[0].resume_tailoring!.profile_version).toBe(2);
    expect((await bucket.list()).objects).toHaveLength(1);
  });

  it('reclaims expired leases and rejects the displaced result from the same profile version', async () => {
    const entered = [deferred<void>(), deferred<void>()], pending = [deferred<Response>(), deferred<Response>()];
    let calls = 0; vi.stubGlobal('fetch', vi.fn(() => { const index = calls++; entered[index].resolve(); return pending[index].promise; }));
    const first = getPlan(env, 1); await entered[0].promise;
    await db.prepare("UPDATE resume_preparations SET expires_at='2000-01-01T00:00:00.000Z'").run();
    const replacement = getPlan(env, 1); await entered[1].promise;
    const current = await db.prepare('SELECT token FROM resume_preparations').first<any>();
    pending[0].resolve(reply()); await first;
    expect(await db.prepare('SELECT token FROM resume_preparations').first<any>()).toEqual(current);
    expect((await db.prepare('SELECT * FROM resumes').all()).results).toHaveLength(0);
    pending[1].resolve(reply()); const completed = await replacement;
    expect(completed.plan[0].resume_version).toBe(2);
    expect((await db.prepare('SELECT * FROM resumes').all()).results).toHaveLength(1);
  });

  it('prepares only one new provider draft per request while preserving remaining work for polling', async () => {
    await addJobs(env, 1, [{ title: 'Python Intern', company: 'Other Co', description: 'Python SQL reporting.', url: 'https://example.com/apply/2', listing_type: 'internship' }]);
    const fetcher = vi.fn(async () => reply()); vi.stubGlobal('fetch', fetcher);
    const first = await getPlan(env, 1); expect(first.preparing).toBe(true); expect(first.plan.filter(a => a.resume_url)).toHaveLength(1); expect(fetcher).toHaveBeenCalledTimes(1);
    const second = await getPlan(env, 1); expect(second.preparing).toBe(false); expect(second.plan.every(a => a.resume_url)).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not increment a version or call a provider while another unexpired lease owns the draft', async () => {
    await db.prepare('INSERT INTO resume_preparations(application_id,profile_version,token,expires_at) VALUES(1,1,?,?)').bind('other-request', new Date(Date.now() + 60000).toISOString()).run();
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const current = await getPlan(env, 1);
    expect(current.preparing).toBe(true); expect(fetcher).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT resume_version FROM applications').first<any>())!.resume_version).toBe(0);
  });
});
