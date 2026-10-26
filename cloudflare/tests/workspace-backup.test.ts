import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from './migrations';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const token = 'a'.repeat(64), otherToken = 'b'.repeat(64), master = 'uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf';
let bundle: string, source: Miniflare, destination: Miniflare | undefined, archiveReads: number;
let archive = new Map<number, Uint8Array>();
type Db = Awaited<ReturnType<Miniflare['getD1Database']>>;
let db: Db;
beforeAll(() => {
  bundle = buildSync({ stdin: { contents: `
    import {workspaceBackupRoutes,processWorkspaceBackup,processWorkspaceDeletion,restoreWorkspaceArchive,cleanupWorkspaceOrphans,expireWorkspaceBackupArtifacts} from ${JSON.stringify(`${root}src/workspace_backup.ts`)};
    import {ApiError} from ${JSON.stringify(`${root}src/types.ts`)};
    export default {async fetch(request,env){try{const path=new URL(request.url).pathname;
      if(path==='/_test/backup')return Response.json(await processWorkspaceBackup(env,(await request.json()).id));
      if(path==='/_test/delete')return Response.json(await processWorkspaceDeletion(env,(await request.json()).id));
      if(path==='/_test/retention')return Response.json(await cleanupWorkspaceOrphans(env,await request.json()));
      if(path==='/_test/expire')return Response.json(await expireWorkspaceBackupArtifacts(env,await request.json()));
      if(path==='/_test/restore'){const body=await request.json();return Response.json(await restoreWorkspaceArchive(env,new Uint8Array(body.manifest),new Uint8Array(body.snapshot),body.hash,async ordinal=>new Uint8Array(await(await fetch('https://archive.example/'+ordinal)).arrayBuffer())));}
      return await workspaceBackupRoutes(request,env,task=>env.APPLICATION_QUEUE.send(task))||new Response('not found',{status:404});
    }catch(error){return Response.json({detail:error instanceof Error?error.message:'failed'},{status:error instanceof ApiError?error.status:500});}}};`, sourcefile: 'backup-test.ts', resolveDir: root }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
});
async function runtime(isolated = false, storage: 'r2' | 'kv' = 'r2') {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], ...(storage === 'r2' ? { r2Buckets: ['FILES'] } : { kvNamespaces: ['FILES_KV'] }), queueProducers: { APPLICATION_QUEUE: 'workspace-test' }, bindings: { PUBLIC_BASE_URL: 'https://workspace.example', ...(isolated ? { RESTORE_ISOLATED: 'true' } : {}) }, outboundService: request => {
    expect(new URL(request.url).hostname).toBe('archive.example'); archiveReads++;
    const value = archive.get(Number(new URL(request.url).pathname.slice(1))), bytes = new ArrayBuffer(value?.length || 0); if (value) new Uint8Array(bytes).set(value); return new Response(bytes);
  } }));
  await applyTestMigrations(await mf.getD1Database('DB')); return mf;
}
async function call(mf: Miniflare, path: string, body?: unknown, cookie = token) {
  return mf.dispatchFetch(`https://workspace.example${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: 'https://workspace.example', Cookie: `hireflow_session=${cookie}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(async () => {
  archive = new Map(); archiveReads = 0; source = await runtime(); db = await source.getD1Database('DB');
  await db.batch([
    db.prepare('INSERT INTO users(id,name,email,mode,master_profile) VALUES(10,?,?,?,?)').bind('Synthetic Archive Owner', 'owner@example.com', 'internship', JSON.stringify({ name: 'Synthetic Archive Owner', email: 'owner@example.com', skills: ['Python'], master_resume_path: master })),
    db.prepare("INSERT INTO users(id,name,email,mode) VALUES(20,'Other Owner','other@example.com','job')"),
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,10,?)').bind(hash(token), '2099-01-01'),
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,20,?)').bind(hash(otherToken), '2099-01-01'),
    db.prepare("INSERT INTO jobs(id,title,company,url,description,listing_type) VALUES(101,'AI Intern','Example One','https://employer.example/jobs/101','Synthetic Python engineering internship with tests and documentation.','internship')"),
    db.prepare("INSERT INTO jobs(id,title,company,url,description,listing_type) VALUES(102,'Backend Intern','Example Two','https://employer.example/jobs/102','Synthetic backend internship with Python and SQL.','internship')"),
    db.prepare("INSERT INTO applications(id,user_id,job_id,status,resume_path,resume_version,applied_at,attempts) VALUES(1001,10,101,'applied','resumes/10/job101_v2.pdf',2,'2026-10-01T10:00:00.000Z',1)"),
    db.prepare("INSERT INTO applications(id,user_id,job_id,status,resume_path,resume_version) VALUES(1002,10,102,'confirmed','resumes/10/job102_v1.pdf',1)"),
    db.prepare("INSERT INTO applications(id,user_id,job_id,status) VALUES(2001,20,101,'pending')"),
    db.prepare('INSERT INTO resumes(application_id,version,object_key,profile_snapshot) VALUES(1001,1,?,?)').bind('resumes/10/job101_v1.pdf', JSON.stringify({ name: 'Synthetic Archive Owner', master_resume_path: master })),
    db.prepare("INSERT INTO resumes(application_id,version,object_key) VALUES(1001,2,'resumes/10/job101_v2.pdf')"),
    db.prepare("INSERT INTO resumes(application_id,version,object_key) VALUES(1002,1,'resumes/10/job102_v1.pdf')"),
    db.prepare("INSERT INTO prep_guides(id,application_id,structured_data,company_intel) VALUES(77,1001,'{\"round_count\":2}','{\"stage\":\"unknown\"}')"),
    db.prepare("INSERT INTO weekly_reports(user_id,week_start_date,content,metrics,applied_count,avg_match_score,html_path) VALUES(10,'2026-09-28','{\"resume_url\":\"/resumes/10/1001/download\"}','{}',1,0.8,'reports/10/week_original.html')"),
    db.prepare("INSERT INTO outbox(application_id,kind) VALUES(1002,'apply')"),
    db.prepare("INSERT INTO account_owners(user_id,user_handle) VALUES(10,'synthetic-private-handle')"),
    db.prepare("INSERT INTO account_passkeys(id,user_id,public_key,name,created_at) VALUES('synthetic-passkey',10,'private-public-key','Security key','2026-10-01')"),
    db.prepare("INSERT INTO account_recovery_keys(token_hash,user_id,created_at,expires_at) VALUES('synthetic-recovery-hash',10,'2026-10-01','2099-01-01')"),
  ]);
  const bucket = await source.getR2Bucket('FILES');
  for (const key of [master, 'resumes/10/job101_v1.pdf', 'resumes/10/job101_v2.pdf', 'resumes/10/job102_v1.pdf']) await bucket.put(key, `%PDF-1.4\nSynthetic immutable content: ${key}\n%%EOF`, { httpMetadata: { contentType: 'application/pdf' } });
  await bucket.put('reports/10/week_original.html', '<h1>Synthetic historical report</h1>', { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await bucket.put('resumes/20/private.pdf', '%PDF-1.4\nOther workspace private artifact');
}, 30000);
afterEach(async () => { await source?.dispose(); await destination?.dispose(); destination = undefined; }, 30000);
async function exportArchive() {
  const requested = await call(source, '/account/backups', {}); expect(requested.status, await requested.clone().text()).toBe(202); const { id } = await requested.json() as any;
  for (let step = 0; step < 20; step++) { const response = await call(source, '/_test/backup', { id }); expect(response.status, await response.clone().text()).toBe(200); if (!(await response.json() as any).requeue) break; }
  const status = await call(source, `/account/backups/${id}`); const result = await status.json() as any; expect(result.state, JSON.stringify(result)).toBe('ready');
  const manifestBytes = new Uint8Array(await (await call(source, `/account/backups/${id}/manifest`)).arrayBuffer()), snapshotBytes = new Uint8Array(await (await call(source, `/account/backups/${id}/snapshot`)).arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)), snapshot = JSON.parse(new TextDecoder().decode(snapshotBytes));
  for (const artifact of manifest.artifacts) archive.set(artifact.ordinal, new Uint8Array(await (await call(source, `/account/backups/${id}/artifacts/${artifact.ordinal}`)).arrayBuffer()));
  return { id, manifest, snapshot, manifestBytes, snapshotBytes, hash: result.manifest_hash };
}
async function restore(bundle: Awaited<ReturnType<typeof exportArchive>>) { destination = await runtime(true); return call(destination, '/_test/restore', { manifest: [...bundle.manifestBytes], snapshot: [...bundle.snapshotBytes], hash: bundle.hash }); }

describe('private coordinated workspace archives', () => {
  it('exports only the authenticated owner and protects each manifest/document route', async () => {
    const backup = await exportArchive();
    expect(backup.manifest.source_owner_id).toBe(10); expect(backup.snapshot.tables.applications).toHaveLength(2); expect(backup.snapshot.tables.resumes).toHaveLength(3);
    const text = JSON.stringify(backup.snapshot); for (const forbidden of ['Other Owner', 'synthetic-passkey', 'synthetic-recovery-hash', hash(token), 'outbox', 'account_passkeys']) expect(text).not.toContain(forbidden);
    for (const suffix of ['', '/manifest', '/snapshot', '/artifacts/0']) expect((await call(source, `/account/backups/${backup.id}${suffix}`, undefined, otherToken)).status).toBe(404);
    const response = await call(source, `/account/backups/${backup.id}/manifest`); expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('restores real D1/R2 history and exact PDF versions with new ownership but no execution authority', async () => {
    const backup = await exportArchive(), response = await restore(backup); expect(response.status, await response.clone().text()).toBe(200);
    const mapping = await response.json() as any, target = await destination!.getD1Database('DB'), bucket = await destination!.getR2Bucket('FILES');
    expect(mapping.user_id).toBe(1); expect(mapping.application_ids).toEqual({ 1001: 1, 1002: 2 });
    const apps = (await target.prepare('SELECT * FROM applications ORDER BY id').all<any>()).results;
    expect(apps[0]).toMatchObject({ user_id: 1, status: 'applied', resume_version: 2, attempts: 1, applied_at: '2026-10-01T10:00:00.000Z' });
    expect(apps[1]).toMatchObject({ user_id: 1, status: 'needs_action', confirmed_review_id: null }); expect(apps[1].failure_reason).toContain('Check the employer');
    const resumes = (await target.prepare('SELECT * FROM resumes ORDER BY id').all<any>()).results; expect(resumes.map(r => r.version)).toEqual([1, 2, 1]);
    for (const artifact of backup.manifest.artifacts) { const object = await bucket.get(mapping.artifact_keys[artifact.source_key]); expect(object).not.toBeNull(); expect(hash(new Uint8Array(await object!.arrayBuffer()))).toBe(artifact.sha256); }
    const oldHistory = backup.snapshot.tables.application_status_events.filter((r: any) => r.application_id === 1001).map((r: any) => [r.status, r.reason, r.created_at]);
    const history = (await target.prepare('SELECT status,reason,created_at FROM application_status_events WHERE application_id=1 ORDER BY id').all<any>()).results.map(r => [r.status, r.reason, r.created_at]); expect(history).toEqual(oldHistory);
    for (const table of ['sessions', 'account_owners', 'account_passkeys', 'account_recovery_keys', 'submission_reviews', 'outbox', 'automation_checkpoints', 'resume_preparations', 'email_deliveries', 'weekly_schedules', 'weekly_schedule_runs', 'workspace_reminders', 'discovery_cycles', 'discovery_candidates', 'prep_refreshes']) expect((await target.prepare(`SELECT count(*) AS n FROM ${table}`).first<any>())!.n).toBe(0);
    expect((await (await source.getR2Bucket('FILES')).get('resumes/20/private.pdf'))).not.toBeNull();
  });

  it('rejects tampering and mixed-owner rows before importing authority or leaving copied files', async () => {
    const backup = await exportArchive(); const first = archive.get(0)!; archive.set(0, new Uint8Array([...first, 1]));
    expect((await restore(backup)).status).toBe(422); expect((await (await destination!.getR2Bucket('FILES')).list()).objects).toHaveLength(0);
    expect((await (await destination!.getD1Database('DB')).prepare('SELECT count(*) AS n FROM users').first<any>())!.n).toBe(0);
    await destination!.dispose(); destination = undefined; archive.set(0, first);
    backup.snapshot.tables.applications[0].user_id = 20; backup.snapshotBytes = new TextEncoder().encode(JSON.stringify(backup.snapshot)); backup.manifest.snapshot.sha256 = hash(backup.snapshotBytes); backup.manifest.snapshot.size = backup.snapshotBytes.length; backup.manifestBytes = new TextEncoder().encode(JSON.stringify(backup.manifest)); backup.hash = hash(backup.manifestBytes);
    const before = archiveReads; expect((await restore(backup)).status).toBe(422); expect(archiveReads).toBe(before);
  });

  it('requires an explicitly isolated empty destination and leaves another owner untouched', async () => {
    const backup = await exportArchive();
    const body = { manifest: [...backup.manifestBytes], snapshot: [...backup.snapshotBytes], hash: backup.hash };
    expect((await call(source, '/_test/restore', body)).status).toBe(403);
    destination = await runtime(true); const target = await destination.getD1Database('DB'); await target.prepare("INSERT INTO users(name,email,mode) VALUES('Existing','existing@example.com','job')").run();
    const before = archiveReads; expect((await call(destination, '/_test/restore', body)).status).toBe(409); expect(archiveReads).toBe(before);
    expect((await target.prepare('SELECT name FROM users').first<any>())!.name).toBe('Existing');
  });

  it('rejects oversized artifact catalogs before reading files and rejects large metadata before materializing it', async () => {
    const backup = await exportArchive(); backup.manifest.artifacts[0].size = 4 * 1024 * 1024 + 1; backup.manifestBytes = new TextEncoder().encode(JSON.stringify(backup.manifest)); backup.hash = hash(backup.manifestBytes);
    const before = archiveReads; expect((await restore(backup)).status).toBe(422); expect(archiveReads).toBe(before);
    await db.prepare("UPDATE applications SET status='planned' WHERE id=1002").run();
    const large = JSON.stringify({ summary: 'x'.repeat(1500000) });
    for (let version = 3; version <= 5; version++) await db.prepare('INSERT INTO resumes(application_id,version,object_key,profile_snapshot) VALUES(1001,?,?,?)').bind(version, `resumes/10/large_${version}.pdf`, large).run();
    const requested = await (await call(source, '/account/backups', {})).json() as any;
    await call(source, '/_test/backup', { id: requested.id });
    const state = await (await call(source, `/account/backups/${requested.id}`)).json() as any;
    expect(state.state).toBe('failed'); expect(state.failure_reason).toContain('metadata exceeds');
    expect((await (await source.getR2Bucket('FILES')).list({ prefix: `backups/10/${requested.id}/` })).objects).toHaveLength(0);
  });

  it('preserves ready guide files while unfinished exports remain inactive after restore', async () => {
    const ids = ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'];
    const bucket = await source.getR2Bucket('FILES');
    for (const [index, id] of ids.entries()) {
      await db.prepare('INSERT INTO prep_guide_exports(id,application_id,user_id,guide_id,version,guide_revision,profile_version,job_version,snapshot_hash,input_snapshot,state,html_key,pdf_key,created_at,expires_at,work_expires_at) VALUES(?,1001,10,77,?,1,1,1,?,?,?,?,?,?,?,?)').bind(id, index + 1, hash('guide'), '{"private_work":"not-restored"}', index ? 'queued' : 'ready', `prep-guides/10/1001/${id}.html`, `prep-guides/10/1001/${id}.pdf`, '2026-10-01', '2099-01-01', '2099-01-01').run();
      if (!index) { await bucket.put(`prep-guides/10/1001/${id}.html`, '<h1>Private guide</h1>'); await bucket.put(`prep-guides/10/1001/${id}.pdf`, '%PDF-1.4\nPrivate guide'); }
    }
    const backup = await exportArchive(); expect(backup.manifest.artifacts.filter((a: any) => a.purpose === 'guide')).toHaveLength(2);
    const response = await restore(backup); expect(response.status, await response.clone().text()).toBe(200);
    const rows = (await (await destination!.getD1Database('DB')).prepare('SELECT * FROM prep_guide_exports ORDER BY version').all<any>()).results;
    expect(rows[0]).toMatchObject({ user_id: 1, application_id: 1, state: 'ready', input_snapshot: '{}' });
    expect(rows[1]).toMatchObject({ user_id: 1, state: 'failed', input_snapshot: '{}', dispatched_at: null }); expect(rows[1].failure_reason).toContain('fresh guide export');
  });

  it('persists the real offline CLI restore across a separate D1/KV process restart', async () => {
    const backup = await exportArchive(), temp = mkdtempSync(join(tmpdir(), 'hireflow-isolated-restore-'));
    try {
      const directory = join(temp, 'archive'), target = join(temp, 'restored'); mkdirSync(directory, { mode: 0o700 }); mkdirSync(join(directory, 'artifacts'), { mode: 0o700 });
      writeFileSync(join(directory, 'manifest.json'), backup.manifestBytes, { mode: 0o600 }); writeFileSync(join(directory, 'snapshot.json'), backup.snapshotBytes, { mode: 0o600 });
      for (const [ordinal, bytes] of archive) writeFileSync(join(directory, 'artifacts', `${ordinal}.bin`), bytes, { mode: 0o600 });
      const result = spawnSync(process.execPath, [`${root}../scripts/restore_workspace_backup.mjs`, '--run-isolated-restore', '--archive', directory, '--destination', target, '--manifest-sha256', backup.hash], { encoding: 'utf8', timeout: 30000 });
      expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ state: 'restored_offline', user_id: 1, application_count: 2, authentication_restored: false });
      expect(JSON.parse(readFileSync(join(target, 'mapping.json'), 'utf8')).application_ids).toEqual({ 1001: 1, 1002: 2 });
      // A receipt is not evidence that Miniflare persisted anything. Reopen
      // without migrations/import, in a genuinely separate process, and read
      // actual restored rows and KV bytes after the CLI has disposed its runtime.
      const probe = join(temp, 'verify-restored-state.mjs');
      writeFileSync(probe, `
        import assert from 'node:assert/strict';
        import {createHash} from 'node:crypto';
        import {createRequire} from 'node:module';
        import {readFileSync} from 'node:fs';
        import {join} from 'node:path';
        const require=createRequire(${JSON.stringify(`${root}package.json`)});
        const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
        const target=process.argv[2],archive=process.argv[3];
        const mapping=JSON.parse(readFileSync(join(target,'mapping.json'),'utf8'));
        const snapshot=JSON.parse(readFileSync(join(archive,'snapshot.json'),'utf8'));
        const manifest=JSON.parse(readFileSync(join(archive,'manifest.json'),'utf8'));
        const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null,{status:404});}}',compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],kvNamespaces:['FILES_KV'],resourcePersistencePath:join(target,'state'),outboundService(){throw new Error('Network forbidden while reopening restored state');}}));
        try {
          const db=await mf.getD1Database('DB'),kv=await mf.getKVNamespace('FILES_KV');
          const apps=(await db.prepare('SELECT user_id,status,resume_version,attempts,applied_at FROM applications ORDER BY id').all()).results;
          assert.equal(apps.length,2);assert.deepEqual(apps[0],{user_id:1,status:'applied',resume_version:2,attempts:1,applied_at:'2026-10-01T10:00:00.000Z'});
          assert.equal(apps[1].status,'needs_action');
          const versions=(await db.prepare('SELECT version FROM resumes ORDER BY id').all()).results.map(row=>row.version);
          assert.deepEqual(versions,[1,2,1]);
          const history=(await db.prepare('SELECT status,reason,created_at FROM application_status_events WHERE application_id=? ORDER BY id').bind(mapping.application_ids['1001']).all()).results;
          assert.deepEqual(history,snapshot.tables.application_status_events.filter(row=>row.application_id===1001).map(({status,reason,created_at})=>({status,reason,created_at})));
          assert.ok(history.length>0);
          for(const artifact of manifest.artifacts){const bytes=await kv.get(mapping.artifact_keys[artifact.source_key],{type:'arrayBuffer'});assert.ok(bytes);assert.equal(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),artifact.sha256);}
          const forbidden=['sessions','account_owners','account_passkeys','account_recovery_keys','submission_reviews','outbox','automation_checkpoints','resume_preparations','email_deliveries','email_receipt_events','weekly_schedules','weekly_schedule_runs','workspace_reminders','discovery_cycles','discovery_candidates','prep_refreshes'];
          for(const table of forbidden)assert.equal((await db.prepare('SELECT count(*) AS n FROM '+table).first()).n,0,table+' must remain empty after restart');
          console.log(JSON.stringify({reopened:true,applications:apps.length,resume_versions:versions.length,preserved_history:history.length,verified_artifacts:manifest.artifacts.length,authority_tables_empty:forbidden.length}));
        }finally{await mf.dispose();}
      `, { mode: 0o600 });
      const reopened = spawnSync(process.execPath, [probe, target, directory], { encoding: 'utf8', timeout: 30000 });
      expect(reopened.status, reopened.stderr).toBe(0);
      expect(JSON.parse(reopened.stdout)).toMatchObject({ reopened: true, applications: 2, resume_versions: 3, verified_artifacts: backup.manifest.artifacts.length, authority_tables_empty: 16 });
      const rejected = spawnSync(process.execPath, [`${root}../scripts/restore_workspace_backup.mjs`, '--run-isolated-restore', '--archive', directory, '--destination', target, '--manifest-sha256', backup.hash], { encoding: 'utf8', timeout: 10000 }); expect(rejected.status).not.toBe(0);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 45000);

  it('copies and hashes artifacts using the current free private-KV binding too', async () => {
    destination = await runtime(false, 'kv'); const target = await destination.getD1Database('DB'), kv = await destination.getKVNamespace('FILES_KV');
    await target.batch([
      target.prepare('INSERT INTO users(id,name,email,mode,master_profile) VALUES(1,?,?,?,?)').bind('Synthetic KV Owner', 'kv-owner@example.com', 'internship', JSON.stringify({ name: 'Synthetic KV Owner', master_resume_path: master })),
      target.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,1,?)').bind(hash(token), '2099-01-01'),
    ]);
    const bytes = new TextEncoder().encode('%PDF-1.4\nSynthetic private KV input'); await kv.put(master, bytes, { metadata: { size: bytes.length, contentType: 'application/pdf' } });
    const requested = await (await call(destination, '/account/backups', {})).json() as any;
    for (let i = 0; i < 6; i++) if (!(await (await call(destination, '/_test/backup', { id: requested.id })).json() as any).requeue) break;
    const state = await (await call(destination, `/account/backups/${requested.id}`)).json() as any; expect(state.state).toBe('ready');
    const copied = await call(destination, `/account/backups/${requested.id}/artifacts/0`); expect(copied.headers.get('content-disposition')).toContain('0.bin'); expect(hash(new Uint8Array(await copied.arrayBuffer()))).toBe(hash(bytes));
  });
});

describe('explicit scoped deletion and conservative retention', () => {
  it('binds the preview nonce to owner, session and workspace revision; active submissions block deletion', async () => {
    expect((await call(source, '/account/deletion-preview', {})).status).toBe(409);
    await db.prepare("UPDATE applications SET status='planned' WHERE id=1002").run();
    const preview = await (await call(source, '/account/deletion-preview', {})).json() as any;
    const confirmation = { id: preview.id, nonce: preview.nonce, profile_version: preview.profile_version, confirmation: 'DELETE MY WORKSPACE' };
    expect((await call(source, '/account/delete', confirmation, otherToken)).status).toBe(409);
    await db.prepare("UPDATE users SET name='Changed',profile_version=profile_version+1 WHERE id=10").run();
    expect((await call(source, '/account/delete', confirmation)).status).toBe(409);
    expect((await db.prepare('SELECT count(*) AS n FROM users').first<any>())!.n).toBe(2);
  });

  it('does not let another session of the same owner reuse a deletion preview', async () => {
    await db.prepare("UPDATE applications SET status='planned' WHERE id=1002").run(); const second = 'c'.repeat(64);
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,10,?)').bind(hash(second), '2099-01-01').run();
    const preview = await (await call(source, '/account/deletion-preview', {})).json() as any;
    expect((await call(source, '/account/delete', { id: preview.id, nonce: preview.nonce, profile_version: preview.profile_version, confirmation: 'DELETE MY WORKSPACE' }, second)).status).toBe(409);
  });

  it('deletes only a freshly confirmed workspace while retaining another owner and their documents', async () => {
    await db.prepare("UPDATE applications SET status='planned' WHERE id=1002").run();
    const previewResponse = await call(source, '/account/deletion-preview', {}); expect(previewResponse.status, await previewResponse.clone().text()).toBe(200); const preview = await previewResponse.json() as any;
    expect(preview.includes_submitted_history).toBe(true); expect(preview.counts.applications).toBe(2);
    const confirmation = { id: preview.id, nonce: preview.nonce, profile_version: preview.profile_version, confirmation: 'DELETE MY WORKSPACE' };
    expect((await call(source, '/account/delete', confirmation)).status).toBe(202); expect((await call(source, '/account/delete', confirmation)).status).toBe(409);
    for (let i = 0; i < 15; i++) { const response = await call(source, '/_test/delete', { id: preview.id }); expect(response.status, await response.clone().text()).toBe(200); if (!(await response.json() as any).requeue) break; }
    expect((await db.prepare('SELECT id FROM users ORDER BY id').all<any>()).results).toEqual([{ id: 20 }]);
    expect((await db.prepare('SELECT id FROM applications').all<any>()).results).toEqual([{ id: 2001 }]);
    const bucket = await source.getR2Bucket('FILES'); expect(await bucket.get('resumes/10/job101_v2.pdf')).toBeNull(); expect(await bucket.get('resumes/20/private.pdf')).not.toBeNull();
  });

  it('never removes a referenced/submitted PDF and tombstones a genuinely old orphan against late publication', async () => {
    const bucket = await source.getR2Bucket('FILES'), orphan = 'resumes/10/old_orphan.pdf'; await bucket.put(orphan, '%PDF-1.4\nUnreferenced synthetic object');
    await db.batch([db.prepare("UPDATE workspace_retention_cursor SET prefix_index=1 WHERE id=1"), db.prepare('INSERT INTO workspace_orphan_candidates(object_key,first_seen_at) VALUES(?,?)').bind(orphan, '2020-01-01T00:00:00.000Z'), db.prepare('INSERT INTO workspace_orphan_candidates(object_key,first_seen_at) VALUES(?,?)').bind('resumes/10/job101_v2.pdf', '2020-01-01T00:00:00.000Z')]);
    const dry = await (await call(source, '/_test/retention', {})).json() as any; expect(dry.deleted).toBe(0); expect(await bucket.get(orphan)).not.toBeNull();
    const response = await call(source, '/_test/retention', { execute: true }); expect(response.status, await response.clone().text()).toBe(200); expect(await bucket.get(orphan)).toBeNull(); expect(await bucket.get('resumes/10/job101_v2.pdf')).not.toBeNull();
    await expect(db.prepare('UPDATE applications SET resume_path=? WHERE id=1002').bind(orphan).run()).rejects.toThrow('Artifact was retired');
  });

  it('protects email-selected historical source files and blocks deletion during an in-flight send', async () => {
    const key = 'resumes/10/selected_by_email_only.pdf', bucket = await source.getR2Bucket('FILES'); await bucket.put(key, '%PDF-1.4\nSelected historical version');
    await db.prepare("INSERT INTO email_deliveries(id,user_id,report_id,report_key,provider,recipient,sender,subject,payload_key,source_artifacts,source_snapshot,state,idempotency_key,created_at,expires_at) VALUES('mail-fixture',10,1,'reports/10/week_original.html','resend','owner@example.com','sender@example.com','Synthetic','mail/10/mail-fixture/payload.json',?,'{}','sending','synthetic-mail-key','2026-10-01','2099-01-01')").bind(JSON.stringify([key])).run();
    await db.batch([db.prepare("UPDATE workspace_retention_cursor SET prefix_index=1 WHERE id=1"), db.prepare('INSERT INTO workspace_orphan_candidates(object_key,first_seen_at) VALUES(?,?)').bind(key, '2020-01-01T00:00:00.000Z')]);
    const cleanup = await call(source, '/_test/retention', { execute: true }); expect(cleanup.status, await cleanup.clone().text()).toBe(200); expect(await bucket.get(key)).not.toBeNull();
    await db.prepare("UPDATE applications SET status='planned' WHERE id=1002").run();
    const preview = await call(source, '/account/deletion-preview', {}); expect(preview.status).toBe(409); expect(await preview.text()).toContain('active email');
  });
});
