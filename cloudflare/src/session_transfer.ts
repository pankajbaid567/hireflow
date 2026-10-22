import { digest, requireUser, startSession } from './auth';
import { readJson } from './profile';
import { first, run } from './storage';
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
  await run(env, 'INSERT INTO session_transfers(token_hash,user_id,expires_at) VALUES(?,?,?)',
    await digest(token), userId, new Date(Date.now() + transferLifetimeMs).toISOString());
  // A fragment does not travel in HTTP request URLs, access logs, or referrers.
  return json({ transfer_url: `${origin}/profile#transfer=${token}` });
}

/** DELETE RETURNING gives concurrent consumers exactly one winner in D1. */
export async function consumeTransfer(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('origin') !== targetOrigin(env)) throw new ApiError(403, 'Open the transfer on the new workspace website.');
  const data = await readJson(request);
  if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) throw new ApiError(401, unavailable);
  const row = await first(env, 'DELETE FROM session_transfers WHERE token_hash=? AND expires_at>? RETURNING user_id',
    await digest(data.token), new Date().toISOString());
  if (!row) throw new ApiError(401, unavailable);
  return json({ authenticated: true, user_id: row.user_id }, 200,
    { 'Set-Cookie': await startSession(request, env, row.user_id) });
}
