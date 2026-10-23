import { ApiError, type Env, type Row, parsed } from './types';

export const all = async (env: Env, sql: string, ...params: any[]): Promise<Row[]> =>
  (await env.DB.prepare(sql).bind(...params).all<Row>()).results;
export const first = (env: Env, sql: string, ...params: any[]): Promise<Row | null> =>
  env.DB.prepare(sql).bind(...params).first<Row>();
export const run = (env: Env, sql: string, ...params: any[]) => env.DB.prepare(sql).bind(...params).run();
export async function userById(env: Env, id: number) {
  const row = await first(env, 'SELECT * FROM users WHERE id=?', id);
  if (!row) throw new ApiError(404, 'Profile not found');
  row.master_profile = parsed(row.master_profile, {});
  return row;
}
export const applicationQuery = `SELECT a.*,j.title,j.company,j.url,j.description,j.location,j.listing_type,j.is_spam,j.posted_date,
  j.canonical_url,j.application_url,j.source,j.required_skills,j.required_experience,j.expires_at,j.selection_process,j.compensation,j.provenance,j.company_key,j.spam_confidence,j.quality_reason,j.quality_method,j.facts_version
  FROM applications a JOIN jobs j ON j.id=a.job_id`;
const listingFields=['title','company','url','description','location','listing_type','posted_date','expires_at','canonical_url','application_url','source','required_skills','required_experience','selection_process','compensation','provenance','company_key','facts_version'] as const;
export function listingSnapshot(row:Row):Row{return Object.fromEntries(listingFields.map(key=>[key,row[key]??null]));}
export function historicalListing(row:Row):Row{
  if(['pending','planned'].includes(row.status))return row;
  const snapshot=parsed<Row>(row.job_snapshot,{});
  return {...row,...Object.fromEntries(listingFields.filter(key=>Object.hasOwn(snapshot,key)).map(key=>[key,snapshot[key]]))};
}
export async function applicationData(env: Env, a: Row) {
  a=historicalListing(a);
  const history = await all(env, 'SELECT status,reason,created_at AS timestamp FROM application_status_events WHERE application_id=? ORDER BY id', a.id);
  const guide = await first(env, 'SELECT id FROM prep_guides WHERE application_id=?', a.id);
  return {
    id: a.id, job_id: a.job_id, company: a.company, role: a.title, status: a.status,
    match_score: a.match_score, skill_gaps: parsed(a.skill_gaps, []), resume_version: a.resume_version,
    listing_type:a.listing_type,source:a.source,canonical_url:a.canonical_url||a.url,application_url:a.application_url||a.url,
    required_skills:parsed(a.required_skills,[]),required_experience:parsed(a.required_experience,null),expires_at:a.expires_at,
    compensation:parsed(a.compensation,null),selection_process:parsed(a.selection_process,[]),provenance:parsed(a.provenance,{}),
    resume_url: a.resume_path ? `/resumes/${a.user_id}/${a.id}/download` : null,
    prep_guide_url: guide ? `/applications/${a.id}/prep-guide` : null,
    failure_reason: a.failure_reason, manual_action_url: a.manual_action_url,
    applied_at: a.applied_at, created_at: a.created_at, attempts: a.attempts, status_history: history,
  };
}

// D1 executes a batch as a transaction. Audit triggers record each committed change.
export async function transition(env: Env, id: number, expected: string, status: string, reason: string | null = null, manualUrl: string | null = null) {
  return run(env, `UPDATE applications SET status=?,failure_reason=?,manual_action_url=?,updated_at=?,
    applied_at=CASE WHEN ?='applied' THEN ? ELSE applied_at END WHERE id=? AND status=?`,
  status, reason, manualUrl, new Date().toISOString(), status, new Date().toISOString(), id, expected);
}

export async function dispatchOutbox(env: Env) {
  const tasks = await all(env, 'SELECT * FROM outbox WHERE dispatched_at IS NULL ORDER BY id LIMIT 5');
  // Duplicate queue deliveries are safe: application claims and prep inserts are conditional.
  for (const task of tasks) {
    try {
      await env.APPLICATION_QUEUE.send({ application_id: task.application_id, kind: task.kind, ...(task.kind === 'apply' && task.review_id ? {review_id: task.review_id} : {}) });
      // Cancellation may remove a row while send() is in flight. SQLite can
      // reuse its integer ID for a new approval; never mark that generation sent.
      await run(env, 'UPDATE outbox SET dispatched_at=? WHERE id=? AND application_id=? AND kind=? AND review_id IS ? AND dispatched_at IS NULL', new Date().toISOString(), task.id,task.application_id,task.kind,task.review_id??null);
    } catch { break; } // Durable outbox is retried by the scheduled handler.
  }
}
