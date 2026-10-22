import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../../', import.meta.url));
let pagesBundle: string, mf: Miniflare;
const upstream = `export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/resumes/7/3/download') return new Response(new Uint8Array([37,80,68,70,45,49,46,52,10,0,255]), {headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="reviewed.pdf"','Cache-Control':'public, max-age=999','Access-Control-Allow-Origin':'*'}});
  if (url.pathname === '/redirect') return Response.redirect('https://api.example/profile/7',302);
  if (url.pathname === '/external-redirect') return Response.redirect('https://attacker.example/collect',302);
  let fields = null;
  if(request.headers.get('Content-Type')?.startsWith('multipart/form-data')){
    const data = await request.formData(); const resume = data.get('resume');
    fields={name:data.get('name'),filename:resume?.name,pdf:resume?await resume.text():null};
  } else if(!['GET','HEAD'].includes(request.method)) fields=await request.json();
  const headers=new Headers({'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
  if(url.pathname==='/profile'){
    headers.append('Set-Cookie','hireflow_session=synthetic-token; Path=/; HttpOnly; Secure; SameSite=Lax');
    headers.append('Set-Cookie','preference=synthetic; Path=/; Secure; SameSite=Lax');
  }
  return new Response(JSON.stringify({path:url.pathname,query:url.search,method:request.method,cookie:request.headers.get('Cookie'),
    hasBootstrap:request.headers.get('X-HireFlow-Access-Code')===env.EXPECTED_BOOTSTRAP,
    hasCallerCode:request.headers.get('X-HireFlow-Access-Code')==='caller-spoofed',
    forwardedHost:request.headers.get('X-Forwarded-Host'),fields}),{status:url.pathname==='/profile'?201:200,headers});
}};`;
beforeAll(() => {
  pagesBundle = buildSync({ stdin: { contents: `import { onRequest } from ${JSON.stringify(`${root}frontend/functions/api/[[path]].js`)}; export default { fetch(request,env){return onRequest({request,env});} };`, resolveDir: root, loader: 'js' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' }).outputFiles[0].text;
});
afterEach(async () => { await mf?.dispose(); }, 30000);
async function boot(nativeService: boolean, bootstrap = 'synthetic-server-bootstrap') {
  const pages = { name: 'pages', modules: true, script: pagesBundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], bindings: { WORKER_API_URL: 'https://api.example', WORKSPACE_ACCESS_CODE: bootstrap } };
  const api = { name: 'upstream', modules: true, script: upstream, compatibilityDate: '2026-10-21', bindings: { EXPECTED_BOOTSTRAP: 'synthetic-server-bootstrap' } };
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [nativeService ? { ...pages, serviceBindings: { API: 'upstream' } } : { ...pages, outboundService: 'upstream' }, api] }));
}

describe.each([true, false])('Pages proxy in workerd (native API binding: %s)', nativeService => {
  it('streams multipart data, strips caller credentials, adds bootstrap only for creation, and preserves private cookies', async () => {
    await boot(nativeService);
    const form = new FormData(); form.set('name', 'Synthetic Owner'); form.set('resume', new Blob(['%PDF-1.4\nSynthetic resume'], { type: 'application/pdf' }), 'resume.pdf');
    const encoded = new Request('https://upload.example', { method: 'POST', body: form });
    const created = await mf.dispatchFetch('https://pages.example/api/profile?__hireflow_path=session/login&mode=internship', { method: 'POST', headers: { 'Content-Type': encoded.headers.get('Content-Type')!, 'X-HireFlow-Access-Code': 'caller-spoofed', 'X-Forwarded-Host': 'attacker.example' }, body: await encoded.text() });
    expect(created.status, await created.clone().text()).toBe(201); const profile = await created.json() as any;
    expect(profile).toMatchObject({ path: '/profile', query: '?mode=internship', hasBootstrap: true, hasCallerCode: false, forwardedHost: null, fields: { name: 'Synthetic Owner', filename: 'resume.pdf', pdf: '%PDF-1.4\nSynthetic resume' } });
    expect(created.headers.get('Cache-Control')).toBe('private, no-store'); expect(created.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const cookies = created.headers.getSetCookie(); expect(cookies).toHaveLength(2); expect(cookies[0]).toContain('HttpOnly'); expect(cookies[0]).toContain('Secure'); expect(cookies[0]).not.toContain('Domain=');
    for (const [path, method] of [['profile/7', 'PATCH'], ['session/login', 'POST']] as const) {
      const response = await mf.dispatchFetch(`https://pages.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: 'hireflow_session=synthetic-token', 'X-HireFlow-Access-Code': 'caller-spoofed' }, body: JSON.stringify({ name: 'Updated Synthetic Owner' }) });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ hasBootstrap: false, hasCallerCode: false, cookie: 'hireflow_session=synthetic-token', fields: { name: 'Updated Synthetic Owner' } });
    }
  });

  it('streams exact PDF bytes and keeps safe response headers without permitting external redirects', async () => {
    await boot(nativeService);
    const pdf = await mf.dispatchFetch('https://pages.example/api/resumes/7/3/download', { headers: { Cookie: 'hireflow_session=synthetic-token' } });
    expect(pdf.status).toBe(200); expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(new Uint8Array([37,80,68,70,45,49,46,52,10,0,255]));
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf'); expect(pdf.headers.get('Content-Disposition')).toContain('reviewed.pdf'); expect(pdf.headers.get('Cache-Control')).toBe('private, no-store'); expect(pdf.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const safe = await mf.dispatchFetch('https://pages.example/api/redirect', { redirect: 'manual' }); expect(safe.status).toBe(302); expect(safe.headers.get('Location')).toBe('/api/profile/7');
    const unsafe = await mf.dispatchFetch('https://pages.example/api/external-redirect', { redirect: 'manual' }); expect(unsafe.status).toBe(502); expect(await unsafe.text()).toContain('unexpected redirect');
  });

  it('fails profile creation closed when its server-only bootstrap is unavailable', async () => {
    await boot(nativeService, '');
    const response = await mf.dispatchFetch('https://pages.example/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HireFlow-Access-Code': 'caller-spoofed' }, body: '{}' });
    expect(response.status).toBe(503); expect(await response.text()).toContain('Profile creation is temporarily unavailable');
  });
});
