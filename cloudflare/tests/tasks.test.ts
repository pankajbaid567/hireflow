import { applyTestMigrations } from './migrations';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
let bundle: string;
let runtime: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
let files: Awaited<ReturnType<Miniflare['getR2Bucket']>>;

// Only external browser/LLM work is replaced. The actual task functions, SQL
// claims, D1 audit triggers, R2 reads and durable outbox execute in workerd.
const harness = `
import { processTask, scheduledRecovery } from '../src/tasks';
export default {
  async fetch(request, env) {
    const control = await env.DB.prepare('SELECT * FROM test_controls WHERE id=1').first();
    const queue = { async send(body) {
      await env.DB.prepare('INSERT INTO test_queue_sends(body,accepted) VALUES(?,?)').bind(JSON.stringify(body), control.queue_error ? 0 : 1).run();
      if (control.queue_error) throw new Error('Synthetic queue outage');
    } };
    const settings = { ...env, APPLICATION_QUEUE: queue, BROWSER_ENABLED: control.browser_enabled, BROWSER_DAILY_BUDGET_SECONDS: control.budget };
    if (new URL(request.url).pathname === '/recover') {
      await scheduledRecovery(settings);
      return Response.json({ recovered: true });
    }
    let acknowledged = false, retry = null;
    await processTask(settings, {
      body: await request.json(), attempts: 1, timestamp: new Date(), id: 'fixture-message',
      ack() { acknowledged = true; }, retry(options) { retry = options || {}; },
    });
    return Response.json({ acknowledged, retry });
  },
};`;

beforeAll(async () => {
  const output = await build({
    stdin: { contents: harness, resolveDir: `${root}tests`, sourcefile: 'tasks-test-runtime.ts', loader: 'js' },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent',
    plugins: [{
      name: 'synthetic-external-work',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/(automation|intelligence)$/ }, args => ({ path: args.path, namespace: 'task-fixtures' }));
        builder.onLoad({ filter: /.*/, namespace: 'task-fixtures' }, args => ({ loader: 'js', contents: args.path === './automation' ? `
          export async function fillApplication(input, env) {
            await env.DB.prepare('INSERT INTO test_browser_calls(application_url,resume_name,resume_size,profile,jd) VALUES(?,?,?,?,?)').bind(input.applicationUrl,input.resumeName,input.resume.length,JSON.stringify(input.profile),input.jdText).run();
            const control = await env.DB.prepare('SELECT * FROM test_controls WHERE id=1').first();
            if (control.browser_error) throw new Error('Synthetic private-provider-error');
            return JSON.parse(control.result);
          }` : `
          export async function generateText() { return 'A truthful fixture answer'; }
          export async function buildPrepGuide(env, profile, application) {
            await env.DB.prepare('INSERT INTO test_prep_calls(application_id) VALUES(?)').bind(application.id).run();
            const control = await env.DB.prepare('SELECT * FROM test_controls WHERE id=1').first();
            if (control.prep_error) throw new Error('Synthetic research outage');
            return { round_count: 2, rounds: [{number:1,type:'technical',focus:'Python'}], topics: {strong:['Python'],moderate:[],gaps:['Docker']}, questions:[{category:'technical',question:'Show a Python example'}], resources:{}, company_intel:{stage:'startup'} };
          }`, }));
      },
    }],
  });
  bundle = output.outputFiles[0].text;
}, 30000);

beforeEach(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['FILES'],
  }));
  db = await runtime.getD1Database('DB');
  files = await runtime.getR2Bucket('FILES');
  await applyTestMigrations(db);
  await db.batch([
    db.prepare(`CREATE TABLE test_controls(id INTEGER PRIMARY KEY,result TEXT,browser_error INTEGER DEFAULT 0,prep_error INTEGER DEFAULT 0,queue_error INTEGER DEFAULT 0,browser_enabled TEXT DEFAULT 'true',budget TEXT DEFAULT '540')`),
    db.prepare('CREATE TABLE test_browser_calls(id INTEGER PRIMARY KEY,application_url TEXT,resume_name TEXT,resume_size INTEGER,profile TEXT,jd TEXT)'),
    db.prepare('CREATE TABLE test_prep_calls(id INTEGER PRIMARY KEY,application_id INTEGER)'),
    db.prepare('CREATE TABLE test_queue_sends(id INTEGER PRIMARY KEY,body TEXT,accepted INTEGER)'),
  ]);
  await db.prepare('INSERT INTO test_controls(id,result) VALUES(1,?)').bind(JSON.stringify({ status: 'applied', reason: null, fields_filled: ['name', 'email', 'resume'], submitted: true, retryable: false })).run();
  await db.prepare('INSERT INTO users(id,name,email,mode,master_profile) VALUES(1,?,?,?,?)').bind('Test User', 'tasks@example.com', 'internship', JSON.stringify({ name: 'Test User', email: 'tasks@example.com', skills: ['Python'] })).run();
}, 30000);

afterEach(async () => { await runtime?.dispose(); }, 30000);

async function controls(values: Record<string, string | number>) {
  const columns = Object.keys(values);
  await db.prepare(`UPDATE test_controls SET ${columns.map(column => `${column}=?`).join(',')} WHERE id=1`).bind(...columns.map(column => values[column])).run();
}
async function application(id = 1, options: { status?: string; attempts?: number; started?: string | null; resume?: boolean; jobId?: number } = {}) {
  const jobId = options.jobId || id + 100;
  await db.prepare('INSERT INTO jobs(id,title,company,url,description,listing_type) VALUES(?,?,?,?,?,?)').bind(jobId, 'Python Intern', `Company ${id}`, `https://careers.example.com/${id}`, 'Python and Docker internship', 'internship').run();
  const key = options.resume === false ? null : `resumes/1/${jobId}_resume_v1.pdf`;
  if (key) await files.put(key, '%PDF-1.4\nSynthetic reviewed resume');
  await db.prepare('INSERT INTO applications(id,user_id,job_id,status,attempts,processing_started_at,resume_path,resume_version) VALUES(?,1,?,?,?,?,?,1)').bind(id, jobId, options.status || 'confirmed', options.attempts || 0, options.started || null, key).run();
  return id;
}
async function row(id = 1) { return db.prepare('SELECT * FROM applications WHERE id=?').bind(id).first<any>(); }
async function count(table: string) { return (await db.prepare(`SELECT count(*) AS count FROM ${table}`).first<any>())!.count as number; }
async function process(id = 1, kind = 'apply') {
  return delivery({ application_id: id, kind });
}
async function delivery(body: unknown) {
  const response = await runtime.dispatchFetch('https://tasks.example/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ acknowledged: boolean; retry: { delaySeconds?: number } | null }>;
}
async function recover() {
  const response = await runtime.dispatchFetch('https://tasks.example/recover');
  expect(response.status).toBe(200);
}
async function reserve(seconds: number, lastLaunch = 0, day = new Date().toISOString().slice(0, 10)) {
  await db.prepare('INSERT INTO browser_budget(day,reserved_seconds,last_launch_at) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET reserved_seconds=excluded.reserved_seconds,last_launch_at=excluded.last_launch_at').bind(day, seconds, lastLaunch).run();
}
async function acceptedQueueTasks() {
  return (await db.prepare('SELECT body FROM test_queue_sends WHERE accepted=1 ORDER BY id').all<any>()).results.map(item => JSON.parse(item.body));
}

describe('browser allocation and atomic free-tier limits', () => {
  it('records a successful attempt, applied timestamp, audit and durable prep delivery', async () => {
    await application();
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'applied', attempts: 1, failure_reason: null });
    expect((await row()).applied_at).toBeTruthy();
    const events = await db.prepare('SELECT status FROM application_status_events WHERE application_id=1 ORDER BY id').all<any>();
    expect(events.results.map(event => event.status)).toEqual(['confirmed', 'applying', 'applied']);
    const call = await db.prepare('SELECT * FROM test_browser_calls').first<any>();
    expect(call).toMatchObject({ application_url: 'https://careers.example.com/1', resume_name: '101_resume_v1.pdf', jd: 'Python and Docker internship' });
    expect(call.resume_size).toBeGreaterThan(5);
    expect(JSON.parse(call.profile).skills).toEqual(['Python']);
    expect(await acceptedQueueTasks()).toEqual([{ application_id: 1, kind: 'prep' }]);
  });

  it('requires manual action when browser automation is disabled', async () => {
    await application(); await controls({ browser_enabled: 'false' });
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'needs_action', attempts: 0, manual_action_url: 'https://careers.example.com/1' });
    expect((await row()).failure_reason).toContain('disabled');
    expect(await count('test_browser_calls')).toBe(0);
    expect(await count('browser_budget')).toBe(0);
  });

  it.each([540, 510])('does not acquire a browser when %i seconds are already reserved', async seconds => {
    await application(); await reserve(seconds);
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'needs_action', attempts: 0, manual_action_url: 'https://careers.example.com/1' });
    expect((await row()).failure_reason).toContain('Daily browser budget reached');
    expect(await count('test_browser_calls')).toBe(0);
    expect(await acceptedQueueTasks()).toEqual([{ application_id: 1, kind: 'prep' }]);
  });

  it.each(['0', '59', '-1', 'not-a-number'])('honors a restricted or invalid configured budget %s', async budget => {
    await application(); await controls({ budget });
    await process();
    expect((await row()).status).toBe('needs_action');
    expect(await count('test_browser_calls')).toBe(0);
  });

  it('cannot raise the hard 540 second cap with a larger configured value', async () => {
    await application(); await controls({ budget: '999999' }); await reserve(540);
    await process();
    expect((await row()).status).toBe('needs_action');
    expect(await count('test_browser_calls')).toBe(0);
  });

  it('uses the final full reservation once and refuses the next application', async () => {
    await application(1); await application(2); await reserve(480);
    await process(1); await process(2);
    expect((await row(1)).status).toBe('applied');
    expect((await row(2)).status).toBe('needs_action');
    expect((await row(2)).attempts).toBe(0);
    expect(await count('test_browser_calls')).toBe(1);
    expect((await db.prepare('SELECT reserved_seconds FROM browser_budget').first<any>()).reserved_seconds).toBe(540);
  });

  it('delays a launch inside the spacing window without consuming an attempt or reservation', async () => {
    await application(); await reserve(60, Date.now());
    expect(await process()).toEqual({ acknowledged: false, retry: { delaySeconds: 25 } });
    expect(await row()).toMatchObject({ status: 'confirmed', attempts: 0 });
    expect((await db.prepare('SELECT reserved_seconds FROM browser_budget').first<any>()).reserved_seconds).toBe(60);
    expect(await count('test_browser_calls')).toBe(0);
    expect(await count('outbox')).toBe(0);
  });

  it('admits only one simultaneous launch using actual atomic D1 reservations', async () => {
    await application(1); await application(2);
    const messages = await Promise.all([process(1), process(2)]);
    expect(messages.filter(message => message.acknowledged)).toHaveLength(1);
    expect(messages.filter(message => message.retry?.delaySeconds === 25)).toHaveLength(1);
    expect(await count('test_browser_calls')).toBe(1);
    expect((await db.prepare('SELECT reserved_seconds FROM browser_budget').first<any>()).reserved_seconds).toBe(60);
    const states = (await db.prepare('SELECT status,attempts FROM applications ORDER BY id').all<any>()).results;
    expect(states.filter(state => state.status === 'applied' && state.attempts === 1)).toHaveLength(1);
    expect(states.filter(state => state.status === 'confirmed' && state.attempts === 0)).toHaveLength(1);
  });
});

describe('safe retries and terminal states', () => {
  it('retries only pre-click temporary failures with 40/80 second backoff and stops at attempt three', async () => {
    await application();
    await controls({ result: JSON.stringify({ status: 'failed', reason: 'Temporary network failure', fields_filled: [], submitted: false, retryable: true }) });
    expect(await process()).toEqual({ acknowledged: false, retry: { delaySeconds: 40 } });
    expect(await row()).toMatchObject({ status: 'confirmed', attempts: 1 });
    await db.prepare('UPDATE browser_budget SET last_launch_at=0').run();
    expect(await process()).toEqual({ acknowledged: false, retry: { delaySeconds: 80 } });
    expect(await row()).toMatchObject({ status: 'confirmed', attempts: 2 });
    await db.prepare('UPDATE browser_budget SET last_launch_at=0').run();
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'failed', attempts: 3, failure_reason: 'Temporary network failure' });
    expect(await count('test_browser_calls')).toBe(3);
    expect(await acceptedQueueTasks()).toEqual([{ application_id: 1, kind: 'prep' }]);
  });

  it('never retries a clicked submission even if an adapter marks it retryable', async () => {
    await application();
    await controls({ result: JSON.stringify({ status: 'needs_action', reason: 'Submission could not be confirmed', fields_filled: ['resume'], submitted: true, retryable: true }) });
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'needs_action', attempts: 1, failure_reason: 'Submission could not be confirmed', manual_action_url: 'https://careers.example.com/1' });
    await process();
    expect(await count('test_browser_calls')).toBe(1);
  });

  it('persists a manual ATS URL and specific reason without retrying an expired or unsupported listing', async () => {
    await application();
    const reason = 'The employer requires account sign-in or registration. Open the application and continue manually.';
    await controls({ result: JSON.stringify({ status: 'needs_action', reason, fields_filled: [], submitted: false, retryable: false, manual_action_url: 'https://ats.example.com/candidate/login' }) });
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'needs_action', attempts: 1, failure_reason: reason, manual_action_url: 'https://ats.example.com/candidate/login' });
    const event = await db.prepare('SELECT status,reason FROM application_status_events WHERE application_id=1 ORDER BY id DESC LIMIT 1').first<any>();
    expect(event).toEqual({ status: 'needs_action', reason });
    await process();
    expect(await count('test_browser_calls')).toBe(1);
    expect(await acceptedQueueTasks()).toEqual([{ application_id: 1, kind: 'prep' }]);
  });

  it('stores a permanent selector failure after one attempt', async () => {
    await application();
    await controls({ result: JSON.stringify({ status: 'failed', reason: 'Application form selector not found', fields_filled: [], submitted: false, retryable: false }) });
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'failed', attempts: 1, failure_reason: 'Application form selector not found' });
    expect(await count('test_browser_calls')).toBe(1);
  });

  it('records missing reviewed PDFs without calling browser automation', async () => {
    await application(1, { resume: false });
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'failed', attempts: 0, failure_reason: 'Reviewed resume PDF is missing' });
    expect(await count('test_browser_calls')).toBe(0);
    expect(await count('browser_budget')).toBe(0);
  });

  it('waits for a recently written resume to become visible without claiming an attempt or browser budget', async () => {
    await application();
    const key = (await row()).resume_path;
    await files.delete(key);
    await db.prepare('INSERT INTO resumes(application_id,version,object_key) VALUES(1,1,?)').bind(key).run();

    expect(await process()).toEqual({ acknowledged: false, retry: { delaySeconds: 60 } });
    expect(await row()).toMatchObject({ status: 'confirmed', attempts: 0, processing_started_at: null, failure_reason: null });
    expect(await count('browser_budget')).toBe(0);
    expect(await count('test_browser_calls')).toBe(0);
    expect(await count('outbox')).toBe(0);
    const events = await db.prepare('SELECT status FROM application_status_events WHERE application_id=1 ORDER BY id').all<any>();
    expect(events.results.map(event => event.status)).toEqual(['confirmed']);

    await files.put(key, '%PDF-1.4\nReviewed resume now visible');
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'applied', attempts: 1 });
    expect(await count('test_browser_calls')).toBe(1);
    expect((await db.prepare('SELECT reserved_seconds FROM browser_budget').first<any>()).reserved_seconds).toBe(60);
    expect(await acceptedQueueTasks()).toEqual([{ application_id: 1, kind: 'prep' }]);
  });

  it('fails a missing resume after its visibility grace period without consuming browser budget', async () => {
    await application();
    const key = (await row()).resume_path;
    await files.delete(key);
    await db.prepare('INSERT INTO resumes(application_id,version,object_key,created_at) VALUES(1,1,?,?)').bind(key, '2000-01-01T00:00:00.000Z').run();

    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'failed', attempts: 0, failure_reason: 'Reviewed resume PDF is missing', processing_started_at: null });
    expect(await count('browser_budget')).toBe(0);
    expect(await count('test_browser_calls')).toBe(0);
    expect(await acceptedQueueTasks()).toEqual([{ application_id: 1, kind: 'prep' }]);
  });

  it('does not extend the storage grace period using a different resume object', async () => {
    await application();
    await files.delete((await row()).resume_path);
    await db.prepare('INSERT INTO resumes(application_id,version,object_key) VALUES(1,1,?)').bind('resumes/1/a-different-reviewed-artifact.pdf').run();

    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'failed', attempts: 0, failure_reason: 'Reviewed resume PDF is missing' });
    expect(await count('browser_budget')).toBe(0);
    expect(await count('test_browser_calls')).toBe(0);
  });

  it('converts an unexpected automation exception into manual review without exposing its body', async () => {
    await application(); await controls({ browser_error: 1 });
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect((await row()).status).toBe('needs_action');
    expect((await row()).failure_reason).toContain('Check the employer site');
    expect((await row()).failure_reason).not.toContain('private-provider-error');
  });

  it('waits for a recent applying worker instead of racing it', async () => {
    await application(1, { status: 'applying', attempts: 1, started: new Date().toISOString() });
    expect(await process()).toEqual({ acknowledged: false, retry: { delaySeconds: 120 } });
    expect(await row()).toMatchObject({ status: 'applying', attempts: 1 });
    expect(await count('test_browser_calls')).toBe(0);
    expect(await count('browser_budget')).toBe(0);
  });

  it('marks an interrupted applying worker for manual review without resubmission', async () => {
    await application(1, { status: 'applying', attempts: 2, started: new Date(Date.now() - 6 * 60000).toISOString() });
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await row()).toMatchObject({ status: 'needs_action', attempts: 2, manual_action_url: 'https://careers.example.com/1' });
    expect((await row()).failure_reason).toContain('avoid duplicate submission');
    expect(await count('test_browser_calls')).toBe(0);
  });

  it.each(['applied', 'failed', 'needs_action', 'planned', 'pending'])('does not submit duplicate or unconfirmed status %s', async status => {
    await application(1, { status });
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect((await row()).status).toBe(status);
    expect(await count('test_browser_calls')).toBe(0);
    expect(await count('browser_budget')).toBe(0);
  });

  it.each([null, { application_id: 1, kind: 'unexpected' }, { application_id: 1.5, kind: 'apply' }, { application_id: 999, kind: 'apply' }])('acknowledges an invalid or missing application task cleanly: %j', async body => {
    expect(await delivery(body)).toEqual({ acknowledged: true, retry: null });
    expect(await count('test_browser_calls')).toBe(0);
  });
});

describe('prep idempotency and durable recovery', () => {
  it('persists a prep guide and acknowledges duplicate deliveries without generating again', async () => {
    await application(1, { status: 'applied' });
    expect(await process(1, 'prep')).toEqual({ acknowledged: true, retry: null });
    expect(await process(1, 'prep')).toEqual({ acknowledged: true, retry: null });
    const guide = await db.prepare('SELECT * FROM prep_guides WHERE application_id=1').first<any>();
    expect(JSON.parse(guide.structured_data).topics.gaps).toEqual(['Docker']);
    expect(JSON.parse(guide.company_intel)).toEqual({ stage: 'startup' });
    expect(await count('test_prep_calls')).toBe(1);
    expect(await count('test_browser_calls')).toBe(0);
  });

  it('retries a failed prep build without leaving an incomplete guide', async () => {
    await application(); await controls({ prep_error: 1 });
    expect(await process(1, 'prep')).toEqual({ acknowledged: false, retry: { delaySeconds: 60 } });
    expect(await count('prep_guides')).toBe(0);
    expect(await count('test_browser_calls')).toBe(0);
  });

  it('keeps queue failures in the outbox and dispatches them once service recovers', async () => {
    await application(1, { status: 'applied' }); await controls({ queue_error: 1 });
    expect(await process()).toEqual({ acknowledged: true, retry: null });
    expect(await db.prepare('SELECT dispatched_at FROM outbox WHERE application_id=1').first<any>()).toEqual({ dispatched_at: null });
    expect(await acceptedQueueTasks()).toEqual([]);
    await controls({ queue_error: 0 });
    await recover(); await recover();
    expect((await db.prepare('SELECT dispatched_at FROM outbox WHERE application_id=1').first<any>()).dispatched_at).toBeTruthy();
    expect(await acceptedQueueTasks()).toEqual([{ application_id: 1, kind: 'prep' }]);
    expect(await count('test_queue_sends')).toBe(2);
    expect(await count('test_browser_calls')).toBe(0);
  });

  it('recovers the application ID rather than the joined job ID, leaving recent workers alone', async () => {
    await application(17, { jobId: 1801, status: 'applying', attempts: 2, started: new Date(Date.now() - 6 * 60000).toISOString() });
    await application(18, { jobId: 1802, status: 'applying', attempts: 1, started: new Date().toISOString() });
    await recover();
    expect(await row(17)).toMatchObject({ status: 'needs_action', attempts: 2, manual_action_url: 'https://careers.example.com/17' });
    expect((await row(18)).status).toBe('applying');
    expect(await acceptedQueueTasks()).toEqual([{ application_id: 17, kind: 'prep' }]);
    const event = await db.prepare('SELECT * FROM application_status_events WHERE application_id=17 ORDER BY id DESC LIMIT 1').first<any>();
    expect(event.status).toBe('needs_action');
    expect(event.reason).toContain('interrupted');
    expect(await count('test_browser_calls')).toBe(0);
  });

  it('redelivers old apply outbox messages only for still-confirmed applications', async () => {
    await application(1); await application(2, { status: 'applied' });
    const old = new Date(Date.now() - 2 * 3600000).toISOString();
    await db.prepare("INSERT INTO outbox(application_id,kind,dispatched_at) VALUES(1,'apply',?),(2,'apply',?)").bind(old, old).run();
    await recover();
    expect((await acceptedQueueTasks()).filter(task => task.kind === 'apply')).toEqual([{ application_id: 1, kind: 'apply' }]);
    expect((await db.prepare("SELECT dispatched_at FROM outbox WHERE application_id=2 AND kind='apply'").first<any>()).dispatched_at).toBe(old);
    expect((await row(1)).status).toBe('confirmed');
    expect(await count('test_browser_calls')).toBe(0);
  });

  it('does not redeliver old prep messages after the guide has been saved', async () => {
    await application(1, { status: 'applied' });
    const old = new Date(Date.now() - 2 * 3600000).toISOString();
    await db.prepare("INSERT INTO prep_guides(application_id,structured_data) VALUES(1,'{}')").run();
    await db.prepare("INSERT INTO outbox(application_id,kind,dispatched_at) VALUES(1,'prep',?)").bind(old).run();
    await recover();
    expect(await acceptedQueueTasks()).toEqual([]);
    expect(await count('test_prep_calls')).toBe(0);
  });
});
