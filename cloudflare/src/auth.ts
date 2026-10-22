import { ApiError, type Env, json } from './types';
import { first, run } from './storage';

const cookieName = 'hireflow_session';
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}
export async function sessionUser(request: Request, env: Env): Promise<number | null> {
  const token = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await first(env, 'SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?', await digest(token), new Date().toISOString());
  return row?.user_id ?? null;
}
export async function requireUser(request: Request, env: Env, id?: number) {
  const userId = await sessionUser(request, env);
  if (!userId) throw new ApiError(401, 'Your session is unavailable. Open your profile page to continue.');
  if (id !== undefined && userId !== id) throw new ApiError(404, 'Resource not found');
  return userId;
}
export async function checkAccessCode(request: Request, env: Env, supplied?: string) {
  if (!env.ACCESS_CODE || env.ACCESS_CODE.length < 24) throw new ApiError(503, 'Configure an ACCESS_CODE secret with at least 24 characters.');
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const key = await digest(ip);
  const now = Date.now();
  await run(env, `INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,0,?)
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 0 ELSE attempts END,
    window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END`, key, now, now - 600000, now - 600000);
  // Atomic increment avoids concurrent requests bypassing the attempt cap.
  const attempt = await first(env, 'UPDATE login_attempts SET attempts=attempts+1 WHERE key=? AND attempts<10 RETURNING attempts', key);
  if (!attempt) throw new ApiError(429, 'Too many sign-in attempts. Try again in 10 minutes.');
  const a = await digest(supplied || request.headers.get('x-hireflow-access-code') || '');
  const b = await digest(env.ACCESS_CODE);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  if (difference) throw new ApiError(401, 'Email or access code is incorrect.');
  await run(env,'DELETE FROM login_attempts WHERE key=?',key);
}
// The public frontend may bootstrap a new, separately owned workspace through
// its server-only credential. Bound expensive PDF extraction on the free plan.
export async function reserveProfileCreation(request:Request,env:Env){
  const now=new Date();const day=now.toISOString().slice(0,10), cutoff=now.getTime()-600000;
  // This counter is separate from operator sign-in. A successful bootstrap
  // credential must not reset the public signup limit on every request.
  const ipKey=`signup-ip:${await digest(request.headers.get('cf-connecting-ip') || 'local')}`;
  const attempt=await first(env,`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,
      window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
    WHERE window_start<=? OR attempts<5 RETURNING attempts`,ipKey,now.getTime(),cutoff,cutoff,cutoff);
  if(!attempt)throw new ApiError(429,'Too many profile creation attempts. Please try again in 10 minutes.');
  const result=await first(env,`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 WHERE attempts<50 RETURNING attempts`,
  `signup:${day}`,Date.parse(day));
  if(!result)throw new ApiError(429,'Profile creation is temporarily at capacity. Please try again tomorrow.');
}
function cookie(token: string, maxAge: number, request: Request, env: Env) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const sameSite = env.COOKIE_SAME_SITE === 'None' && secure ? 'None' : 'Lax';
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`;
}
export async function startSession(request: Request, env: Env, userId: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  await run(env, 'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', await digest(token), userId, new Date(Date.now() + 30 * 86400000).toISOString());
  return cookie(token, 30 * 86400, request, env);
}
export async function logout(request: Request, env: Env) {
  const token = request.headers.get('cookie')?.match(/(?:^|;\s*)hireflow_session=([a-f0-9]{64})/)?.[1];
  if (token) await run(env, 'DELETE FROM sessions WHERE token_hash=?', await digest(token));
  return json({ authenticated: false }, 200, { 'Set-Cookie': cookie('', 0, request, env) });
}
