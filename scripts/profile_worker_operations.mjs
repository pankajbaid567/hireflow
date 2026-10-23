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
assert.ok(['operations', 'account_security', 'pdf_ascii', 'pdf_latin', 'pdf_devanagari'].includes(route), 'Use operations, account_security, pdf_ascii, pdf_latin or pdf_devanagari for --route.');
const pdf = route.startsWith('pdf_');
const output = option('--output', `/tmp/hireflow-p1-capacity/${route}-${baseline || 'current'}.json`);
const sourceName = pdf ? 'pdf' : route === 'operations' ? 'telemetry' : 'account_security';
const sourcePath = `${root}cloudflare/src/${sourceName}.ts`;
let source = readFileSync(sourcePath, 'utf8');
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
    : pdf ? `import {createResume} from ${JSON.stringify(sourcePath)}; const profile=${JSON.stringify(fixture)};export default {fetch(){return new Response(createResume(profile,{listing_type:'internship'},['Python']),{headers:{'Content-Type':'application/pdf'}});}}`
    : `import {accountSecurity} from ${JSON.stringify(sourcePath)}; export default {async fetch(request,env){return accountSecurity(request,env);}}`, resolveDir: root },
  plugins: [{ name: 'selected-route-source', setup(build) { build.onLoad({ filter: new RegExp(`[/\\\\]src[/\\\\]${sourceName}\\.ts$`) }, () => ({ contents: source, loader: 'ts', resolveDir: `${root}cloudflare/src` })); } }],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent',
})).outputFiles[0].text;
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: bundle, inspectorPort: 0, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], bindings: { BROWSER_ENABLED: 'true' },
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
    const response = await mf.dispatchFetch(`https://local.test/${route === 'operations' ? 'operations' : 'account/security'}`, { headers: { Cookie: `hireflow_session=${token}` } }); assert.equal(response.status, 200);
    if (pdf) { const bytes = new Uint8Array(await response.arrayBuffer()); assert.equal(new TextDecoder().decode(bytes.subarray(0,5)), '%PDF-'); assert.ok(bytes.length < 2*1024*1024); pdfBytes = bytes.length;if(pdfHash===null)pdfHash=createHash('sha256').update(bytes).digest('hex'); return; }
    const result = await response.json(); if (route === 'operations') assert.equal(result.telemetry.request_sample_count, 1000); else assert.equal(result.sessions.length, 1); return result;
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
    created_at: new Date().toISOString(), scope: `isolated-workerd-${route}-route`, baseline_ref: baseline, source_sha256: createHash('sha256').update(source).digest('hex'), bundle_sha256:createHash('sha256').update(bundle).digest('hex'),
    request_index_disabled:args.includes('--without-request-index'),latest_request_query_plan:plan,
    requests: count, concurrency: 1, fixture_owner_request_events: pdf ? null : 1000, warmup_reads: 10, first_dispatch_after_runtime_ready_wall_ms: firstDispatchWall, pdf_bytes: pdfBytes,pdf_sha256:pdfHash,
    wall_time_ms: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) },
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
