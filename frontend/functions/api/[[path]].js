import { proxyRequest } from '../../server/worker-proxy.js';

// Pages keeps the API and private cookies on the dashboard's own origin.
// The service binding sends traffic directly to this account's API Worker.
export function onRequest({ request, env }) {
  const url = new URL(request.url);
  // Vercel's former rewrite metadata is never a client-controlled route here.
  url.searchParams.delete('__hireflow_path');
  return proxyRequest(new Request(url, request), {
    origin: env.WORKER_API_URL,
    workspaceAccessCode: env.WORKSPACE_ACCESS_CODE,
    fetcher: env.API ? (url, init) => env.API.fetch(url, init) : fetch,
  });
}
