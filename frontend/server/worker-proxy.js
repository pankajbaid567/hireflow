const OMIT_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'x-hireflow-access-code']);
const TIMEOUT_MS = 60000;

function jsonError(message, status) {
  return Response.json({ detail: message }, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

// A fixed server-side origin prevents this route from becoming an open proxy.
export async function proxyRequest(request, { origin = typeof process !== 'undefined' ? process.env.WORKER_API_URL : undefined, workspaceAccessCode = typeof process !== 'undefined' ? process.env.WORKSPACE_ACCESS_CODE : undefined, fetcher = fetch } = {}) {
  let upstream;
  try {
    upstream = new URL(origin);
    if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== '/') throw new Error('Invalid origin');
  } catch {
    return jsonError('The application API origin is not configured correctly.', 503);
  }
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith('/api/')) return jsonError('API route not found.', 404);
  // A single Vercel function handles nested API routes through an explicit
  // rewrite. The reserved query value is routing metadata, never an origin.
  const routedPath = incoming.searchParams.get('__hireflow_path');
  upstream.pathname = `/${(routedPath ?? incoming.pathname.slice(5)).replace(/^\/+/, '')}`;
  incoming.searchParams.delete('__hireflow_path');
  upstream.search = incoming.searchParams.toString();
  const headers = new Headers();
  for (const [key, value] of request.headers) if (!OMIT_HEADERS.has(key.toLowerCase()) && !key.toLowerCase().startsWith('x-forwarded-')) headers.set(key, value);
  // Only profile creation receives the server-held bootstrap credential. Caller
  // access-code headers are stripped on every route, including sign-in.
  if (request.method === 'POST' && upstream.pathname === '/profile') {
    if (typeof workspaceAccessCode !== 'string' || !workspaceAccessCode.trim()) return jsonError('Profile creation is temporarily unavailable. Please try again later.', 503);
    try { headers.set('X-HireFlow-Access-Code', workspaceAccessCode); }
    catch { return jsonError('Profile creation is temporarily unavailable. Please try again later.', 503); }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let streaming = false;
  try {
    const response = await fetcher(upstream, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      duplex: 'half',
      redirect: 'manual',
      signal: controller.signal,
    });
    const outgoing = new Headers();
    for (const [key, value] of response.headers) if (!OMIT_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie' && !key.toLowerCase().startsWith('access-control-')) outgoing.set(key, value);
    const cookies = response.headers.getSetCookie?.() || (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
    for (const cookie of cookies) outgoing.append('Set-Cookie', cookie);
    outgoing.set('Cache-Control', 'private, no-store');
    outgoing.set('Vercel-CDN-Cache-Control', 'no-store');
    outgoing.set('CDN-Cache-Control', 'no-store');
    // fetch decompresses upstream bodies, so encoding and length must not be reused.
    outgoing.delete('Content-Encoding');
    if (response.status >= 300 && response.status < 400 && outgoing.has('Location')) {
      const destination = new URL(outgoing.get('Location'), upstream);
      if (destination.origin !== upstream.origin) return jsonError('The API returned an unexpected redirect.', 502);
      outgoing.set('Location', `/api${destination.pathname}${destination.search}`);
    }
    let body = null;
    if (response.body) {
      const reader = response.body.getReader();
      body = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { clearTimeout(timer); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) { clearTimeout(timer); controller.error(error); }
        },
        cancel(reason) { clearTimeout(timer); controller.abort(); return reader.cancel(reason); },
      });
      streaming = true;
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: outgoing });
  } catch (error) {
    return jsonError(controller.signal.aborted ? 'The application API took too long. Please try again.' : 'The application API is unavailable. Please try again.', controller.signal.aborted ? 504 : 502);
  } finally {
    if (!streaming) clearTimeout(timer);
  }
}
