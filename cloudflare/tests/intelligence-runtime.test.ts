import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
let bundle: string, mf: Miniflare;
const profileResponse = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ name: 'Runtime Candidate', email: 'runtime@example.com', skills: ['Python'], projects: [{ name: 'Runtime project', description: 'Synthetic fixture', tech: ['Python'] }] }) }] } }] }), { headers: { 'Content-Type': 'application/json' } });
beforeAll(() => {
  bundle = buildSync({ stdin: { contents: `import { extractProfile, discoverJobs } from ${JSON.stringify(`${root}src/intelligence.ts`)};
    export default {async fetch(request,env){
      if(new URL(request.url).pathname==='/discover'){
        try{return Response.json(await discoverJobs(env,await request.json()));}
        catch(error){return Response.json({message:error.message},{status:503});}
      }
      if(new URL(request.url).pathname==='/unsupported-mode'){
        try{await fetch('https://generativelanguage.googleapis.com/v1beta/models',{redirect:'error'});return Response.json({unsupported:false});}
        catch(error){return Response.json({unsupported:true,error_name:error.name,category:/redirect/i.test(error.message)?'redirect':'other'});}
      }
      try{return Response.json(await extractProfile(env,new Uint8Array(await request.arrayBuffer())));}
      catch(error){return Response.json({message:error.message},{status:503});}
    }};`, resolveDir: root, sourcefile: 'profile-runtime.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*','cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
});
afterEach(async () => { await mf?.dispose(); }, 30000);

describe('Gemini requests in the actual workerd runtime', () => {
  it('reproduces the unsupported error redirect mode before any outbound request', async () => {
    let requests = 0;
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags:['nodejs_compat'], outboundService: () => { requests++; return new Response('{}'); } }));
    const result = await mf.dispatchFetch('https://test.example/unsupported-mode');
    expect(await result.json()).toEqual({ unsupported: true, error_name: 'TypeError', category: 'redirect' }); expect(requests).toBe(0);
  });

  it('extracts a PDF through manual provider requests without forwarding credentials across redirects', async () => {
    const urls: string[] = []; let redirect = false;
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags:['nodejs_compat'], bindings: { GEMINI_API_KEY: 'mock-test-key', GEMINI_MODEL: 'gemini-3.8-flash', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }, outboundService: request => {
      urls.push(request.url); expect(request.headers.get('x-goog-api-key')).toBe('mock-test-key');
      return redirect ? new Response(null, { status: 302, headers: { Location: 'https://attacker.example/private' } }) : profileResponse();
    } }));
    const pdf = new TextEncoder().encode('%PDF-1.4\nSynthetic runtime PDF');
    const success = await mf.dispatchFetch('https://test.example/extract', { method: 'POST', body: pdf }); expect(success.status).toBe(200); expect(await success.json()).toMatchObject({ name: 'Runtime Candidate', resume_extraction_model: 'gemini-3.8-flash' });
    redirect = true; const rejected = await mf.dispatchFetch('https://test.example/extract', { method: 'POST', body: pdf }); expect(rejected.status).toBe(503); expect(await rejected.json()).toEqual({ message: 'Gemini PDF extraction returned an unexpected redirect' });
    expect(urls).toHaveLength(2); expect(urls.every(url => new URL(url).hostname === 'generativelanguage.googleapis.com')).toBe(true);
  });

  it('uploads once, recovers with the configured fallback and deletes once using runtime-compatible requests', async () => {
    const urls: string[] = []; let fileName = '', generations = 0, deletes = 0;
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags:['nodejs_compat'], bindings: { GEMINI_API_KEY: 'mock-test-key', GEMINI_MODEL: 'gemini-3.8-flash', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }, outboundService: async request => {
      urls.push(request.url); const url = new URL(request.url);
      if (request.method === 'DELETE') { deletes++; expect(url.pathname).toBe(`/v1beta/${fileName}`); return new Response(null, { status: 204 }); }
      if (url.pathname === '/upload/v1beta/files' && !url.search) {
        fileName = ((await request.json()) as any).file.name;
        return new Response(null, { headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=synthetic' } });
      }
      if (url.searchParams.has('upload_id')) { expect((await request.arrayBuffer()).byteLength).toBe(32769); return Response.json({ file: { name: fileName, uri: `https://generativelanguage.googleapis.com/v1beta/${fileName}`, state: 'ACTIVE' } }); }
      generations++; const body = await request.json() as any; expect(body.contents[0].parts[1].fileData.fileUri).toBe(`https://generativelanguage.googleapis.com/v1beta/${fileName}`);
      return generations < 3 ? new Response('{}', { status: 503 }) : profileResponse();
    } }));
    const pdf = new Uint8Array(32769); pdf.set(new TextEncoder().encode('%PDF-1.4\nSynthetic runtime PDF'));
    const result = await mf.dispatchFetch('https://test.example/extract', { method: 'POST', body: pdf }); expect(result.status, await result.clone().text()).toBe(200);
    expect(await result.json()).toMatchObject({ resume_extraction_model: 'gemini-3.5-flash-lite', resume_extraction_fallback_used: true }); expect(urls).toHaveLength(6); expect(deletes).toBe(1); expect(generations).toBe(3);
  }, 15000);
});

describe('discovery requests in the actual workerd runtime', () => {
  it('searches and reads real-style JobPosting details using runtime-compatible fetch options', async () => {
    const requests: { url: string; method: string }[] = [];
    const description = 'Build Python and LangChain APIs with the engineering team. Write tests, evaluate retrieval quality, document the design, and ship a small supervised internship project.';
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: '2026-10-21', compatibilityFlags:['nodejs_compat'], bindings: { TAVILY_API_KEY: 'mock-test-key' }, outboundService: async request => {
      requests.push({ url: request.url, method: request.method });
      if (new URL(request.url).hostname === 'api.tavily.com') {
        const query = await request.json() as any; expect(query.time_range).toBe('month');
        return Response.json({ results: [{ title: 'AI Engineer Intern at Runtime Co', url: 'https://wellfound.com/jobs/123-runtime-ai-intern', content: description }] });
      }
      return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'AI Engineer Intern', hiringOrganization: { name: 'Runtime Co' }, description, employmentType: 'INTERN', datePosted: new Date().toISOString() })}</script>`, { headers: { 'Content-Type': 'text/html' } });
    } }));
    const response = await mf.dispatchFetch('https://test.example/discover', { method: 'POST', body: JSON.stringify({ mode: 'internship', target_roles: ['AI Engineer'], skills: ['Python'] }) });
    expect(response.status, await response.clone().text()).toBe(200); const jobs = await response.json() as any[];
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ company: 'Runtime Co', description, url: 'https://wellfound.com/jobs/123-runtime-ai-intern' });
    expect(requests.filter(request => request.method === 'POST').every(request => new URL(request.url).hostname === 'api.tavily.com')).toBe(true);
  });
});
