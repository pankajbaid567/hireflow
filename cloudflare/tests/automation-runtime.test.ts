import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
let bundle: string, mf: Miniflare;
beforeAll(() => {
  bundle = buildSync({ stdin: { contents: `
    import { Buffer } from 'node:buffer';
    import { fetchApplicationResource } from './src/automation';
    export default {async fetch(request){
      const input=await request.json();
      try {
        const response=await fetchApplicationResource({
          url:()=>input.url || 'https://careers.fixture.example/application.html',
          method:()=>input.method || 'GET',
          allHeaders:async()=>({'cookie':'browser_session=fixture','content-type':'application/pdf','host':'untrusted.invalid','content-length':'999'}),
          postDataBuffer:()=>Buffer.from('%PDF-1.4 synthetic application')
        }, input.timeout || 1000);
        return Response.json({...response,body:response.body.toString()});
      } catch(error) {return Response.json({error_name:error.name,error:error.message},{status:503});}
    }};`, resolveDir: root, loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
});
afterEach(async () => { await mf?.dispose(); });
function start(outboundService: (request: Request) => Response | Promise<Response>) {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], outboundService }));
}
async function resource(input: Record<string, unknown> = {}) {
  return mf.dispatchFetch('https://worker.fixture.example/', { method: 'POST', body: JSON.stringify(input) });
}

describe('application HTTP transport in real workerd', () => {
  it('retains canonical redirect Location and both cookies without following the redirect', async () => {
    const urls: string[] = [];
    start(request => {
      urls.push(request.url);
      const headers = new Headers({ Location: '/application' });
      headers.append('Set-Cookie', 'first=one; Path=/; Secure'); headers.append('Set-Cookie', 'second=two; Path=/; Secure');
      return new Response(null, { status: 308, headers });
    });
    const response = await resource(); expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.status).toBe(308); expect(data.headers.location).toBe('/application');
    expect(data.headers['set-cookie'].split('\n')).toEqual(['first=one; Path=/; Secure', 'second=two; Path=/; Secure']);
    expect(urls).toEqual(['https://careers.fixture.example/application.html']);
  });

  it('forwards actual cookies and native form body but does not replay a 307 POST', async () => {
    const requests: any[] = [];
    start(async request => {
      requests.push({ url: request.url, method: request.method, cookie: request.headers.get('cookie'), body: await request.text(), host: request.headers.get('host') });
      return new Response(null, { status: 307, headers: { Location: '/repeat-submit' } });
    });
    const response = await resource({ method: 'POST' }); expect(response.status).toBe(200);
    expect((await response.json() as any).status).toBe(307);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', cookie: 'browser_session=fixture', body: '%PDF-1.4 synthetic application' });
    expect(requests[0].host).not.toBe('untrusted.invalid');
  });

  it('validates private URLs before any outbound request', async () => {
    let requests = 0;
    start(() => { requests++; return new Response('unexpected'); });
    const response = await resource({ url: 'http://169.254.169.254/latest/meta-data' });
    expect(response.status).toBe(503); expect((await response.json() as any).error).toBe('Unsafe application URL'); expect(requests).toBe(0);
  });

  it('removes decoded body transport metadata while keeping content and security headers', async () => {
    // An outbound service Response has an already readable body, matching the
    // Workers fetch response contract. Do not double-encode that service body.
    start(() => new Response('Readable document', { headers: { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Security-Policy': "default-src 'self'" } }));
    const response = await resource(); expect(response.status, await response.clone().text()).toBe(200); const data = await response.json() as any;
    expect(data.body).toBe('Readable document'); expect(data.headers['content-type']).toBe('text/html');
    expect(data.headers['content-security-policy']).toBe("default-src 'self'");
    expect(data.headers['content-length']).toBeUndefined(); expect(data.headers['content-encoding']).toBeUndefined();
  });

  it('normalizes remaining gzip bytes without sending compressed data as plain HTML', async () => {
    start(request => {
      expect(request.headers.get('accept-encoding')).toBe('gzip');
      return new Response(gzipSync('Readable document'), { headers: { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' } });
    });
    const response = await resource(); expect(response.status, await response.clone().text()).toBe(200);
    const data = await response.json() as any;
    expect(data.body).toBe('Readable document'); expect(data.headers['content-encoding']).toBeUndefined();
  });

  it('aborts a stalled network response within the configured request deadline', async () => {
    start(async () => { await new Promise(resolve => setTimeout(resolve, 100)); return new Response('late'); });
    const response = await resource({ timeout: 10 }); expect(response.status).toBe(503);
    expect((await response.json() as any).error_name).toBe('AbortError');
  });

  it('bounds response bodies instead of loading an arbitrarily large page resource', async () => {
    start(() => new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
    const response = await resource(); expect(response.status).toBe(503);
    expect((await response.json() as any).error).toContain('resource is too large');
  });

  it('also bounds the expanded size of a small compressed body', async () => {
    start(() => new Response(gzipSync(new Uint8Array(8 * 1024 * 1024 + 1)), { headers: { 'Content-Encoding': 'gzip' } }));
    const response = await resource(); expect(response.status).toBe(503);
    expect((await response.json() as any).error).toContain('resource is too large');
  });
});
