/** Read-only, aggregate-only capacity evidence for an already executed cycle.
 * Makes no application/provider requests, changes no limits, and retrieves no
 * raw logs, URLs, cookies, prompts or request/response bodies.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
assert.ok(args.includes('--run-live'), 'Pass --run-live for read-only production analytics.');
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(`${root}cloudflare/wrangler.jsonc`, 'utf8'));
assert.equal(config.name, 'hireflow-api');
assert.equal(config.account_id, 'e644f1ced37b126db54d62bf6afd4d1a');
const from = Date.parse(option('--from')), to = Date.parse(option('--to'));
const version = option('--version'), output = option('--output');
assert.ok(Number.isFinite(from) && Number.isFinite(to) && from < to && to - from <= 3600000 && to <= Date.now(), 'Use an actual completed window of at most one hour.');
assert.ok(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(version || ''), 'Pass the actual deployed version UUID.');
assert.ok(output && !/private-session/.test(output), 'Pass a distinct proof output path.');
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  const child = spawnSync(process.execPath, [`${root}cloudflare/node_modules/wrangler/bin/wrangler.js`, 'auth', 'token', '--json'], { cwd: `${root}cloudflare`, encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] });
  try { const auth = JSON.parse(child.stdout); token = auth.token || auth.api_token || auth.oauth_token; } catch { /* Fail without exposing credential output. */ }
}
assert.ok(typeof token === 'string' && token.length > 20, 'Existing Cloudflare credentials are unavailable.');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function post(path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000), headers, body: JSON.stringify(body) });
  let data; try { data = await response.json(); } catch { throw new Error(`Analytics returned non-JSON HTTP ${response.status}.`); }
  if (!response.ok || data.errors?.length || data.success === false) throw new Error(`Analytics unavailable: HTTP ${response.status}, code ${data.errors?.[0]?.code ?? 'unknown'}.`);
  return data;
}
let platform;
try {
const graph = await post('/graphql', {
  query: 'query Capacity($account:string,$worker:string,$version:string,$from:string,$to:string){viewer{accounts(filter:{accountTag:$account}){workersInvocationsAdaptive(limit:10,filter:{scriptName:$worker,scriptVersion:$version,datetime_geq:$from,datetime_leq:$to}){sum{requests errors}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99 memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}}}}',
  variables: { account: config.account_id, worker: config.name, version, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
});
const graphRows = graph.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
platform = { source: 'Cloudflare GraphQL workersInvocationsAdaptive', state: graphRows.length ? 'available' : 'no_samples', trigger_dimension: 'not available in this dataset', samples: graphRows.map(row => ({
  requests: row.sum.requests, errors: row.sum.errors,
  cpu_ms: { p50: row.quantiles.cpuTimeP50 / 1000, p95: row.quantiles.cpuTimeP95 / 1000, p99: row.quantiles.cpuTimeP99 / 1000 },
  isolate_memory_bytes: { p50: row.quantiles.memoryUsageBytesP50, p95: row.quantiles.memoryUsageBytesP95, p99: row.quantiles.memoryUsageBytesP99 },
})) };
} catch (error) {
  platform = { source: 'Cloudflare GraphQL workersInvocationsAdaptive', state: 'unavailable', reason: error instanceof Error ? error.message : 'GraphQL read did not complete.', samples: [] };
}

const filters = [{ key: '$metadata.service', operation: 'eq', type: 'string', value: config.name }, { key: '$workers.scriptVersion.id', operation: 'eq', type: 'string', value: version }, { key: '$workers.cpuTimeMs', operation: 'exists', type: 'number' }];
const calculations = [{ operator: 'count', alias: 'invocations' },
  ...['median', 'p95', 'p99', 'max'].map(operator => ({ operator, key: '$workers.cpuTimeMs', keyType: 'number', alias: `cpu_${operator === 'median' ? 'p50' : operator}_ms` })),
  { operator: 'p95', key: '$workers.wallTimeMs', keyType: 'number', alias: 'wall_p95_ms' }];
let logs;
let logError;
try {
logs = await post(`/accounts/${config.account_id}/workers/observability/telemetry/query`, {
  queryId: 'p1-capacity-trigger-aggregates', dry: true, view: 'calculations', chartType: 'aggregate', ignoreSeries: true, limit: 20,
  timeframe: { from, to }, parameters: { limit: 20, datasets: ['cloudflare-workers'], filters, filterCombination: 'and',
    groupBys: [{ value: '$workers.eventType', type: 'string' }, { value: '$workers.outcome', type: 'string' }], calculations },
});
} catch (error) {
  logError = error instanceof Error ? error.message : 'Invocation aggregate read did not complete.';
}
const grouped = new Map();
for (const calculation of logs?.result?.calculations || []) {
  for (const aggregate of calculation.aggregates || []) {
    const event = aggregate.groups.find(group => group.key === '$workers.eventType')?.value;
    const outcome = aggregate.groups.find(group => group.key === '$workers.outcome')?.value;
    // Store only these fixed dimension values and numeric aggregates.
    if (!['fetch', 'queue', 'scheduled', 'alarm', 'rpc', 'tail', 'email', 'websocket'].includes(event)) continue;
    const outcomeLabel = typeof outcome === 'string' && /^[A-Za-z_]{1,40}$/.test(outcome) ? outcome : 'other';
    const key = `${event}/${outcomeLabel}`, group = grouped.get(key) || { event_type: event, outcome: outcomeLabel };
    group[calculation.alias] = typeof aggregate.value === 'number' ? aggregate.value : null;
    group.sample_interval = aggregate.sampleInterval ?? null;
    grouped.set(key, group);
  }
}
const proof = { measured_at: new Date().toISOString(), worker: config.name, account_id: config.account_id, version,
  window_start: new Date(from).toISOString(), window_end: new Date(to).toISOString(), platform,
  invocation_logs: { source: 'Cloudflare Workers Observability calculations (dry query)', state: logError ? 'unavailable' : grouped.size ? 'available' : 'no_samples', ...(logError ? { reason: logError } : {}), cpu_precision: 'The invocation log cpuTimeMs values have millisecond precision; GraphQL CPU quantiles use microsecond source values.', groups: [...grouped.values()],
    scope_note: 'Only this Worker and version in the fixed time window. Groups distinguish HTTP fetch, queue, and scheduled CPU; no raw events or user data are retrieved. Retention, sampling, missing logs and ingestion lag can make counts differ from GraphQL and client requests. A group absent from logs is unobserved, not zero cost.' },
  note: 'No application traffic, paid resources, plan changes, sampling changes or allowance resets were performed. This is an observed finite cycle; cold startup and sustained capacity are not certified.' };
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(output, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 }); chmodSync(output, 0o600);
console.log(JSON.stringify({ proof: output, version, window_start: proof.window_start, window_end: proof.window_end, platform: proof.platform, invocation_logs: proof.invocation_logs }, null, 2));
