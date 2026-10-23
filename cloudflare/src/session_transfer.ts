import { digest, requireUser, sessionHash, prepareSession } from './auth';
import { readJson } from './profile';
import { first } from './storage';
import { ApiError, type Env, json } from './types';

const transferLifetimeMs = 5 * 60 * 1000;
const unavailable = 'This workspace transfer has expired or already been used. Open it again from your signed-in browser.';

function targetOrigin(env: Env): string {
  let target: URL;
  try { target = new URL(env.PUBLIC_BASE_URL); }
  catch { throw new ApiError(503, 'Workspace migration is not configured.'); }
  const approved = (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim());
  if (target.protocol !== 'https:' || target.username || target.password || !approved.includes(target.origin)) {
    throw new ApiError(503, 'Workspace migration is not configured.');
  }
  return target.origin;
}

/** Only the already authenticated browser can mint a short-lived migration link. */
export async function createTransfer(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  const origin = targetOrigin(env);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
  const source = await sessionHash(request), now = new Date().toISOString();
  const saved = await first(env, `INSERT INTO session_transfers(token_hash,user_id,expires_at,source_session_hash)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?) RETURNING token_hash`,
    await digest(token), userId, new Date(Date.now() + transferLifetimeMs).toISOString(), source, source, userId, now);
  if (!saved) throw new ApiError(401, unavailable);
  // A fragment does not travel in HTTP request URLs, access logs, or referrers.
  return json({ transfer_url: `${origin}/profile#transfer=${token}` });
}

/** Source validation, unique claim, replacement session and consumption commit together. */
export async function consumeTransfer(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('origin') !== targetOrigin(env)) throw new ApiError(403, 'Open the transfer on the new workspace website.');
  const data = await readJson(request);
  if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) throw new ApiError(401, unavailable);
  const hash = await digest(data.token);
  const row = await first(env, `SELECT t.user_id FROM session_transfers t JOIN sessions s ON s.token_hash=t.source_session_hash AND s.user_id=t.user_id
    WHERE t.token_hash=? AND t.expires_at>? AND t.claimed_session_id IS NULL AND s.expires_at>?`, hash, new Date().toISOString(), new Date().toISOString());
  if (!row) throw new ApiError(401, unavailable);
  const session = await prepareSession(request, env, row.user_id), now = new Date().toISOString();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE session_transfers SET claimed_session_id=? WHERE token_hash=? AND expires_at>? AND claimed_session_id IS NULL
      AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=session_transfers.source_session_hash AND user_id=session_transfers.user_id AND expires_at>?) RETURNING user_id`)
      .bind(session.id, hash, now, now),
    env.DB.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at,id,created_at,label)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM session_transfers WHERE token_hash=? AND claimed_session_id=?) RETURNING id`)
      .bind(session.token_hash, session.user_id, session.expires_at, session.id, session.created_at, session.label, hash, session.id),
    env.DB.prepare(`DELETE FROM session_transfers WHERE token_hash=? AND claimed_session_id=?
      AND EXISTS(SELECT 1 FROM sessions WHERE id=?) RETURNING token_hash`).bind(hash, session.id, session.id),
  ]);
  if (!result[0].results.length || !result[1].results.length || !result[2].results.length) throw new ApiError(401, unavailable);
  return json({ authenticated: true, user_id: row.user_id }, 200,
    { 'Set-Cookie': session.cookie });
}
