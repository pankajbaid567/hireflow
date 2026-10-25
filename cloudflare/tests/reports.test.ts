import { applyTestMigrations } from './migrations';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { emailReport, generateReport, latestReport } from '../src/reports';
import { type Env, weekStart } from '../src/types';

let mf: Miniflare, env: Env, queries: { sql: string; bindings: unknown[] }[];
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
let files: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-21', d1Databases: ['DB'], r2Buckets: ['FILES'] }));
  db = await mf.getD1Database('DB'); files = await mf.getR2Bucket('FILES'); queries = [];
  await applyTestMigrations(db);
  await db.prepare('INSERT INTO users(name,email,mode,master_profile) VALUES(?,?,?,?)').bind('Test <Owner>', 'owner@example.com', 'job', '{}').run();
  env = { DB: { batch(statements: D1PreparedStatement[]) { return db.batch(statements); }, prepare(sql: string) {
    const entry = { sql, bindings: [] as unknown[] }; queries.push(entry);
    const statement = db.prepare(sql);
    return { bind(...values: any[]) { entry.bindings = values; return statement.bind(...values); } };
  } }, FILES: files, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'mock-provider-key', FROM_EMAIL: 'report@example.org', PUBLIC_BASE_URL: 'https://dashboard.example/api' } as unknown as Env;
}, 30000);
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await mf?.dispose(); }, 30000);

async function application(id: number, options: { status?: string; score?: number; matched?: string[]; gaps?: string[]; cycle?: string; size?: number; company?: string } = {}) {
  await db.prepare('INSERT INTO jobs(id,title,company,url,description,listing_type) VALUES(?,?,?,?,?,?)').bind(id, 'Engineer', options.company || 'Example', `https://example.org/jobs/${id}`, 'Rust only. This deliberately differs from the cached skill evidence.', 'job').run();
  await db.prepare('INSERT INTO applications(id,user_id,job_id,status,match_score,matched_skills,skill_gaps,cycle_start,created_at,resume_path,resume_version,failure_reason,manual_action_url) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?)').bind(id, id, options.status || 'planned', options.score ?? 0.75, JSON.stringify(options.matched || []), JSON.stringify(options.gaps || []), options.cycle || weekStart(), '2000-01-01T00:00:00.000Z', options.size ? `resumes/1/${id}.pdf` : null, 1, options.status === 'needs_action' ? 'CAPTCHA detected' : null, options.status === 'needs_action' ? `https://example.org/jobs/${id}` : null).run();
  if (options.size) { const bytes = new Uint8Array(options.size); bytes.set(new TextEncoder().encode('%PDF-1.4\n')); await files.put(`resumes/1/${id}.pdf`, bytes); }
}

describe('bounded weekly reports with real isolated D1 and R2', () => {
  it('aggregates each cached JD skill once, excludes historical applications, and filters guide lookup to this report', async () => {
    await application(1, { status: 'applied', score: 0.9, matched: ['Python', 'Python'], gaps: ['Python', 'Docker', 'Docker'], company: '<script>alert(1)</script>' });
    await application(2, { status: 'needs_action', score: 0.6, matched: ['Python'], gaps: ['Docker', 'TypeScript'] });
    await application(3, { cycle: '2000-01-03', matched: ['Rust'] });
    await db.batch([db.prepare('INSERT INTO prep_guides(application_id,structured_data) VALUES(1,\'{}\')'), db.prepare('INSERT INTO prep_guides(application_id,structured_data) VALUES(3,\'{}\')')]);
    const report = await generateReport(env, 1);
    expect(report.applied_count).toBe(1); expect(report.avg_match_score).toBeCloseTo(0.75);
    expect(report.metrics.top_skills).toEqual([{ skill: 'Docker', frequency: 2 }, { skill: 'Python', frequency: 2 }, { skill: 'TypeScript', frequency: 1 }]);
    expect(report.metrics.study_plan).toEqual([{ skill: 'Docker', frequency: 2 }, { skill: 'Python', frequency: 1 }, { skill: 'TypeScript', frequency: 1 }]);
    expect(report.content.applications).toHaveLength(2); expect(report.content.applications[0].prep_guide_url).toBe('/applications/1/prep-guide'); expect(report.content.applications[1].prep_guide_url).toBeNull();
    const sourceQuery = queries.find(query => query.sql.includes('JOIN jobs'))!;
    expect(sourceQuery.sql).not.toContain('description');
    const guideQuery = queries.find(query => query.sql.includes('FROM prep_guides'))!;
    expect(guideQuery.sql).toContain('json_each'); expect(JSON.parse(String(guideQuery.bindings[0]))).toEqual([1, 2]);
    const html = await (await files.get(report.html_path))!.text();
    expect(html).toContain('href="https://dashboard.example/applications/1/prep-guide"');
    expect(html).not.toContain('Prep guide JSON');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('CAPTCHA detected'); expect(html).toContain('check whether it was already submitted');
  });

  it('returns finite empty-week metrics and safely upserts a regenerated report', async () => {
    const first = await generateReport(env, 1); const second = await generateReport(env, 1);
    expect(second).toEqual(await latestReport(env,1));
    expect(second.id).toBe(first.id); expect(second.avg_match_score).toBe(0); expect(second.applied_count).toBe(0);
    expect(second.content.applications).toEqual([]); expect(second.metrics.top_skills).toEqual([]); expect(second.metrics.study_plan).toEqual([]);
    expect((await db.prepare('SELECT count(*) AS n FROM weekly_reports').first<any>())!.n).toBe(1);
  });

  it('keeps email encoding under 128 KiB and includes authenticated links for larger PDFs', async () => {
    await application(1, { size: 100 * 1024 }); await application(2, { size: 60 * 1024 }); await application(3, { size: 10 * 1024 });
    await generateReport(env, 1); let sent: any;
    const fetch = vi.fn(async (url: string, init: RequestInit) => { expect(url).toBe('https://api.resend.com/emails'); sent = JSON.parse(String(init.body)); return new Response('{}', { status: 200 }); });
    vi.stubGlobal('fetch', fetch);
    expect(await emailReport(env, 1)).toEqual({ status: 'sent', attachments: 2, linked_resumes: 1 });
    expect(sent.attachments.map((item: any) => item.filename)).toEqual(['1_resume_v1.pdf', '3_resume_v1.pdf']);
    expect(sent.attachments.reduce((total: number, item: any) => total + atob(item.content).length, 0)).toBe(110 * 1024);
    expect(sent.html).toContain('https://dashboard.example/api/resumes/1/2/download'); expect(sent.html).toContain('sign in to download');
    expect(sent.html).not.toContain('resumes/1/2.pdf'); expect(fetch).toHaveBeenCalledTimes(1);
    const row = await db.prepare('SELECT email_sent_at,email_failure_reason FROM weekly_reports').first<any>(); expect(Date.parse(row!.email_sent_at)).toBeGreaterThan(0); expect(row!.email_failure_reason).toBeNull();
  });

  it('attaches ten ordinary PDFs through the configurable SendGrid provider', async () => {
    for (let id = 1; id <= 11; id++) await application(id, { size: 4096 });
    await generateReport(env, 1); env.EMAIL_PROVIDER = 'sendgrid'; env.SENDGRID_API_KEY = 'mock-sendgrid-key'; let payload: any;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { expect(url).toBe('https://api.sendgrid.com/v3/mail/send'); payload = JSON.parse(String(init.body)); return new Response(null, { status: 202 }); }));
    expect(await emailReport(env, 1)).toEqual({ status: 'sent', attachments: 10, linked_resumes: 0 });
    expect(payload.personalizations).toEqual([{ to: [{ email: 'owner@example.com' }] }]); expect(payload.content[0].type).toBe('text/html'); expect(payload.attachments).toHaveLength(10);
    expect(payload.attachments.every((item: any) => item.type === 'application/pdf' && item.disposition === 'attachment' && atob(item.content).startsWith('%PDF-'))).toBe(true);
  });

  it('records a safe failure reason when email delivery is unconfirmed', async () => {
    await generateReport(env, 1);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('mock-provider-key private error body', { status: 503 })));
    await expect(emailReport(env, 1)).rejects.toThrow('Email provider did not confirm delivery');
    const row = await db.prepare('SELECT email_sent_at,email_failure_reason FROM weekly_reports').first<any>();
    expect(row!.email_sent_at).toBeNull(); expect(row!.email_failure_reason).toBe('Email provider did not confirm delivery'); expect(row!.email_failure_reason).not.toContain('mock-provider-key');
  });
});
