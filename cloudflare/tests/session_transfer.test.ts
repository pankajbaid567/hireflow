import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from './migrations';

const root = fileURLToPath(new URL('../', import.meta.url));
const oldOrigin = 'https://old-dashboard.example';
const newOrigin = 'https://hireflow.pages.dev';
const oldToken = 'a'.repeat(64);
const oldCookie = `hireflow_session=${oldToken}`;
const oldSessionId = '12345678-1234-4321-8123-123456789abc';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
let bundle: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;

beforeAll(() => {
  const contents = `
    import { createTransfer, consumeTransfer } from './src/session_transfer';
    import { sessionUser, logout } from './src/auth';
    import { accountSecurity } from './src/account_security';
    import { ApiError, json } from './src/types';
    export default { async fetch(request, env) {
      try {
        const path = new URL(request.url).pathname;
        if (path === '/create') return await createTransfer(request, env);
        if (path === '/consume') return await consumeTransfer(request, env);
        if (path === '/logout') return await logout(request, env);
        if (path.startsWith('/account/')) return await accountSecurity(request, env);
        return json({user_id: await sessionUser(request, env)});
      } catch (error) {
        return json({detail: error instanceof ApiError ? error.message : 'Unexpected error'}, error instanceof ApiError ? error.status : 500);
      }
    } };`;
  bundle = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'],
    write: false, logLevel: 'silent' }).outputFiles[0].text;
});

async function boot(overrides: Record<string, string> = {}) {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle,
    compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { PUBLIC_BASE_URL: `${newOrigin}/api`, ALLOWED_ORIGINS: `${oldOrigin},${newOrigin}`, ...overrides },
  }));
  db = await mf.getD1Database('DB');
  await applyTestMigrations(db);
  await db.prepare('INSERT INTO users(id,name,email,mode) VALUES(1,?,?,?)').bind('Migration QA', 'migration@example.com', 'internship').run();
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,id,created_at,label) VALUES(?,1,?,?,?,?)').bind(hash(oldToken), new Date(Date.now() + 600000).toISOString(), oldSessionId, new Date().toISOString(), 'Original session').run();
}
beforeEach(() => boot());
afterEach(async () => { await mf?.dispose(); });

function request(path: string, options: { cookie?: string; origin?: string; token?: unknown; method?: string } = {}) {
  const headers: Record<string, string> = { Origin: options.origin ?? (path === '/create' ? oldOrigin : newOrigin) };
  if (options.cookie) headers.Cookie = options.cookie;
  let body: string | undefined;
  if (options.token !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify({ token: options.token }); }
  return mf.dispatchFetch(`https://api.example${path}`, { method: options.method || (path === '/session' ? 'GET' : 'POST'), headers, body });
}
async function create() {
  const result = await request('/create', { cookie: oldCookie });
  expect(result.status).toBe(200);
  const url = new URL((await result.json() as any).transfer_url);
  return { url, token: new URLSearchParams(url.hash.slice(1)).get('transfer')! };
}

describe('single-use workspace session transfers with real D1', () => {
  it('requires the existing browser session before creating a migration link', async () => {
    expect((await request('/create')).status).toBe(401);
    expect((await request('/create', { cookie: 'hireflow_session=invalid' })).status).toBe(401);
    expect((await db.prepare('SELECT count(*) AS count FROM session_transfers').first<any>())!.count).toBe(0);
  });

  it('uses only the configured approved HTTPS origin and persists a five-minute hash', async () => {
    const { url, token } = await create();
    expect(url.origin).toBe(newOrigin); expect(url.pathname).toBe('/profile'); expect(url.search).toBe('');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const row = await db.prepare('SELECT * FROM session_transfers').first<any>();
    expect(row.token_hash).toBe(hash(token)); expect(row.token_hash).not.toBe(token); expect(row.user_id).toBe(1);
    expect(row.source_session_hash).toBe(hash(oldToken)); expect(row.claimed_session_id).toBeNull();
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(290000);
    expect(Date.parse(row.expires_at) - Date.now()).toBeLessThanOrEqual(300000);
  });

  it('creates a new private host-only session and rejects a second use', async () => {
    const { token } = await create();
    const consumed = await request('/consume', { token }); expect(consumed.status).toBe(200);
    expect(await consumed.json()).toEqual({ authenticated: true, user_id: 1 });
    const cookie = consumed.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain='); expect(cookie).not.toContain(oldToken); expect(cookie).not.toContain(token);
    expect(await (await request('/session', { cookie: cookie.split(';')[0] })).json()).toEqual({ user_id: 1 });
    expect((await request('/consume', { token })).status).toBe(401);
    expect((await db.prepare('SELECT count(*) AS count FROM session_transfers').first<any>())!.count).toBe(0);
  });

  it('atomically permits exactly one concurrent consumer', async () => {
    const { token } = await create();
    const attempts = await Promise.all(Array.from({ length: 5 }, () => request('/consume', { token })));
    expect(attempts.map(response => response.status).sort()).toEqual([200, 401, 401, 401, 401]);
    expect((await db.prepare('SELECT count(*) AS count FROM sessions').first<any>())!.count).toBe(2);
  });

  it.each(['logout', 'individual-revocation'])('invalidates an outstanding transfer after source-session %s', async action => {
    const { token } = await create();
    const revoked = action === 'logout'
      ? await request('/logout', { cookie: oldCookie })
      : await request(`/account/sessions/${oldSessionId}`, { cookie: oldCookie, method: 'DELETE' });
    expect(revoked.status).toBe(200);
    expect((await request('/consume', { token })).status).toBe(401);
    expect((await db.prepare('SELECT count(*) AS count FROM sessions').first<any>())!.count).toBe(0);
  });

  it('rejects an expired source session, a foreign source owner and pre-migration unbound transfers', async () => {
    const { token } = await create();
    await db.prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();
    expect((await request('/consume', { token })).status).toBe(401);
    await db.prepare('UPDATE sessions SET expires_at=?').bind(new Date(Date.now() + 600000).toISOString()).run();
    await db.prepare('INSERT INTO users(id,name,email,mode) VALUES(2,?,?,?)').bind('Other QA', 'other-migration@example.com', 'internship').run();
    await db.prepare('UPDATE session_transfers SET user_id=2').run();
    expect((await request('/consume', { token })).status).toBe(401);
    await db.prepare('UPDATE session_transfers SET user_id=1,source_session_hash=NULL').run();
    expect((await request('/consume', { token })).status).toBe(401);
    expect(await (await request('/session', { cookie: oldCookie })).json()).toEqual({ user_id: 1 });
    const fresh = await create(); expect((await request('/consume', { token: fresh.token })).status).toBe(200);
  });

  it('rolls back the claim and retains the usable transfer when replacement-session storage fails', async () => {
    const { token } = await create();
    await db.prepare("CREATE TRIGGER fail_transfer_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END").run();
    expect((await request('/consume', { token })).status).toBe(500);
    const pending = await db.prepare('SELECT claimed_session_id FROM session_transfers WHERE token_hash=?').bind(hash(token)).first<any>();
    expect(pending).not.toBeNull(); expect(pending.claimed_session_id).toBeNull();
    expect((await db.prepare('SELECT count(*) AS count FROM sessions').first<any>())!.count).toBe(1);
    expect(await (await request('/session', { cookie: oldCookie })).json()).toEqual({ user_id: 1 });
    await db.prepare('DROP TRIGGER fail_transfer_session').run();
    expect((await request('/consume', { token })).status).toBe(200);
    expect((await request('/consume', { token })).status).toBe(401);
  });

  it('rejects expired and malformed transfers without creating a session', async () => {
    const { token } = await create();
    await db.prepare('UPDATE session_transfers SET expires_at=?').bind('2000-01-01T00:00:00.000Z').run();
    for (const invalid of [token, '', 'f'.repeat(64), 'A'.repeat(64), { token }, 42]) {
      const response = await request('/consume', { token: invalid }); expect(response.status).toBe(401);
      expect((await response.json() as any).detail).toContain('expired or already been used');
    }
    expect((await db.prepare('SELECT count(*) AS count FROM sessions').first<any>())!.count).toBe(1);
  });

  it('rejects a foreign or old origin without consuming a valid transfer', async () => {
    const { token } = await create();
    for (const origin of ['https://attacker.example', oldOrigin, 'null', '']) {
      expect((await request('/consume', { token, origin })).status).toBe(403);
    }
    expect((await request('/consume', { token })).status).toBe(200);
  });

  it.each(['https://unapproved.example/api', 'http://hireflow.pages.dev/api', 'not-a-url', 'https://user:password@hireflow.pages.dev/api'])('fails closed for an unsafe migration target %s', async target => {
    await mf.dispose(); await boot({ PUBLIC_BASE_URL: target });
    expect((await request('/create', { cookie: oldCookie })).status).toBe(503);
    expect((await db.prepare('SELECT count(*) AS count FROM session_transfers').first<any>())!.count).toBe(0);
  });
});
