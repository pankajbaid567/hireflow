/** Private data portability. Archives never contain authentication or execution
 * authority. Heavy snapshot/copy/delete work belongs to the existing Queue. */
import { ApiError, type Env, type Row, json, parsed } from './types';
import { digest, requireUser, sessionHash } from './auth';
import { all, first, run } from './storage';
import { files, type FileObject } from './files';
import { readJson } from './profile';

export const WORKSPACE_ARCHIVE_FORMAT = 'hireflow-workspace-v1';
export const BACKUP_LIMITS = { metadata: 4 * 1024 * 1024, artifact: 4 * 1024 * 1024, total: 32 * 1024 * 1024, files: 256, retentionMs: 48 * 3600000, orphanMs: 7 * 86400000 } as const;
export type WorkspaceLifecycleTask = { kind: 'workspace_backup' | 'workspace_delete'; id: string };
type Enqueue = (task: WorkspaceLifecycleTask) => Promise<void>;
type TableName = 'users' | 'jobs' | 'applications' | 'application_status_events' | 'resumes' | 'prep_guides' | 'weekly_reports' | 'shortlists' | 'prep_guide_exports';
export interface WorkspaceSnapshot { format: typeof WORKSPACE_ARCHIVE_FORMAT; captured_at: string; source_owner_id: number; workspace_revision: number; tables: Partial<Record<TableName, Row[]>>; }
export interface ArchiveArtifact { ordinal: number; source_key: string; purpose: 'master' | 'resume' | 'report' | 'guide'; size: number; sha256: string; content_type: string; name: string; }
export interface WorkspaceManifest { format: typeof WORKSPACE_ARCHIVE_FORMAT; backup_id: string; source_owner_id: number; captured_at: string; snapshot: { name: 'snapshot.json'; size: number; sha256: string }; artifacts: ArchiveArtifact[]; counts: Record<string, number>; }
const tableLimits: Record<TableName, number> = { users: 1, jobs: 256, applications: 256, application_status_events: 4096, resumes: 1024, prep_guides: 256, weekly_reports: 104, shortlists: 100, prep_guide_exports: 256 };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const now = () => new Date().toISOString();
const expires = (ms: number) => new Date(Date.now() + ms).toISOString();
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function sha(bytes: Uint8Array): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, '0')).join(''); }
function requireOrigin(request: Request, env: Env) { if (request.headers.get('origin') !== new URL(env.PUBLIC_BASE_URL).origin) throw new ApiError(403, 'Open workspace settings on the HireFlow website.'); }
function safeProfile(value: unknown): Row { const profile = { ...parsed<Row>(value, {}) }; for (const key of Object.keys(profile)) if (/token|cookie|password|passkey|recovery|approval|access_code|api_key/i.test(key)) delete profile[key]; return profile; }
function scope(table: TableName, owner: number): { from: string; where: string; params: number[] } {
  if (table === 'users') return { from: 'users t', where: 't.id=?', params: [owner] };
  if (table === 'jobs') return { from: 'jobs t JOIN applications a ON a.job_id=t.id', where: 'a.user_id=?', params: [owner] };
  if (['resumes', 'prep_guides', 'application_status_events'].includes(table)) return { from: `${table} t JOIN applications a ON a.id=t.application_id`, where: 'a.user_id=?', params: [owner] };
  return { from: `${table} t`, where: 't.user_id=?', params: [owner] };
}
async function schema(env: Env): Promise<Map<TableName, string[]>> {
  const names = Object.keys(tableLimits) as TableName[];
  const results = await env.DB.batch<Row>(names.map(name => env.DB.prepare(`PRAGMA table_info(${name})`)));
  return new Map(names.flatMap((name, index) => results[index].results.length ? [[name, results[index].results.map(row => String(row.name))] as [TableName, string[]]] : []));
}
function rowByteEstimate(columns: string[]): string {
  // JSON objects are limited to 32 SQLite function arguments. Summing chunks
  // conservatively includes every null/key/escaped string without loading rows.
  const chunks: string[] = [];
  for (let i = 0; i < columns.length; i += 14) chunks.push(`length(CAST(json_object(${columns.slice(i, i + 14).flatMap(c => [`'${c}'`, `t.${c}`]).join(',')}) AS BLOB))`);
  return `COALESCE(sum(${chunks.join('+')}+32),0)`;
}
async function captureSnapshot(env: Env, owner: number, profileVersion: number): Promise<WorkspaceSnapshot> {
  const tables = await schema(env), names = [...tables.keys()];
  if (tables.has('prep_guide_exports')) {
    const inconsistent = await first(env, `SELECT count(*) AS n FROM prep_guide_exports e JOIN applications a ON a.id=e.application_id JOIN prep_guides g ON g.id=e.guide_id WHERE (e.user_id=? OR a.user_id=? OR g.application_id IN (SELECT id FROM applications WHERE user_id=?)) AND (e.user_id<>a.user_id OR g.application_id<>e.application_id)`, owner, owner, owner);
    if (inconsistent!.n) throw new ApiError(409, 'Workspace guide ownership references need operator repair before export or deletion.');
  }
  const stats = await env.DB.batch<Row>([env.DB.prepare('SELECT revision FROM workspace_revisions WHERE user_id=?').bind(owner), ...names.map(name => { const s = scope(name, owner); return env.DB.prepare(`SELECT count(*) AS n,${rowByteEstimate(tables.get(name)!)} AS bytes FROM ${s.from} WHERE ${s.where}`).bind(...s.params); })]);
  const revision = stats[0].results[0]?.revision;
  if (!Number.isSafeInteger(revision)) throw new ApiError(404, 'Workspace is unavailable.');
  let bytes = 2048;
  for (let i = 0; i < names.length; i++) { const stat = stats[i + 1].results[0]; bytes += Number(stat.bytes); if (Number(stat.n) > tableLimits[names[i]]) throw new ApiError(422, 'Workspace exceeds the bounded export size. Use an operator-coordinated offline database backup.'); }
  if (bytes > BACKUP_LIMITS.metadata) throw new ApiError(422, 'Workspace metadata exceeds the bounded export size. Use an operator-coordinated offline database backup.');
  const rows = await env.DB.batch<Row>([...names.map(name => { const s = scope(name, owner); return env.DB.prepare(`SELECT t.* FROM ${s.from} WHERE ${s.where} AND (SELECT revision FROM workspace_revisions WHERE user_id=?)=? ORDER BY t.id LIMIT ?`).bind(...s.params, owner, revision, tableLimits[name] + 1); }), env.DB.prepare('SELECT revision,profile_version FROM workspace_revisions JOIN users ON users.id=workspace_revisions.user_id WHERE users.id=?').bind(owner)]);
  if (rows.at(-1)!.results[0]?.revision !== revision || rows.at(-1)!.results[0]?.profile_version !== profileVersion) throw new ApiError(409, 'Workspace changed while preparing the export. Request it again.');
  const result: WorkspaceSnapshot = { format: WORKSPACE_ARCHIVE_FORMAT, captured_at: now(), source_owner_id: owner, workspace_revision: revision, tables: Object.fromEntries(names.map((name, i) => [name, rows[i].results])) };
  result.tables.users![0].master_profile = JSON.stringify(safeProfile(result.tables.users![0].master_profile));
  for (const row of result.tables.applications || []) row.confirmed_review_id = null;
  for (const row of result.tables.resumes || []) row.profile_snapshot = JSON.stringify(safeProfile(row.profile_snapshot));
  for (const row of result.tables.prep_guide_exports || []) row.input_snapshot = '{}';
  if (encode(result).length > BACKUP_LIMITS.metadata) throw new ApiError(422, 'Workspace metadata exceeds the bounded export size.');
  return result;
}
function artifactKeys(snapshot: WorkspaceSnapshot, includeUnpublished = false): { source_key: string; purpose: ArchiveArtifact['purpose'] }[] {
  const keys = new Map<string, ArchiveArtifact['purpose']>();
  const add = (value: unknown, purpose: ArchiveArtifact['purpose']) => { if (typeof value === 'string' && value) keys.set(value, purpose); };
  add(parsed<Row>(snapshot.tables.users?.[0]?.master_profile, {}).master_resume_path, 'master');
  for (const row of snapshot.tables.resumes || []) { add(row.object_key, 'resume'); add(parsed<Row>(row.profile_snapshot, {}).master_resume_path, 'master'); }
  for (const row of snapshot.tables.applications || []) add(row.resume_path, 'resume');
  for (const row of snapshot.tables.weekly_reports || []) add(row.html_path, 'report');
  for (const row of snapshot.tables.prep_guide_exports || []) if (!row.cleaned_at && (includeUnpublished || row.state === 'ready')) { add(row.html_key, 'guide'); add(row.pdf_key, 'guide'); }
  const owner = snapshot.source_owner_id;
  for (const [key, purpose] of keys) {
    const valid = purpose === 'master' ? /^uploads\/[a-f0-9-]+\.pdf$/.test(key) : purpose === 'resume' ? key.startsWith(`resumes/${owner}/`) : purpose === 'report' ? key.startsWith(`reports/${owner}/`) : key.startsWith(`prep-guides/${owner}/`);
    if (!valid || key.length > 512 || key.includes('..') || key.includes('\\')) throw new ApiError(409, 'A workspace artifact has an inconsistent ownership reference.');
  }
  if (keys.size > BACKUP_LIMITS.files) throw new ApiError(422, 'Workspace has too many artifacts for one bounded export.');
  return [...keys].map(([source_key, purpose]) => ({ source_key, purpose }));
}
async function referenceQuery(env: Env, otherThan?: number): Promise<{ queries: string[]; params: number[] }> {
  const guideExists = (await first(env, "SELECT name FROM sqlite_master WHERE type='table' AND name='prep_guide_exports'")) !== null;
  const exclude = otherThan ?? -1;
  const queries = [
    "SELECT json_extract(master_profile,'$.master_resume_path') AS k FROM users WHERE id<>?",
    'SELECT r.object_key AS k FROM resumes r JOIN applications a ON a.id=r.application_id WHERE a.user_id<>?',
    "SELECT json_extract(r.profile_snapshot,'$.master_resume_path') AS k FROM resumes r JOIN applications a ON a.id=r.application_id WHERE a.user_id<>?",
    'SELECT resume_path AS k FROM applications WHERE user_id<>?',
    'SELECT resume_path AS k FROM submission_reviews WHERE user_id<>?',
    'SELECT p.object_key AS k FROM resume_preparations p JOIN applications a ON a.id=p.application_id WHERE a.user_id<>?',
    'SELECT html_path AS k FROM weekly_reports WHERE user_id<>?',
    "SELECT f.source_key AS k FROM workspace_backup_files f JOIN workspace_backups b ON b.id=f.backup_id WHERE b.user_id<>? AND b.state IN ('queued','running') AND b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    ...(guideExists ? ['SELECT html_key AS k FROM prep_guide_exports WHERE user_id<>? AND cleaned_at IS NULL', 'SELECT pdf_key AS k FROM prep_guide_exports WHERE user_id<>? AND cleaned_at IS NULL'] : []),
  ];
  if (await first(env, "SELECT name FROM sqlite_master WHERE type='table' AND name='email_deliveries'")) {
    const columns = await all(env, 'PRAGMA table_info(email_deliveries)');
    for (const column of columns) if (/^(?:[a-z_]+_)?(?:object|payload|html|pdf|manifest|resume|report)_key$/.test(column.name)) queries.push(`SELECT ${column.name} AS k FROM email_deliveries WHERE user_id<>?`);
    if (columns.some(column => column.name === 'source_artifacts')) queries.push('SELECT j.value AS k FROM email_deliveries e,json_each(e.source_artifacts) j WHERE e.user_id<>?');
  }
  return { queries, params: queries.map(() => exclude) };
}
const referencePredicate = (queries: string[], key: string) => queries.map(query => `EXISTS(SELECT 1 FROM (${query}) r WHERE r.k=${key})`).join(' OR ');
async function referencedKeys(env: Env, keys: string[], otherThan?: number, cached?: Awaited<ReturnType<typeof referenceQuery>>): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const refs = cached || await referenceQuery(env, otherThan);
  const rows = await all(env, `WITH candidates AS (SELECT value AS object_key FROM json_each(?)) SELECT object_key AS k FROM candidates WHERE ${referencePredicate(refs.queries, 'candidates.object_key')}`, JSON.stringify(keys), ...refs.params);
  return new Set(rows.map(row => row.k));
}
async function claimArtifactRemoval(env: Env, key: string, cached?: Awaited<ReturnType<typeof referenceQuery>>): Promise<boolean> {
  const refs = cached || await referenceQuery(env);
  const row = await first(env, `WITH candidate AS (SELECT ? AS object_key) INSERT INTO workspace_artifact_tombstones(object_key,claimed_at) SELECT object_key,? FROM candidate WHERE NOT (${referencePredicate(refs.queries, 'candidate.object_key')}) ON CONFLICT(object_key) DO UPDATE SET claimed_at=excluded.claimed_at RETURNING object_key`, key, now(), ...refs.params);
  return !!row;
}
async function boundedBytes(object: FileObject, limit: number): Promise<Uint8Array> {
  if (object.size > limit) throw new ApiError(422, 'Artifact exceeds the bounded export size.');
  const reader = object.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) { await reader.cancel(); throw new ApiError(422, 'Artifact exceeds the bounded export size.'); } chunks.push(part.value); }
  const value = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.length; } return value;
}
async function dispatch(env: Env, task: WorkspaceLifecycleTask, enqueue: Enqueue): Promise<void> {
  try { await enqueue(task); await run(env, `UPDATE ${task.kind === 'workspace_backup' ? 'workspace_backups' : 'workspace_deletions'} SET dispatched_at=? WHERE id=?`, now(), task.id); } catch { /* Durable queued row is recovered by maintenance. */ }
}
async function requestBackup(request: Request, env: Env, owner: number, enqueue: Enqueue): Promise<Response> {
  requireOrigin(request, env);
  await run(env, "UPDATE workspace_backups SET state='expired' WHERE user_id=? AND expires_at<=? AND state IN ('queued','running','ready')", owner, now());
  const results = await env.DB.batch<Row>([env.DB.prepare('SELECT profile_version FROM users WHERE id=?').bind(owner), env.DB.prepare("SELECT id FROM workspace_deletions WHERE user_id=? AND state IN ('queued','deleting')").bind(owner), env.DB.prepare("SELECT id FROM workspace_backups WHERE user_id=? AND state IN ('queued','running')").bind(owner)]);
  if (results[1].results.length || results[2].results.length) throw new ApiError(409, 'A workspace export or deletion is already active.');
  const day = now().slice(0, 10);
  const budget = await first(env, `INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 WHERE attempts<2 RETURNING attempts`, `workspace-backup:${day}`, Date.parse(day));
  if (!budget) throw new ApiError(429, 'The free deployment allows two workspace exports per UTC day. Try again tomorrow.');
  const id = crypto.randomUUID();
  try { await run(env, 'INSERT INTO workspace_backups(id,user_id,profile_version,created_at,expires_at) VALUES(?,?,?,?,?)', id, owner, results[0].results[0].profile_version, now(), expires(BACKUP_LIMITS.retentionMs)); }
  catch { throw new ApiError(409, 'A workspace export or deletion changed. Refresh before requesting another export.'); }
  await dispatch(env, { kind: 'workspace_backup', id }, enqueue);
  return json({ id, state: 'queued', expires_at: expires(BACKUP_LIMITS.retentionMs), status_url: `/account/backups/${id}` }, 202);
}
export async function processWorkspaceBackup(env: Env, id: string): Promise<{ requeue: boolean }> {
  if (!uuid(id)) return { requeue: false };
  const token = crypto.randomUUID();
  const row = await first(env, `UPDATE workspace_backups SET state='running',lease_token=?,lease_expires_at=? WHERE id=? AND state IN ('queued','running') AND expires_at>? AND (lease_expires_at IS NULL OR lease_expires_at<=?) RETURNING *`, token, expires(300000), id, now(), now());
  if (!row) return { requeue: false };
  try {
    if (!row.snapshot_key) {
      const snapshot = await captureSnapshot(env, row.user_id, row.profile_version), references = artifactKeys(snapshot);
      if ((await referencedKeys(env, references.map(r => r.source_key), row.user_id)).size) throw new ApiError(409, 'An artifact is referenced by another workspace; operator repair is required.');
      const bytes = encode(snapshot), key = `backups/${row.user_id}/${id}/snapshot.json`;
      await files(env).put(key, bytes, { httpMetadata: { contentType: 'application/json' } });
      const saved = await env.DB.batch([
        env.DB.prepare('UPDATE workspace_backups SET snapshot_key=?,snapshot_hash=?,captured_at=?,artifact_count=? WHERE id=? AND lease_token=? RETURNING id').bind(key, await sha(bytes), snapshot.captured_at, references.length, id, token),
        env.DB.prepare(`INSERT INTO workspace_backup_files(backup_id,ordinal,source_key,object_key,purpose) SELECT ?,CAST(j.key AS INTEGER),json_extract(j.value,'$.source_key'),?||j.key,json_extract(j.value,'$.purpose') FROM json_each(?) j WHERE EXISTS(SELECT 1 FROM workspace_backups WHERE id=? AND lease_token=?)`).bind(id, `backups/${row.user_id}/${id}/artifact-`, JSON.stringify(references), id, token),
      ]);
      if (!saved[0].results.length) await files(env).delete(key);
      return { requeue: saved[0].results.length > 0 };
    }
    const artifact = await first(env, "SELECT * FROM workspace_backup_files WHERE backup_id=? AND state='pending' ORDER BY ordinal LIMIT 1", id);
    if (artifact) {
      if ((await referencedKeys(env, [artifact.source_key], row.user_id)).size) throw new ApiError(409, 'An artifact ownership reference changed.');
      const object = await files(env).get(artifact.source_key);
      if (!object) throw new ApiError(409, 'A referenced artifact is missing; no complete backup can be produced.');
      const bytes = await boundedBytes(object, BACKUP_LIMITS.artifact);
      if (row.total_bytes + bytes.length > BACKUP_LIMITS.total) throw new ApiError(422, 'Workspace artifacts exceed the bounded export size.');
      const hash = await sha(bytes), contentType = object.httpMetadata?.contentType || 'application/octet-stream';
      await files(env).put(artifact.object_key, bytes, { httpMetadata: { contentType } });
      const result = await env.DB.batch([
        env.DB.prepare(`UPDATE workspace_backup_files SET state='captured',size=?,sha256=?,content_type=? WHERE backup_id=? AND ordinal=? AND EXISTS(SELECT 1 FROM workspace_backups WHERE id=? AND lease_token=?) RETURNING ordinal`).bind(bytes.length, hash, contentType, id, artifact.ordinal, id, token),
        env.DB.prepare('UPDATE workspace_backups SET total_bytes=(SELECT COALESCE(sum(size),0) FROM workspace_backup_files WHERE backup_id=?) WHERE id=? AND lease_token=?').bind(id, id, token),
      ]);
      if (!result[0].results.length) await files(env).delete(artifact.object_key);
      return { requeue: result[0].results.length > 0 };
    }
    const object = await files(env).get(row.snapshot_key);
    if (!object) throw new ApiError(409, 'Backup metadata is unavailable.');
    const snapshotBytes = await boundedBytes(object, BACKUP_LIMITS.metadata);
    if (await sha(snapshotBytes) !== row.snapshot_hash) throw new ApiError(409, 'Backup metadata failed its integrity check.');
    const snapshot = JSON.parse(new TextDecoder().decode(snapshotBytes)) as WorkspaceSnapshot;
    const captured = await all(env, 'SELECT * FROM workspace_backup_files WHERE backup_id=? ORDER BY ordinal', id);
    const manifest: WorkspaceManifest = { format: WORKSPACE_ARCHIVE_FORMAT, backup_id: id, source_owner_id: row.user_id, captured_at: row.captured_at,
      snapshot: { name: 'snapshot.json', size: snapshotBytes.length, sha256: row.snapshot_hash }, counts: Object.fromEntries(Object.entries(snapshot.tables).map(([name, rows]) => [name, rows!.length])),
      artifacts: captured.map(a => ({ ordinal: a.ordinal, source_key: a.source_key, purpose: a.purpose, size: a.size, sha256: a.sha256, content_type: a.content_type, name: `artifacts/${a.ordinal}.bin` })) };
    const bytes = encode(manifest), key = `backups/${row.user_id}/${id}/manifest.json`;
    await files(env).put(key, bytes, { httpMetadata: { contentType: 'application/json' } });
    await run(env, "UPDATE workspace_backups SET state='ready',manifest_key=?,manifest_hash=? WHERE id=? AND lease_token=?", key, await sha(bytes), id, token);
    return { requeue: false };
  } catch (error) {
    await run(env, "UPDATE workspace_backups SET state='failed',failure_reason=? WHERE id=? AND lease_token=?", error instanceof ApiError ? error.message : 'Workspace export could not finish. Retry after reviewing your storage configuration.', id, token);
    return { requeue: false };
  } finally { await run(env, 'UPDATE workspace_backups SET lease_token=NULL,lease_expires_at=NULL WHERE id=? AND lease_token=?', id, token); }
}

async function deletionPreview(request: Request, env: Env, owner: number): Promise<Response> {
  requireOrigin(request, env);
  const active = await first(env, "SELECT (SELECT count(*) FROM applications WHERE user_id=? AND status IN ('confirmed','applying'))+(SELECT count(*) FROM workspace_backups WHERE user_id=? AND state IN ('queued','running'))+(SELECT count(*) FROM workspace_deletions WHERE user_id=? AND state IN ('queued','deleting')) AS n", owner, owner, owner);
  if (active!.n) throw new ApiError(409, 'Cancel queued submissions and wait for active submissions/exports before deleting the workspace.');
  const user = await first(env, 'SELECT profile_version FROM users WHERE id=?', owner), snapshot = await captureSnapshot(env, owner, user!.profile_version);
  const keys = artifactKeys(snapshot, true).map(a => a.source_key);
  const archived = await all(env, 'SELECT snapshot_key AS k FROM workspace_backups WHERE user_id=? UNION SELECT manifest_key FROM workspace_backups WHERE user_id=? UNION SELECT f.object_key FROM workspace_backup_files f JOIN workspace_backups b ON b.id=f.backup_id WHERE b.user_id=?', owner, owner, owner);
  keys.push(...archived.map(row => row.k).filter((key): key is string => typeof key === 'string'));
  const reserved = await all(env, 'SELECT p.object_key AS k FROM resume_preparations p JOIN applications a ON a.id=p.application_id WHERE a.user_id=? AND p.object_key IS NOT NULL', owner);
  keys.push(...reserved.map(row => row.k));
  if (await first(env, "SELECT name FROM sqlite_master WHERE type='table' AND name='email_deliveries'")) {
    const deliveries = await all(env, 'SELECT report_key,payload_key,source_artifacts,state FROM email_deliveries WHERE user_id=? LIMIT 1025', owner);
    if (deliveries.some(row => row.state === 'sending')) throw new ApiError(409, 'Wait for the active email delivery before deleting the workspace.');
    if (deliveries.length > 1024) throw new ApiError(422, 'Workspace deletion exceeds the bounded artifact plan. Use the documented operator lifecycle procedure.');
    for (const row of deliveries) keys.push(row.report_key, row.payload_key, ...parsed<string[]>(row.source_artifacts, []));
  }
  if (keys.length > 1024 || keys.some(key => typeof key !== 'string' || key.length > 512 || key.includes('..') || key.includes('\\') || !(/^uploads\/[a-f0-9-]+\.pdf$/.test(key) || ['resumes','reports','prep-guides','backups','mail'].some(prefix => key.startsWith(`${prefix}/${owner}/`))))) throw new ApiError(409, 'The workspace contains an inconsistent or oversized private artifact deletion plan.');
  const shared = await referencedKeys(env, keys, owner), removable = [...new Set(keys)].filter(key => !shared.has(key));
  const revision = snapshot.workspace_revision;
  if ((await first(env, 'SELECT revision FROM workspace_revisions WHERE user_id=?', owner))?.revision !== revision) throw new ApiError(409, 'Workspace changed while preparing the preview. Request it again.');
  const nonce = crypto.randomUUID() + crypto.randomUUID(), id = crypto.randomUUID(), until = expires(300000);
  const existingTables = new Set((await all(env, "SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name));
  const direct = ['sessions','session_transfers','account_owners','account_passkeys','account_challenges','account_recovery_keys','discovery_runs','discovery_cycles','weekly_schedules','weekly_schedule_runs','workspace_reminders','email_deliveries','operation_events'].filter(table => existingTables.has(table));
  const indirect = ['outbox','resume_preparations','automation_checkpoints','prep_refreshes'].filter(table => existingTables.has(table));
  const counters = [...direct.map(table => `(SELECT count(*) FROM ${table} WHERE user_id=?) AS ${table}`), ...indirect.map(table => `(SELECT count(*) FROM ${table} t JOIN applications a ON a.id=t.application_id WHERE a.user_id=?) AS ${table}`)];
  if(existingTables.has('email_receipt_events'))counters.push('(SELECT count(*) FROM email_receipt_events r JOIN email_deliveries d ON d.id=r.delivery_id WHERE d.user_id=?) AS email_receipt_events');
  const additional = counters.length ? await first(env, `SELECT ${counters.join(',')}`, ...counters.map(() => owner)) : {};
  const preview = { profile_version: user!.profile_version, revision, counts: { ...Object.fromEntries(Object.entries(snapshot.tables).map(([t, rows]) => [t, rows!.length])), ...additional }, artifacts_to_remove: removable.length, shared_artifacts_retained: shared.size, includes_submitted_history: (snapshot.tables.applications || []).some(a => !!a.applied_at), warning: 'This permanently removes this workspace, including its submitted history, PDFs, reports and saved authentication. Export and download anything you need first.' };
  await run(env, 'INSERT INTO workspace_deletions(id,user_id,profile_version,revision,session_hash,nonce_hash,expires_at,state,preview_json,files_json,created_at) VALUES(?,?,?,?,?,?,?,\'preview\',?,?,?)', id, owner, user!.profile_version, revision, await sessionHash(request), await digest(nonce), until, JSON.stringify(preview), JSON.stringify(removable), now());
  return json({ id, nonce, expires_at: until, ...preview });
}
async function confirmDeletion(request: Request, env: Env, owner: number, enqueue: Enqueue): Promise<Response> {
  requireOrigin(request, env); const body = await readJson(request);
  if (!uuid(body.id || '') || typeof body.nonce !== 'string' || body.nonce.length > 100 || body.confirmation !== 'DELETE MY WORKSPACE' || !Number.isSafeInteger(body.profile_version)) throw new ApiError(422, 'Review the deletion preview and explicitly confirm DELETE MY WORKSPACE.');
  const row = await first(env, `UPDATE workspace_deletions SET state='queued',nonce_hash=NULL WHERE id=? AND user_id=? AND state='preview' AND nonce_hash=? AND session_hash=? AND expires_at>? AND profile_version=? AND profile_version=(SELECT profile_version FROM users WHERE id=?) AND revision=(SELECT revision FROM workspace_revisions WHERE user_id=?) RETURNING id`, body.id, owner, await digest(body.nonce), await sessionHash(request), now(), body.profile_version, owner, owner);
  if (!row) throw new ApiError(409, 'Deletion preview expired or the workspace changed. Request a new preview.');
  await dispatch(env, { kind: 'workspace_delete', id: row.id }, enqueue); return json({ id: row.id, state: 'queued' }, 202);
}
export async function processWorkspaceDeletion(env: Env, id: string): Promise<{ requeue: boolean }> {
  if (!uuid(id)) return { requeue: false };
  let row = await first(env, 'SELECT * FROM workspace_deletions WHERE id=?', id); if (!row || !['queued', 'deleting'].includes(row.state)) return { requeue: false };
  const token = crypto.randomUUID();
  if (row.state === 'queued') {
    const result = await env.DB.batch<Row>([
      env.DB.prepare(`UPDATE workspace_deletions SET state='deleting',lease_token=?,lease_expires_at=?,session_hash=NULL WHERE id=? AND state='queued' AND profile_version=(SELECT profile_version FROM users WHERE id=workspace_deletions.user_id) AND revision=(SELECT revision FROM workspace_revisions WHERE user_id=workspace_deletions.user_id) AND NOT EXISTS(SELECT 1 FROM applications WHERE user_id=workspace_deletions.user_id AND status IN ('confirmed','applying')) RETURNING *`).bind(token, expires(300000), id),
      env.DB.prepare("DELETE FROM shortlists WHERE user_id=? AND EXISTS(SELECT 1 FROM workspace_deletions WHERE id=? AND lease_token=?)").bind(row.user_id, id, token),
      env.DB.prepare('DELETE FROM users WHERE id=? AND EXISTS(SELECT 1 FROM workspace_deletions WHERE id=? AND lease_token=?)').bind(row.user_id, id, token),
    ]);
    if (!result[0].results.length) { await run(env, "UPDATE workspace_deletions SET state='cancelled',failure_reason='Workspace changed before deletion. Request a fresh preview.' WHERE id=? AND state='queued'", id); return { requeue: false }; }
    row = result[0].results[0];
  } else {
    row = await first(env, "UPDATE workspace_deletions SET lease_token=?,lease_expires_at=? WHERE id=? AND state='deleting' AND (lease_expires_at IS NULL OR lease_expires_at<=?) RETURNING *", token, expires(300000), id, now());
    if (!row) return { requeue: false };
  }
  try {
    const keys = parsed<string[]>(row.files_json, []), key = keys[row.cursor];
    if (key) {
      if (await claimArtifactRemoval(env, key)) await files(env).delete(key);
      await run(env, 'UPDATE workspace_deletions SET cursor=cursor+1 WHERE id=? AND lease_token=?', id, token); return { requeue: true };
    }
    await run(env, "UPDATE workspace_deletions SET state='complete',files_json='[]',preview_json='{}' WHERE id=? AND lease_token=?", id, token); return { requeue: false };
  } finally { await run(env, 'UPDATE workspace_deletions SET lease_token=NULL,lease_expires_at=NULL WHERE id=? AND lease_token=?', id, token); }
}

export async function pendingWorkspaceLifecycleTasks(env: Env): Promise<WorkspaceLifecycleTask[]> {
  const result = await env.DB.batch<Row>([env.DB.prepare("SELECT id FROM workspace_backups WHERE state IN ('queued','running') AND expires_at>? AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY created_at LIMIT 2").bind(now(), now()), env.DB.prepare("SELECT id FROM workspace_deletions WHERE state IN ('queued','deleting') AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY created_at LIMIT 2").bind(now())]);
  return [...result[0].results.map(row => ({ kind: 'workspace_backup' as const, id: row.id })), ...result[1].results.map(row => ({ kind: 'workspace_delete' as const, id: row.id }))];
}

/** Disabled by default. The operator must explicitly enable retention only
 * after the isolated restore/deletion drill. One bounded native list page. */
export async function cleanupWorkspaceOrphans(env: Env, options: { execute?: boolean } = {}): Promise<Row> {
  const prefixes = ['uploads/', 'resumes/', 'reports/', 'prep-guides/'];
  const state = await first(env, 'SELECT * FROM workspace_retention_cursor WHERE id=1');
  const prefix = prefixes[state!.prefix_index % prefixes.length], cursor = state!.cursor || undefined;
  let keys: string[], next: string | undefined;
  if (env.FILES) { const page = await env.FILES.list({ prefix, cursor, limit: 10 }); keys = page.objects.map(object => object.key); next = page.truncated ? page.cursor : undefined; }
  else if (env.FILES_KV) { const page = await env.FILES_KV.list({ prefix, cursor, limit: 10 }); keys = page.keys.map(key => key.name); next = page.list_complete ? undefined : page.cursor; }
  else throw new ApiError(503, 'Private file storage is unavailable.');
  const references = await referenceQuery(env);
  const referenced = await referencedKeys(env, keys, undefined, references), candidate = keys.filter(key => !referenced.has(key));
  const eligible = await all(env, 'SELECT object_key FROM workspace_orphan_candidates WHERE first_seen_at<=? AND object_key IN (SELECT value FROM json_each(?))', new Date(Date.now() - BACKUP_LIMITS.orphanMs).toISOString(), JSON.stringify(candidate));
  if (!options.execute) return { dry_run: true, scanned: keys.length, referenced: referenced.size, previously_observed_orphans: eligible.length, deleted: 0 };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspace_orphan_candidates(object_key,first_seen_at) SELECT value,? FROM json_each(?) WHERE true ON CONFLICT(object_key) DO NOTHING").bind(now(), JSON.stringify(candidate)),
    env.DB.prepare('DELETE FROM workspace_orphan_candidates WHERE object_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...referenced])),
    env.DB.prepare('UPDATE workspace_retention_cursor SET prefix_index=?,cursor=? WHERE id=1').bind(next ? state!.prefix_index : (state!.prefix_index + 1) % prefixes.length, next || null),
  ]);
  let deleted = 0;
  for (const row of eligible) {
    // Recheck immediately before deletion; newly published/reviewed/submitted
    // documents must survive even if they were candidates seven days earlier.
    if (!await claimArtifactRemoval(env, row.object_key, references)) continue;
    await files(env).delete(row.object_key); await run(env, 'DELETE FROM workspace_orphan_candidates WHERE object_key=?', row.object_key); deleted++;
  }
  return { dry_run: false, scanned: keys.length, referenced: referenced.size, deleted };
}

export async function expireWorkspaceBackupArtifacts(env: Env, options: { execute?: boolean } = {}): Promise<Row> {
  const row = await first(env, 'SELECT * FROM workspace_backups WHERE expires_at<=? ORDER BY expires_at LIMIT 1', now());
  if (!row) return { dry_run: !options.execute, expired_backups: 0, deleted: 0 };
  const catalog = await all(env, 'SELECT object_key FROM workspace_backup_files WHERE backup_id=? ORDER BY ordinal LIMIT 8', row.id);
  const keys: string[] = [...catalog.map(r => r.object_key), ...(!catalog.length ? [row.snapshot_key, row.manifest_key].filter((k): k is string => typeof k === 'string') : [])];
  if (!options.execute) return { dry_run: true, expired_backups: 1, candidate_artifacts: keys.length, deleted: 0 };
  let deleted = 0;
  for (const key of keys) if (await claimArtifactRemoval(env, key)) { await files(env).delete(key); deleted++; }
  await run(env, 'DELETE FROM workspace_backup_files WHERE backup_id=? AND object_key IN (SELECT value FROM json_each(?))', row.id, JSON.stringify(catalog.map(r => r.object_key)));
  if (!catalog.length) await run(env, 'DELETE FROM workspace_backups WHERE id=? AND expires_at<=?', row.id, now());
  else await run(env, "UPDATE workspace_backups SET state='expired' WHERE id=?", row.id);
  return { dry_run: false, expired_backups: 1, deleted };
}
export async function workspaceBackupRoutes(request: Request, env: Env, enqueue: Enqueue): Promise<Response | null> {
  const path = new URL(request.url).pathname, backup = path.match(/^\/account\/backups\/([a-f0-9-]+)(?:\/(manifest|snapshot|artifacts\/\d+))?$/);
  if (path !== '/account/backups' && path !== '/account/deletion-preview' && path !== '/account/delete' && !backup) return null;
  const owner = await requireUser(request, env);
  if (request.method === 'POST' && path === '/account/backups') return requestBackup(request, env, owner, enqueue);
  if (request.method === 'POST' && path === '/account/deletion-preview') return deletionPreview(request, env, owner);
  if (request.method === 'POST' && path === '/account/delete') return confirmDeletion(request, env, owner, enqueue);
  if (request.method !== 'GET' || !backup || !uuid(backup[1])) throw new ApiError(404, 'Workspace export is unavailable.');
  const row = await first(env, 'SELECT * FROM workspace_backups WHERE id=? AND user_id=?', backup[1], owner);
  if (!row) throw new ApiError(404, 'Workspace export is unavailable.');
  if (!backup[2]) return json({ id: row.id, state: row.state, failure_reason: row.failure_reason, artifact_count: row.artifact_count, bytes: row.total_bytes, expires_at: row.expires_at, manifest_hash: row.manifest_hash, manifest_url: row.state === 'ready' ? `/account/backups/${row.id}/manifest` : null });
  if (row.state !== 'ready' || row.expires_at <= now()) throw new ApiError(410, 'Workspace export is not ready or has expired.');
  let key = backup[2] === 'manifest' ? row.manifest_key : row.snapshot_key;
  if (backup[2].startsWith('artifacts/')) { const ordinal = Number(backup[2].split('/')[1]); if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= BACKUP_LIMITS.files) throw new ApiError(404, 'Export artifact is unavailable.'); const artifact = await first(env, 'SELECT object_key FROM workspace_backup_files WHERE backup_id=? AND ordinal=?', row.id, ordinal); key = artifact?.object_key; }
  const object = key ? await files(env).get(key) : null; if (!object) throw new ApiError(410, 'Export artifact is unavailable.');
  const filename = backup[2] === 'manifest' ? 'manifest.json' : backup[2] === 'snapshot' ? 'snapshot.json' : `${Number(backup[2].split('/')[1])}.bin`;
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** Called only by the offline local CLI/test runtime. No public route exposes
 * this function and the production Worker has no RESTORE_ISOLATED binding. */
export async function restoreWorkspaceArchive(
  env: Env & { RESTORE_ISOLATED?: string }, manifestBytes: Uint8Array, snapshotBytes: Uint8Array,
  trustedManifestHash: string, readArtifact: (ordinal: number) => Promise<Uint8Array>,
): Promise<{ user_id: number; application_ids: Record<string, number>; job_ids: Record<string, number>; artifact_keys: Record<string, string> }> {
  if (env.RESTORE_ISOLATED !== 'true') throw new ApiError(403, 'Restore is available only in the isolated offline operator runtime.');
  if (manifestBytes.length > 256000 || snapshotBytes.length > BACKUP_LIMITS.metadata || !/^[a-f0-9]{64}$/.test(trustedManifestHash) || await sha(manifestBytes) !== trustedManifestHash) throw new ApiError(422, 'Archive manifest integrity check failed.');
  let manifest: WorkspaceManifest, snapshot: WorkspaceSnapshot;
  try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); snapshot = JSON.parse(new TextDecoder().decode(snapshotBytes)); } catch { throw new ApiError(422, 'Archive metadata must contain valid JSON.'); }
  if (manifest.format !== WORKSPACE_ARCHIVE_FORMAT || snapshot.format !== WORKSPACE_ARCHIVE_FORMAT || !Number.isSafeInteger(manifest.source_owner_id) || manifest.source_owner_id < 1 || snapshot.source_owner_id !== manifest.source_owner_id || manifest.snapshot?.size !== snapshotBytes.length || manifest.snapshot.sha256 !== await sha(snapshotBytes) || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > BACKUP_LIMITS.files || !snapshot.tables || typeof snapshot.tables !== 'object') throw new ApiError(422, 'Archive metadata or snapshot integrity check failed.');
  const columns = await schema(env), names = Object.keys(snapshot.tables) as TableName[];
  if (names.some(name => !columns.has(name) || !Object.hasOwn(tableLimits, name))) throw new ApiError(422, 'Archive has an unsupported table.');
  for (const name of names) {
    const rows = snapshot.tables[name];
    if (!Array.isArray(rows) || rows.length > tableLimits[name]) throw new ApiError(422, 'Archive exceeds a table bound.');
    const expected = rows[0] ? Object.keys(rows[0]).sort().join(',') : '';
    for (const row of rows) if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !columns.get(name)!.includes(key)) || Object.keys(row).sort().join(',') !== expected) throw new ApiError(422, 'Archive columns do not match the installed schema.');
  }
  const users = snapshot.tables.users || [];
  if (users.length !== 1 || users[0].id !== manifest.source_owner_id) throw new ApiError(422, 'Archive owner identity is inconsistent.');
  for (const name of names) for (const row of snapshot.tables[name]!) if (Object.hasOwn(row, 'user_id') && row.user_id !== manifest.source_owner_id) throw new ApiError(422, 'Archive contains data belonging to another workspace.');
  const idMap = (rows: Row[]) => {
    const result = new Map<number, number>();
    for (const [i, row] of rows.entries()) { if (!Number.isSafeInteger(row.id) || row.id < 1 || result.has(row.id)) throw new ApiError(422, 'Archive row identity is invalid.'); result.set(row.id, i + 1); } return result;
  };
  const jobs = idMap(snapshot.tables.jobs || []), applications = idMap(snapshot.tables.applications || []), guides = idMap(snapshot.tables.prep_guides || []);
  const requiredKeys = artifactKeys(snapshot), bySource = new Map<string, ArchiveArtifact>(); let total = 0;
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (artifact.ordinal !== index || artifact.name !== `artifacts/${index}.bin` || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > BACKUP_LIMITS.artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256) || typeof artifact.content_type !== 'string' || artifact.content_type.length > 120 || /[\r\n]/.test(artifact.content_type) || bySource.has(artifact.source_key) || !requiredKeys.some(k => k.source_key === artifact.source_key && k.purpose === artifact.purpose)) throw new ApiError(422, 'Archive artifact catalog is invalid.');
    bySource.set(artifact.source_key, artifact); total += artifact.size;
  }
  if (total > BACKUP_LIMITS.total || requiredKeys.length !== bySource.size) throw new ApiError(422, 'Archive artifact bounds or references are inconsistent.');
  for (const name of names) for (const row of snapshot.tables[name]!) {
    if (row.application_id !== undefined && !applications.has(row.application_id)) throw new ApiError(422, 'Archive application ownership is inconsistent.');
    if (name === 'applications' && !jobs.has(row.job_id)) throw new ApiError(422, 'Archive job references are inconsistent.');
    if (row.guide_id !== undefined && (!guides.has(row.guide_id) || snapshot.tables.prep_guides!.find(guide => guide.id === row.guide_id)?.application_id !== row.application_id)) throw new ApiError(422, 'Archive guide references are inconsistent.');
  }
  const isolationTables = [...new Set([...columns.keys(), 'sessions', 'account_owners', 'account_passkeys', 'account_recovery_keys', 'submission_reviews', 'outbox'])];
  const empty = await env.DB.batch<Row>(isolationTables.map(table => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`)));
  if (empty.some(row => row.results[0].n)) throw new ApiError(409, 'Restore requires a completely empty, isolated destination database.');
  const restoreId = crypto.randomUUID(), pathMap = new Map<string, string>(), created: string[] = [];
  const remapValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (pathMap.has(value)) return pathMap.get(value)!;
      const resume = value.match(/^\/resumes\/(\d+)\/(\d+)\/download$/), guide = value.match(/^\/applications\/(\d+)\/prep-guide$/);
      if (resume && Number(resume[1]) === manifest.source_owner_id && applications.has(Number(resume[2]))) return `/resumes/1/${applications.get(Number(resume[2]))}/download`;
      if (guide && applications.has(Number(guide[1]))) return `/applications/${applications.get(Number(guide[1]))}/prep-guide`;
      return value;
    }
    if (Array.isArray(value)) return value.map(remapValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapValue(v)]));
    return value;
  };
  try {
    // Validate/copy one bounded artifact at a time. No all-file/base64 archive
    // is materialized inside the Worker. SQL is committed only after all hashes.
    for (const artifact of manifest.artifacts) {
      const bytes = await readArtifact(artifact.ordinal);
      if (bytes.length !== artifact.size || bytes.length > BACKUP_LIMITS.artifact || await sha(bytes) !== artifact.sha256) throw new ApiError(422, 'Archive artifact integrity check failed.');
      const key = artifact.purpose === 'master' ? `uploads/${crypto.randomUUID()}.pdf` : artifact.purpose === 'resume' ? `resumes/1/restored_${restoreId}_${artifact.ordinal}.pdf` : artifact.purpose === 'report' ? `reports/1/restored_${restoreId}_${artifact.ordinal}.html` : `prep-guides/1/restored_${restoreId}_${artifact.ordinal}.bin`;
      await files(env).put(key, bytes, { httpMetadata: { contentType: artifact.content_type } }); created.push(key); pathMap.set(artifact.source_key, key);
    }
    const data: Partial<Record<TableName, Row[]>> = {};
    for (const name of names) data[name] = snapshot.tables[name]!.map((original, index) => {
      const row: Row = { ...original };
      row.id = name === 'prep_guide_exports' ? crypto.randomUUID() : index + 1;
      if (Object.hasOwn(row, 'user_id')) row.user_id = 1;
      if (Object.hasOwn(row, 'application_id')) row.application_id = applications.get(original.application_id);
      if (name === 'applications') {
        row.job_id = jobs.get(original.job_id); row.confirmed_review_id = null; row.processing_started_at = null; row.scored_profile_version = 0;
        if (['confirmed', 'applying'].includes(row.status)) { row.status = 'needs_action'; row.failure_reason = 'Restored incomplete submission. Check the employer site before any new review or application.'; row.manual_action_url ||= parsed<Row>(row.job_snapshot, {}).application_url || snapshot.tables.jobs!.find(job => job.id === original.job_id)?.url; }
        if (['pending', 'planned'].includes(row.status)) { row.resume_path = null; row.failure_reason = 'Restored draft. Prepare a fresh PDF and review its answers before confirming.'; }
        else if (row.resume_path) row.resume_path = pathMap.get(row.resume_path);
      }
      if (name === 'users') { row.id = 1; row.profile_version = Number(row.profile_version) + 1; row.master_profile = JSON.stringify(remapValue(safeProfile(row.master_profile))); }
      if (name === 'resumes') { row.object_key = pathMap.get(original.object_key); row.profile_snapshot = JSON.stringify(remapValue(safeProfile(row.profile_snapshot))); }
      if (name === 'weekly_reports') { row.html_path = pathMap.get(original.html_path); row.content = JSON.stringify(remapValue(parsed(row.content, {}))); }
      if (name === 'prep_guide_exports') {
        row.guide_id = guides.get(original.guide_id); row.input_snapshot = '{}'; row.dispatched_at = null; row.started_at = null;
        row.html_key = pathMap.get(original.html_key) || `prep-guides/1/restored_${restoreId}_${row.id}.html`;
        row.pdf_key = pathMap.get(original.pdf_key) || `prep-guides/1/restored_${restoreId}_${row.id}.pdf`;
        if (['queued', 'running'].includes(row.state)) { row.state = 'failed'; row.failure_reason = 'Restored unfinished export. Request a fresh guide export.'; row.cleaned_at = now(); }
      }
      return row;
    });
    const token = crypto.randomUUID(), emptyPredicate = isolationTables.map(table => `NOT EXISTS(SELECT 1 FROM ${table})`).join(' AND ');
    const statements = [env.DB.prepare(`INSERT INTO workspace_restore_guard(id,source_owner_id,created_at) SELECT ?,?,? WHERE ${emptyPredicate}`).bind(token, manifest.source_owner_id, now())];
    const bulk = (table: TableName, rows: Row[]) => {
      if (!rows.length) return;
      const fields = Object.keys(rows[0]); let chunk: Row[] = [], size = 0;
      const flush = () => { if (!chunk.length) return; statements.push(env.DB.prepare(`INSERT INTO ${table}(${fields.join(',')}) SELECT ${fields.map(c => `json_extract(value,'$.${c}')`).join(',')} FROM json_each(?) WHERE EXISTS(SELECT 1 FROM workspace_restore_guard WHERE id=?)`).bind(JSON.stringify(chunk), token)); chunk = []; size = 0; };
      for (const row of rows) { const length = encode(row).length; if (length > 1500000) throw new ApiError(422, 'A restore row exceeds the safe D1 binding size. Use the documented operator database migration path.'); if (size + length > 1500000) flush(); chunk.push(row); size += length + 1; } flush();
    };
    for (const name of ['users', 'jobs', 'applications'] as TableName[]) bulk(name, data[name] || []);
    statements.push(env.DB.prepare('DELETE FROM application_status_events WHERE EXISTS(SELECT 1 FROM workspace_restore_guard WHERE id=?)').bind(token));
    for (const name of ['application_status_events', 'resumes', 'prep_guides', 'weekly_reports', 'shortlists', 'prep_guide_exports'] as TableName[]) bulk(name, data[name] || []);
    const historicalCount = data.application_status_events?.length || 0;
    const restoredEvents = (data.applications || []).filter(row => ['pending', 'planned', 'needs_action'].includes(row.status)).map((row, index) => ({ id: historicalCount + index + 1, application_id: row.id, status: row.status, reason: row.failure_reason || 'Restored without execution authority; fresh review is required.', created_at: now() }));
    bulk('application_status_events', restoredEvents);
    if (statements.length > 45) throw new ApiError(422, 'Restore exceeds the bounded D1 transaction size.');
    const results = await env.DB.batch(statements);
    if (!results[0].meta.changes) throw new ApiError(409, 'Destination changed; no workspace rows were imported.');
    return { user_id: 1, application_ids: Object.fromEntries(applications), job_ids: Object.fromEntries(jobs), artifact_keys: Object.fromEntries(pathMap) };
  } catch (error) { for (const key of created) await files(env).delete(key); throw error; }
}
