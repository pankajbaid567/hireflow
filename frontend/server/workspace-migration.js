import { proxyRequest } from './worker-proxy.js';

const dashboardOrigin = 'https://hireflow-dashboard.pages.dev';
export function isMigrationBridgeRequest(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get('__hireflow_path') ?? url.pathname.slice(5);
  return request.method === 'GET' && path === 'workspace-migrate';
}

// A temporary bridge on the previous host can read its host-only cookie.
// The destination is fixed; caller URLs and email addresses never choose it.
export async function migrateWorkspace(request, options) {
  const endpoint = new URL('/api/session/transfer', request.url);
  const headers = new Headers(request.headers);
  headers.delete('content-type');
  const result = await proxyRequest(new Request(endpoint, { method: 'POST', headers }), options);
  const redirect = destination => new Response(null, { status: 303, headers: {
    Location: destination, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
  } });
  if (result.status === 401) return redirect(`${dashboardOrigin}/profile`);
  if (!result.ok) return result;
  try {
    const { transfer_url: raw } = await result.json();
    const target = new URL(raw);
    if (target.origin !== dashboardOrigin || target.pathname !== '/profile' || target.search || !/^#transfer=[a-f0-9]{64}$/.test(target.hash)) throw new Error();
    return redirect(target.href);
  } catch {
    return Response.json({ detail: 'Workspace migration is temporarily unavailable. Please try again.' }, { status: 502, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
