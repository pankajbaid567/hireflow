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
export const applicationQuery = `SELECT a.*,j.title,j.company,j.url,j.description,j.location,j.listing_type,j.is_spam,j.posted_date
  FROM applications a JOIN jobs j ON j.id=a.job_id`;
export async function applicationData(env: Env, a: Row) {
  const history = await all(env, 'SELECT status,reason,created_at AS timestamp FROM application_status_events WHERE application_id=? ORDER BY id', a.id);
  const guide = await first(env, 'SELECT id FROM prep_guides WHERE application_id=?', a.id);
  return {
    id: a.id, job_id: a.job_id, company: a.company, role: a.title, status: a.status,
    match_score: a.match_score, skill_gaps: parsed(a.skill_gaps, []), resume_version: a.resume_version,
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
      await env.APPLICATION_QUEUE.send({ application_id: task.application_id, kind: task.kind });
      await run(env, 'UPDATE outbox SET dispatched_at=? WHERE id=?', new Date().toISOString(), task.id);
    } catch { break; } // Durable outbox is retried by the scheduled handler.
  }
}
