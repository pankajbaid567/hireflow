/** Isolated operations/account CPU profile; no keys or production traffic.
 * Run with Node 22 after `npm ci --prefix cloudflare`.
 * --baseline-ref 358510a profiles the P0 telemetry source using the same fixture.
 * Local V8 samples identify hotspots; they are not Cloudflare billed CPU metrics.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../cloudflare/package.json', import.meta.url));
const { build } = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { unstable_splitSqlQuery } = require('wrangler');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const count = Number(option('--requests', '500'));
assert.ok(Number.isInteger(count) && count >= 40 && count <= 2000, '--requests must be 40–2000.');
const baseline = option('--baseline-ref', null);
assert.ok(baseline === null || /^[a-f0-9]{7,40}$/.test(baseline), 'Use a commit hash for --baseline-ref.');
const route = option('--route', 'operations');
assert.ok(['operations', 'account_security', 'profile_signup', 'discovery', 'pdf_ascii', 'pdf_latin', 'pdf_devanagari'].includes(route), 'Use operations, account_security, profile_signup, discovery, pdf_ascii, pdf_latin or pdf_devanagari for --route.');
const pdf = route.startsWith('pdf_');
const discovery = route === 'discovery';
const signup = route === 'profile_signup';
if (signup) assert.equal(count, 40, 'Use 40 signup reads plus ten warmups within the unchanged isolated 50/day allowance.');
const discoveryShape = option('--discovery-shape', 'ordinary');
assert.ok(['ordinary', 'truncated_script'].includes(discoveryShape), 'Use ordinary or truncated_script for --discovery-shape.');
const output = option('--output', `/tmp/hireflow-p1-capacity/${route}-${baseline || 'current'}.json`);
const sourceName = pdf ? 'pdf' : signup ? 'profile' : discovery ? 'intelligence' : route === 'operations' ? 'telemetry' : 'account_security';
const sourcePath = `${root}cloudflare/src/${sourceName}.ts`;
let source = readFileSync(sourcePath, 'utf8');
const sourceFile = option('--source-file', null);
assert.ok(!(sourceFile && baseline), 'Use --source-file or --baseline-ref, not both.');
if (sourceFile) source = readFileSync(sourceFile, 'utf8');
if (baseline) {
  const result = spawnSync('git', ['show', `${baseline}:cloudflare/src/${sourceName}.ts`], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, 'The requested baseline source could not be read.');
  source = result.stdout;
}
const fixture = { name: 'Synthetic Capacity QA', email: 'capacity@example.com', skills: ['Python', 'SQL'], summary: 'Student developer building Python APIs and SQL data checks.',
  experience: [{ role: 'Student contributor', company: 'Example College', bullets: ['Implemented a Python API and tested SQL queries.'] }],
  projects: [{ name: 'Course Archive', tech: ['Python', 'SQL'], description: 'Built a searchable archive for synthetic class notes.' }],
  education: [{ degree: 'B.Tech Computer Science', institution: 'Example University', year: '2027' }] };
if (route === 'pdf_latin') { fixture.name = 'José Álvarez'; fixture.summary = 'Développeur étudiant: API Python, qualité et données vérifiées.'; }
if (route === 'pdf_devanagari') { fixture.name = 'किरण शर्मा'; fixture.summary = 'दिल्ली के विद्यार्थी ने कृत्रिम बुद्धिमत्ता परियोजना बनाई।'; fixture.education[0].institution = 'प्रौद्योगिकी संस्थान, दिल्ली'; }
const bundle = (await build({
  stdin: { contents: route === 'operations'
    ? `import {getOperationsStatus} from ${JSON.stringify(sourcePath)}; export default {async fetch(request,env){return Response.json(await getOperationsStatus(env,1));}}`
    : signup ? `import {saveProfile} from ${JSON.stringify(sourcePath)}; export default {fetch(request,env){return saveProfile(request,env);}}`
    : discovery ? `import {discoverJobs} from ${JSON.stringify(sourcePath)}; export default {async fetch(request,env){return Response.json(await discoverJobs(env,{mode:'internship',skills:['Python','SQL'],target_roles:['AI Engineer']}));}}`
    : pdf ? `import {createResume} from ${JSON.stringify(sourcePath)}; const profile=${JSON.stringify(fixture)};export default {fetch(){return new Response(createResume(profile,{listing_type:'internship'},['Python']),{headers:{'Content-Type':'application/pdf'}});}}`
    : `import {accountSecurity} from ${JSON.stringify(sourcePath)}; export default {async fetch(request,env){return accountSecurity(request,env);}}`, resolveDir: root },
  plugins: [{ name: 'selected-route-source', setup(build) { build.onLoad({ filter: new RegExp(`[/\\\\]src[/\\\\]${sourceName}\\.ts$`) }, () => ({ contents: source, loader: 'ts', resolveDir: `${root}cloudflare/src` })); } }],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent',
})).outputFiles[0].text;
const discoveryDescription = 'Build Python and SQL APIs with mentoring. Implement carefully tested endpoints, review code, maintain documentation, and deliver a paid student internship project. '.repeat(50).trim();
const discoveryDomains = ['internshala.com', 'wellfound.com', 'job-boards.greenhouse.io', 'jobs.lever.co', 'linkedin.com'];
const fixtureUrl = (domain, index) => domain === 'internshala.com' ? `https://${domain}/internship/detail/ai-intern-${index}` : domain.includes('greenhouse') ? `https://${domain}/example/jobs/${100 + index}` : domain.includes('lever') ? `https://${domain}/example/id-${index}` : domain === 'linkedin.com' ? `https://www.${domain}/jobs/view/ai-intern-${index}` : `https://${domain}/jobs/ai-intern-${index}`;
const searchPayloads = new Map(discoveryDomains.flatMap(domain => [true, false].map(raw => [domain + raw, JSON.stringify({ results: Array.from({ length: 4 }, (_, index) => ({ title: 'AI Engineer Intern at Example Employer', url: fixtureUrl(domain, index), content: 'A synthetic search snippet, never an authoritative job description.', ...(raw ? { raw_content: discoveryDescription.repeat(4) } : {}) })) })])));
const postingScript = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'AI Engineer Intern', hiringOrganization: { name: 'Example Employer' }, description: `<p>${discoveryDescription}</p>`, employmentType: 'INTERN', datePosted: new Date().toISOString() })}</script>`;
const htmlPayload = discoveryShape === 'truncated_script'
  ? `<html><head>${postingScript}</head><body><article>${discoveryDescription}</article><script>${'<bad '.repeat(700)}${'x'.repeat(105000)}`
  : `<html><head><script>${'/* irrelevant application JavaScript */'.repeat(2800)}</script>${postingScript}</head><body><h1>AI Engineer Intern</h1><article>${discoveryDescription}</article></body></html>`;
const atsPayload = JSON.stringify({ title: 'AI Engineer Intern', text: 'AI Engineer Intern', content: `<p>${discoveryDescription}</p>`, descriptionPlain: discoveryDescription, categories: { commitment: 'Internship' }, location: { name: 'Remote' } });
let discoverySearchCalls = 0, discoveryDetailCalls = 0, discoveryResponseBytes = 0;
let signupReads = 0;
const syntheticPdf = Buffer.from('%PDF-1.4\n' + 'synthetic profile capacity fixture\n'.repeat(62) + '\n%%EOF');
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: bundle, inspectorPort: 0, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], ...(signup ? { kvNamespaces: ['FILES_KV'] } : {}), bindings: { BROWSER_ENABLED: 'true', ...(signup ? { ACCESS_CODE: 'synthetic-local-bootstrap-access-code', GEMINI_API_KEY: 'synthetic-local-extraction-key', GEMINI_MODEL: 'synthetic-profile-model' } : {}), ...(discovery ? { TAVILY_API_KEY: 'synthetic-local-search-only' } : {}) },
  ...(signup ? { outboundService: request => {
    assert.equal(new URL(request.url).hostname, 'generativelanguage.googleapis.com');
    assert.equal(new URL(request.url).pathname, '/v1beta/models/synthetic-profile-model:generateContent');
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...fixture, email: `capacity-signup-${signupReads}@example.com`, mode: 'internship', weekly_quota: 1 }) }] } }] });
  } } : {}),
  ...(discovery ? { outboundService: async request => {
    const url = new URL(request.url); let body;
    if (url.hostname === 'api.tavily.com') {
      const query = await request.json(); discoverySearchCalls++;
      assert.ok(discoveryDomains.includes(query.include_domains?.[0]), 'The local discovery fixture must keep every source domain.');
      body = searchPayloads.get(query.include_domains[0] + Boolean(query.include_raw_content));
    } else { assert.ok(discoveryDomains.some(domain => url.hostname.endsWith(domain)) || ['api.lever.co', 'boards-api.greenhouse.io'].includes(url.hostname), 'Unexpected external target in isolated benchmark.'); discoveryDetailCalls++; body = /api\.lever|boards-api\.greenhouse/.test(url.hostname) ? atsPayload : htmlPayload; }
    assert.ok(body); discoveryResponseBytes += Buffer.byteLength(body);
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  } } : {}),
}));
let ws;
try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(`${root}cloudflare/migrations`).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    await db.batch(unstable_splitSqlQuery(readFileSync(`${root}cloudflare/migrations/${file}`, 'utf8')).map(sql => db.prepare(sql)));
  }
  if (args.includes('--without-request-index')) await db.prepare('DROP INDEX IF EXISTS operation_events_owner_request_time').run();
  await db.prepare("INSERT INTO users(name,email,mode) VALUES('Synthetic capacity','capacity@example.com','internship')").run();
  const token = 'a'.repeat(64);
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,id,created_at,label) VALUES(?,1,?,?,?,?)')
    .bind(createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600000).toISOString(), randomUUID(), new Date().toISOString(), 'Synthetic benchmark browser').run();
  await db.prepare(`WITH RECURSIVE counter(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counter WHERE n<1000)
    INSERT INTO operation_events(correlation_id,user_id,operation,outcome,latency_ms)
    SELECT '00000000-0000-4000-8000-000000000000',1,'request','success',n FROM counter`).run();
  const plan=(await db.prepare("EXPLAIN QUERY PLAN SELECT latency_ms FROM operation_events WHERE user_id=1 AND operation='request' AND created_at>='2000-01-01' ORDER BY created_at DESC LIMIT 1000").all()).results.map(row=>row.detail);
  let pdfBytes = null,pdfHash=null;
  const read = async () => {
    if (signup) {
      signupReads++; const body = new FormData(); body.set('resume', new File([syntheticPdf], 'synthetic.pdf', { type: 'application/pdf' }));
      const encoded = new Request('https://local.test/profile', { method: 'POST', headers: { 'X-HireFlow-Access-Code': 'synthetic-local-bootstrap-access-code', 'CF-Connecting-IP': `192.0.2.${signupReads}` }, body });
      const response = await mf.dispatchFetch(encoded.url, { method: 'POST', headers: encoded.headers, body: await encoded.arrayBuffer() });
      assert.equal(response.status, 201, response.status === 201 ? undefined : await response.text()); const value = await response.json();
      assert.equal(value.email, `capacity-signup-${signupReads}@example.com`); assert.equal(value.profile_version, 1); assert.ok(response.headers.get('set-cookie')?.includes('HttpOnly')); return value;
    }
    const response = await mf.dispatchFetch(`https://local.test/${route === 'operations' ? 'operations' : 'account/security'}`, { headers: { Cookie: `hireflow_session=${token}` } }); assert.equal(response.status, 200);
    if (pdf) { const bytes = new Uint8Array(await response.arrayBuffer()); assert.equal(new TextDecoder().decode(bytes.subarray(0,5)), '%PDF-'); assert.ok(bytes.length < 2*1024*1024); pdfBytes = bytes.length;if(pdfHash===null)pdfHash=createHash('sha256').update(bytes).digest('hex'); return; }
    const result = await response.json(); if (route === 'operations') assert.equal(result.telemetry.request_sample_count, 1000); else if (discovery) { assert.equal(result.length,8); assert.ok(result.every(job=>job.description===discoveryDescription)); } else assert.equal(result.sessions.length, 1); return result;
  };
  const coldStarted = performance.now(); await read(); const firstDispatchWall = performance.now() - coldStarted;
  for (let i = 1; i < 10; i++) await read();
  const inspector = await mf.getInspectorURL(); inspector.protocol = 'http:'; inspector.pathname = '/json/list';
  const targets = await (await fetch(inspector)).json();
  const target = targets.find(value => value.type === 'node' || value.type === 'worker') || targets[0];
  assert.ok(target?.webSocketDebuggerUrl, 'The workerd inspector target is unavailable.');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const value = JSON.parse(event.data), item = pending.get(value.id);
    if (!item) return;
    pending.delete(value.id); clearTimeout(item.timer);
    value.error ? item.reject(new Error(value.error.message)) : item.resolve(value.result);
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('The inspector connection failed.')), { once: true }); });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector ${method} timed out.`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  await command('Profiler.enable'); await command('Profiler.setSamplingInterval', { interval: 100 }); await command('Profiler.start');
  const wall = [];
  for (let i = 0; i < count; i++) { const before = performance.now(); await read(); wall.push(performance.now() - before); }
  const { profile } = await command('Profiler.stop');
  assert.ok(profile.samples?.length > 0, 'The CPU capture contains no samples.');
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const frames = new Map(); let activeMicroseconds = 0, idleMicroseconds = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = nodes.get(profile.samples[i]), name = node.callFrame.functionName || node.callFrame.url || '(anonymous)', elapsed = profile.timeDeltas[i] || 0;
    frames.set(name, (frames.get(name) || 0) + elapsed);
    if (['(idle)', '(root)'].includes(name)) idleMicroseconds += elapsed; else activeMicroseconds += elapsed;
  }
  wall.sort((a, b) => a - b); const percentile = fraction => wall[Math.max(0, Math.ceil(wall.length * fraction) - 1)];
  const result = {
    created_at: new Date().toISOString(), scope: `isolated-workerd-${route}-route`, baseline_ref: baseline, source_file: sourceFile, source_sha256: createHash('sha256').update(source).digest('hex'), bundle_sha256:createHash('sha256').update(bundle).digest('hex'),
    request_index_disabled:args.includes('--without-request-index'),latest_request_query_plan:plan,
    requests: count, concurrency: 1, fixture_owner_request_events: pdf ? null : 1000, warmup_reads: 10, first_dispatch_after_runtime_ready_wall_ms: firstDispatchWall, pdf_bytes: pdfBytes,pdf_sha256:pdfHash,
    wall_time_ms: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) },
    ...(discovery ? { discovery_fixture: { shape: discoveryShape, sources: discoveryDomains.length, search_results_per_source: 4, verified_jobs_per_read: 8, jd_characters: discoveryDescription.length, html_bytes: Buffer.byteLength(htmlPayload), average_search_calls_per_read: discoverySearchCalls/(count+10), average_detail_calls_per_read: discoveryDetailCalls/(count+10), average_provider_bytes_per_read: discoveryResponseBytes/(count+10), includes_provider_json_decode_and_html_verification: true, outbound_service: 'All responses generated outside the profiled Worker; no external network requests.' } } : {}),
    ...(signup ? { signup_fixture: { pdf_bytes: syntheticPdf.length, generated_profiles: signupReads, unique_documented_test_ips: signupReads, global_daily_quota_unchanged: 50, provider: 'External synthetic Gemini responses; no actual provider calls, billing or production storage.', includes: 'PDF multipart intake, extraction JSON, private KV persistence, owner creation, session hashing and insert.' } } : {}),
    local_v8_sampling: { samples: profile.samples.length, active_ms: activeMicroseconds / 1000, idle_ms: idleMicroseconds / 1000, average_active_ms_per_request: activeMicroseconds / 1000 / count,
      top_self_frames: [...frames].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, microseconds]) => ({ name, sampled_ms: microseconds / 1000 })) },
    note: 'Local V8 sampling identifies CPU hotspots. Active samples include V8/runtime work and do not equal Cloudflare billed CPU quantiles. Wall time is reported separately. D1 and all records are isolated; no providers, production profiles or external application forms are accessed.',
  };
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(`${output}.cpuprofile`, JSON.stringify(profile), { mode: 0o600 });
  chmodSync(output,0o600);chmodSync(`${output}.cpuprofile`,0o600);
  console.log(JSON.stringify({ ...result, profile_file: `${output}.cpuprofile`, report_file: output }, null, 2));
} finally { ws?.close(); await mf.dispose(); }
