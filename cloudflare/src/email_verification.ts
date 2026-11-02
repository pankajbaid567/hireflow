/** Proof that an account controls its profile email, required before a report is mailed to an address the operator did not approve.
 *  Signup does not verify addresses, so without this anyone could point a report at someone else's inbox through the owner's Gmail.
 *  The verification mail itself is fixed text with no user-controlled content, limited to 2 per account per day. */
import { digest } from './auth';
import { first, run } from './storage';
import { gmailReadiness, gmailRecipientAllowed, profileEmailDelivery, sendGmailMessage } from './gmail_transport';
import { ApiError, type Env } from './types';

const TTL_MS = 24 * 3600_000, DAILY_LINKS = 2;
const tokenPattern = /^[a-f0-9]{64}$/;

async function owner(env: Env, userId: number) {
  const user = await first(env, 'SELECT id,email,email_verified_at FROM users WHERE id=?', userId);
  if (!user) throw new ApiError(404, 'Profile not found');
  return user as { id: number; email: string; email_verified_at: string | null };
}

export async function emailVerificationStatus(env: Env, userId: number) {
  const user = await owner(env, userId);
  const approved = gmailRecipientAllowed(env, user.email);
  // `required` only applies when profile-email delivery is what would otherwise authorise the send.
  const required = profileEmailDelivery(env) && !approved;
  return { email: user.email, verified: approved || Boolean(user.email_verified_at), required, provider_ready: gmailReadiness(env).ready };
}

export async function requestEmailVerification(env: Env, userId: number) {
  const status = await emailVerificationStatus(env, userId);
  if (!profileEmailDelivery(env)) throw new ApiError(403, 'Email verification is not used by this deployment.');
  if (status.verified) return { state: 'already_verified' as const };
  if (!status.provider_ready) throw new ApiError(503, 'Email delivery is not configured for this deployment.');
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const recent = (await first(env, 'SELECT count(*) AS n FROM email_verifications WHERE user_id=? AND created_at>?', userId, since))?.n || 0;
  if (recent >= DAILY_LINKS) throw new ApiError(429, 'A verification link was already sent recently. Check your inbox and spam folder, or try again tomorrow.');
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
  const hash = await digest(token), now = Date.now();
  await run(env, 'INSERT INTO email_verifications(token_hash,user_id,email,created_at,expires_at) VALUES(?,?,?,?,?)', hash, userId, status.email, new Date(now).toISOString(), new Date(now + TTL_MS).toISOString());
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const link = `${base}/email/verify?token=${token}`;
  const outcome = await sendGmailMessage(env, {
    from: String(env.GMAIL_USER).trim(), to: status.email, subject: 'Confirm your HireFlow email address',
    html: `<p>Someone asked HireFlow to send reports to this address. If that was you, confirm it within 24 hours:</p><p><a href="${link}">Confirm my email address</a></p><p>If it was not you, ignore this message. Nothing will be sent to you.</p>`,
    messageId: `<verify-${crypto.randomUUID()}@hireflow.invalid>`, profile_recipient: true,
  });
  if (outcome.state !== 'accepted') {
    await run(env, 'UPDATE email_verifications SET used_at=? WHERE token_hash=?', new Date().toISOString(), hash);
    return { state: 'failed' as const, message: 'The verification email could not be sent. Try again later.' };
  }
  return { state: 'sent' as const };
}

/** Single-use: the token row is consumed atomically, and only if the address is unchanged since it was issued. */
export async function confirmEmailVerification(env: Env, token: string): Promise<boolean> {
  if (!tokenPattern.test(token)) return false;
  const now = new Date().toISOString();
  const row = await first(env, 'UPDATE email_verifications SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING user_id,email', now, await digest(token), now);
  if (!row) return false;
  const updated = await run(env, 'UPDATE users SET email_verified_at=? WHERE id=? AND email=?', now, row.user_id, row.email);
  return Boolean(updated.meta.changes);
}
