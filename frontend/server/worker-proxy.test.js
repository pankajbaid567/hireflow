// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { proxyRequest } from './worker-proxy';

const origin = 'https://hireflow-api.example.workers.dev';
describe('Vercel same-origin Worker proxy', () => {
  it('forwards owner cookies and preserves session cookies without caching private data', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"authenticated":true}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'hireflow_session=private; Path=/; HttpOnly; Secure; SameSite=Lax', 'Cache-Control': 'public, max-age=3600' } }));
    const result = await proxyRequest(new Request('https://app.vercel.app/api/session', { headers: { Cookie: 'hireflow_session=private' } }), { origin, fetcher });
    const [target, options] = fetcher.mock.calls[0]; expect(target.href).toBe(`${origin}/session`); expect(options.headers.get('cookie')).toBe('hireflow_session=private');
    expect(result.headers.get('set-cookie')).toContain('HttpOnly'); expect(result.headers.get('cache-control')).toBe('private, no-store'); expect(await result.json()).toEqual({ authenticated: true });
  });
  it('handles nested Vercel rewrites without forwarding internal routing parameters', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 7 }));
    const result = await proxyRequest(new Request('https://app.vercel.app/api/proxy?__hireflow_path=resumes%2F7%2F21%2Fdownload&version=2'), { origin, fetcher });
    const target = fetcher.mock.calls[0][0];
    expect(target.pathname).toBe('/resumes/7/21/download'); expect(target.search).toBe('?version=2');
    expect(target.searchParams.has('__hireflow_path')).toBe(false); await result.json();
  });
  it('preserves multipart upload bytes and query strings while replacing a caller code with the server credential', async () => {
    const body = new FormData(); body.append('name', 'Alex'); body.append('resume', new Blob(['%PDF sample'], { type: 'application/pdf' }), 'resume.pdf');
    const request = new Request('https://app.vercel.app/api/profile?mode=internship', { method: 'POST', body, headers: { 'X-HireFlow-Access-Code': 'private' } });
    const expected = await request.clone().text();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 7 }));
    const result = await proxyRequest(request, { origin, workspaceAccessCode: 'server-bootstrap', fetcher }); const [target, options] = fetcher.mock.calls[0];
    expect(target.search).toBe('?mode=internship'); expect(options.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/); expect(options.headers.get('x-hireflow-access-code')).toBe('server-bootstrap'); expect(await new Response(options.body).text()).toBe(expected); expect((await result.json()).id).toBe(7);
    expect(result.headers.has('x-hireflow-access-code')).toBe(false);
  });
  it('injects the bootstrap credential for the exact profile creation route through a Vercel rewrite', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 7 }));
    const result = await proxyRequest(new Request('https://app.vercel.app/api/proxy?__hireflow_path=profile', { method: 'POST' }), { origin, workspaceAccessCode: 'server-bootstrap', fetcher });
    const [target, options] = fetcher.mock.calls[0];
    expect(target.pathname).toBe('/profile'); expect(options.headers.get('x-hireflow-access-code')).toBe('server-bootstrap');
    expect(await result.text()).not.toContain('server-bootstrap');
  });
  it('reads the bootstrap credential only from the server environment by default', async () => {
    vi.stubEnv('WORKSPACE_ACCESS_CODE', 'environment-bootstrap');
    try {
      const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 7 }));
      const result = await proxyRequest(new Request('https://app.vercel.app/api/profile', { method: 'POST' }), { origin, fetcher });
      expect(fetcher.mock.calls[0][1].headers.get('x-hireflow-access-code')).toBe('environment-bootstrap'); await result.text();
    } finally { vi.unstubAllEnvs(); }
  });
  it('does not accept an incoming code when the server environment has no bootstrap credential', async () => {
    vi.stubEnv('WORKSPACE_ACCESS_CODE', undefined);
    try {
      const fetcher = vi.fn();
      const result = await proxyRequest(new Request('https://app.vercel.app/api/profile', { method: 'POST', headers: { 'X-HireFlow-Access-Code': 'caller-code' } }), { origin, fetcher });
      expect(result.status).toBe(503); expect(fetcher).not.toHaveBeenCalled();
      expect(await result.text()).not.toContain('caller-code');
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([
    ['POST', '/api/session/login'],
    ['PATCH', '/api/profile'],
    ['GET', '/api/profile'],
    ['POST', '/api/profile/'],
    ['POST', '/api/profile/7'],
    ['POST', '/api/proxy?__hireflow_path=session%2Flogin'],
    ['PATCH', '/api/proxy?__hireflow_path=profile'],
    ['POST', '/api/proxy?__hireflow_path=profile%2F'],
  ])('strips incoming credentials without injecting on %s %s', async (method, path) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    const result = await proxyRequest(new Request(`https://app.vercel.app${path}`, { method, headers: { 'X-HireFlow-Access-Code': 'caller-code' } }), { origin, workspaceAccessCode: 'server-bootstrap', fetcher });
    expect(fetcher.mock.calls[0][1].headers.has('x-hireflow-access-code')).toBe(false); await result.text();
  });
  it.each(['', '   ', null, 'invalid\ncredential'])('fails profile creation cleanly when bootstrap configuration is missing or invalid (%j)', async workspaceAccessCode => {
    const fetcher = vi.fn();
    const result = await proxyRequest(new Request('https://app.vercel.app/api/proxy?__hireflow_path=profile', { method: 'POST', headers: { 'X-HireFlow-Access-Code': 'caller-code' } }), { origin, workspaceAccessCode, fetcher });
    expect(result.status).toBe(503); expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(await result.json()).toEqual({ detail: 'Profile creation is temporarily unavailable. Please try again later.' });
    expect(result.headers.has('x-hireflow-access-code')).toBe(false); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not expose the bootstrap credential in upstream failures', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('server-bootstrap'));
    const result = await proxyRequest(new Request('https://app.vercel.app/api/profile', { method: 'POST' }), { origin, workspaceAccessCode: 'server-bootstrap', fetcher });
    expect(result.status).toBe(502); expect(await result.text()).not.toContain('server-bootstrap');
  });
  it('streams PDF responses and retains download metadata', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('%PDF content', { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename=resume.pdf' } }));
    const result = await proxyRequest(new Request('https://app.vercel.app/api/resumes/7/21/download?version=2'), { origin, fetcher });
    expect(result.headers.get('content-type')).toBe('application/pdf'); expect(result.headers.get('content-disposition')).toContain('resume.pdf'); expect(await result.text()).toBe('%PDF content');
  });
  it('rejects missing or unsafe configuration and never accepts a caller-selected target', async () => {
    const fetcher = vi.fn();
    for (const unsafe of ['', 'http://localhost:8000', 'https://user:password@example.com', 'https://example.com/path']) {
      const result = await proxyRequest(new Request('https://app.vercel.app/api/session'), { origin: unsafe, fetcher }); expect(result.status).toBe(503);
    }
    expect(fetcher).not.toHaveBeenCalled();
    const safeFetcher = vi.fn().mockResolvedValue(Response.json({}));
    await proxyRequest(new Request('https://app.vercel.app/api//untrusted.example/profile'), { origin, fetcher: safeFetcher }); expect(safeFetcher.mock.calls[0][0].origin).toBe(origin);
  });
  it('bounds upstream connection time to 60 seconds', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
      const pending = proxyRequest(new Request('https://app.vercel.app/api/session'), { origin, fetcher });
      await vi.advanceTimersByTimeAsync(60001);
      const result = await pending;
      expect(result.status).toBe(504); expect(await result.text()).toContain('took too long');
    } finally { vi.useRealTimers(); }
  });
  it('returns a clean failure without leaking upstream errors or following external redirects', async () => {
    const result = await proxyRequest(new Request('https://app.vercel.app/api/session'), { origin, fetcher: vi.fn().mockRejectedValue(new Error('internal-secret')) }); expect(result.status).toBe(502); expect(await result.text()).not.toContain('internal-secret');
    const redirect = await proxyRequest(new Request('https://app.vercel.app/api/session'), { origin, fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://unexpected.example' } })) }); expect(redirect.status).toBe(502);
  });
});
