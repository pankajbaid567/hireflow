/** Gated profiling of this project's five safe routes using one synthetic owner.
 * Existing OAuth is read privately through Wrangler. No keys, cookies, response
 * bodies, real profiles, job discovery or submissions enter the proof output.
 * The optional private state file holds only the synthetic session; delete it
 * with --logout-only after the before/after deployment comparison.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2), option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
assert.ok(args.includes('--run-live'), 'Pass --run-live for this explicitly gated production measurement.');
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(`${root}cloudflare/wrangler.jsonc`, 'utf8'));
const site = new URL(config.vars.PUBLIC_BASE_URL).origin, apiBase = `${site}/api`;
assert.equal(site, 'https://hireflow-dashboard.pages.dev', 'Review the canonical target before profiling another deployment.');
const stateFile = option('--state', '/tmp/hireflow-p1-capacity/private-session.json');
const output = option('--output', '/tmp/hireflow-p1-capacity/routes.json');
const version = option('--version', null);
const count = Number(option('--requests', '20')), concurrency = Number(option('--concurrency', '2'));
assert.ok(Number.isInteger(count) && count >= 5 && count <= 50, '--requests must be 5–50 per route.');
assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4, '--concurrency must be 1–4.');
assert.notEqual(resolve(output), resolve(stateFile), 'Keep the proof separate from private session state.');
if (!args.includes('--refresh-proof') && !args.includes('--logout-only')) assert.ok(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(version || ''), 'Pass the actual deployed UUID with --version before creating a fixture.');
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); chmodSync(path, 0o600); };
const call = (path, init = {}) => fetch(`${apiBase}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(12000), ...init });
async function credential() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const result = spawnSync(process.execPath, [`${root}cloudflare/node_modules/wrangler/bin/wrangler.js`, 'auth', 'token', '--json'], { cwd: `${root}cloudflare`, encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] });
  let data; try { data = JSON.parse(result.stdout); } catch { throw new Error('Existing Cloudflare credentials are unavailable.'); }
  const token = data.token || data.api_token || data.oauth_token;
  assert.ok(typeof token === 'string' && token.length > 20, 'Existing Cloudflare credentials are unavailable.'); return token;
}
async function platformMetrics(token, start, end) {
  const query = 'query Metrics($accountTag:string,$start:string,$end:string,$script:string){viewer{accounts(filter:{accountTag:$accountTag}){workersInvocationsAdaptive(limit:10,filter:{scriptName:$script,datetime_geq:$start,datetime_leq:$end}){sum{requests errors}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99 memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}}}}';
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables: { accountTag: config.account_id, start, end, script: config.name } }) });
    const data = await response.json();
    if (!response.ok || data.errors?.length) return { state: 'unavailable', http_status: response.status };
    const rows = data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
    return { state: rows.length ? 'available' : 'no_samples', source: 'Cloudflare GraphQL workersInvocationsAdaptive', window_start: start, window_end: end,
      samples: rows.map(row => ({ requests: row.sum?.requests, errors: row.sum?.errors, cpu_ms: { p50: row.quantiles.cpuTimeP50 / 1000, p95: row.quantiles.cpuTimeP95 / 1000, p99: row.quantiles.cpuTimeP99 / 1000 }, isolate_memory_bytes: { p50: row.quantiles.memoryUsageBytesP50 ?? null, p95: row.quantiles.memoryUsageBytesP95 ?? null, p99: row.quantiles.memoryUsageBytesP99 ?? null } })),
      scope_note: 'Actual whole-Worker CPU/memory during this route traffic window; other callers/cron can contribute. These are not inferred from latency and are not exclusive route attribution. Wait for analytics ingestion before refreshing.' };
  } catch { return { state: 'unavailable', reason: 'Platform metrics could not be read.' }; }
}
if (args.includes('--refresh-proof')) {
  const path = option('--refresh-proof', null), proof = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(proof.worker, config.name); assert.equal(proof.account_id, config.account_id);
  const token = await credential();
  for (const route of proof.routes) route.platform_metrics = await platformMetrics(token, route.started_at, route.finished_at);
  proof.platform_metrics = await platformMetrics(token, proof.started_at, proof.finished_at); proof.metrics_refreshed_at = new Date().toISOString(); save(path, proof);
  console.log(JSON.stringify({ state: 'metrics_refreshed', proof: path, worker: proof.worker, routes: proof.routes.map(route => ({ route: route.route, platform_state: route.platform_metrics.state })) }));
} else {
  let state;
  if (args.includes('--create-fixture')) {
    assert.ok(!existsSync(stateFile), 'A private fixture already exists; reuse it instead of creating another owner.');
    const id = randomUUID().replaceAll('-', '').slice(0, 12), email = `p1-capacity-qa-${id}@example.com`;
    const response = await call('/profile', { method: 'POST', headers: { Origin: site, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic Capacity QA', email, mode: 'internship', weekly_quota: 1, skills: ['Python', 'SQL'] }) });
    assert.equal(response.status, 201, 'Synthetic signup failed or was limited; do not bypass the limit.');
    const owner = await response.json(), cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(Number.isSafeInteger(owner.id) && /^hireflow_session=[a-f0-9]{64}$/.test(cookie || ''));
    state = { scope: 'synthetic-capacity-owner-only', user_id: owner.id, email, cookie, created_at: new Date().toISOString() }; save(stateFile, state);
  } else {
    assert.equal(statSync(stateFile).mode & 0o077, 0, 'The private fixture file must be owner-readable only.');
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  }
  assert.equal(state.scope, 'synthetic-capacity-owner-only');
  assert.ok(Number.isSafeInteger(state.user_id) && state.user_id > 0 && /^p1-capacity-qa-[a-f0-9]{12}@example\.com$/.test(state.email) && /^hireflow_session=[a-f0-9]{64}$/.test(state.cookie));
  const headers = { Cookie: state.cookie };
  if (args.includes('--logout-only')) {
    const response = await call('/session/logout', { method: 'POST', headers: { ...headers, Origin: site, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200); await response.body?.cancel();
    assert.equal((await call(`/profile/${state.user_id}`, { headers })).status, 401); unlinkSync(stateFile);
    console.log(JSON.stringify({ state: 'session_revoked', user_id: state.user_id, fixture_file_removed: true, synthetic_owner_retained_for_scoped_cleanup: true }));
  } else {
    const token = await credential(), proof = { started_at: new Date().toISOString(), account_id: config.account_id, worker: config.name, version, site, synthetic_user_id: state.user_id, requests_per_route: count, concurrency, routes: [], no_provider_or_application_requests: true };
    const routes = [['health', '/health'], ['session', '/session'], ['profile', `/profile/${state.user_id}`], ['account_security', '/account/security'], ['operations', `/operations/${state.user_id}`]];
    for (const [name, path] of routes) {
      const route = { route: name, started_at: new Date().toISOString(), completed: 0, http_statuses: {}, network_failures: 0 };
      const timings = []; let next = 0;
      const traffic = Promise.all(Array.from({ length: concurrency }, async () => { for (;;) { if (next++ >= count) return; const before = performance.now(); try { const response = await call(path, { headers }); route.http_statuses[response.status] = (route.http_statuses[response.status] || 0) + 1; await response.body?.cancel(); } catch { route.network_failures++; } timings.push(performance.now() - before); route.completed++; } }));
      if (name === 'operations' && args.includes('--capture-cpu')) {
        try {
          const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/workers/${config.name}/versions/${version}/profile`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ duration_ms: 5000, profile_type: 'cpu' }) });
          const bytes = Buffer.from(await response.arrayBuffer());
          if (response.ok) { const path = `${output}.cpu.pprof.gz`; mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 }); chmodSync(path,0o600); route.production_cpu_capture = { state: 'captured', bytes: bytes.length, profile_file: path }; }
          else { let code; try { code = JSON.parse(bytes).errors?.[0]?.code; } catch {} route.production_cpu_capture = { state: 'unavailable', http_status: response.status, error_code: code ?? null }; }
        } catch { route.production_cpu_capture = { state: 'unavailable', reason: 'Production CPU capture did not complete.' }; }
      }
      await traffic; route.finished_at = new Date().toISOString(); timings.sort((a, b) => a - b);
      const percentile = fraction => timings[Math.max(0, Math.ceil(timings.length * fraction) - 1)];
      route.wall_time_ms = { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) }; proof.routes.push(route); save(output, proof);
    }
    proof.finished_at = new Date().toISOString();
    for (const route of proof.routes) route.platform_metrics = await platformMetrics(token, route.started_at, route.finished_at);
    proof.platform_metrics = await platformMetrics(token, proof.started_at, proof.finished_at); proof.metrics_refreshed_at = new Date().toISOString();
    proof.note = 'Five fixed GET-only routes. The one optional synthetic signup is explicit; no model diagnostics, jobs, resumes, queues, submissions or email are invoked. Request wall percentiles and platform CPU/memory are distinct. The private fixture session is omitted from proof and must be revoked with --logout-only after comparison.';
    save(output, proof);
    console.log(JSON.stringify({ proof: output, worker: proof.worker, version, synthetic_user_id: state.user_id, requests: proof.routes.reduce((sum, route) => sum + route.completed, 0), routes: proof.routes.map(route => ({ route: route.route, http_statuses: route.http_statuses, network_failures: route.network_failures, wall_time_ms: route.wall_time_ms, production_cpu_capture: route.production_cpu_capture })) }, null, 2));
  }
}
