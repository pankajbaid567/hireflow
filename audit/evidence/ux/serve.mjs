// Phase 6 local stack: real Worker in Miniflare (local D1, outbound STUBBED, no egress) behind the real Pages proxy code,
// serving frontend/dist with the headers from frontend/public/_headers (incl. '!' detach). Never touches production.
//   node audit/evidence/ux/serve.mjs [port]     (build first: cd frontend && npm run build:cloudflare)
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extname, join, normalize } from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const req = createRequire(`${root}cloudflare/package.json`);
const { buildSync } = req('esbuild'); const { Miniflare, convertV4MiniflareOptions } = req('miniflare'); const { unstable_splitSqlQuery } = req('wrangler');
const PORT = Number(process.argv[2] || 4173), ORIGIN = `http://127.0.0.1:${PORT}`, CODE = 'local-ux-audit-bootstrap-code-24-chars';
const script = buildSync({ entryPoints: [`${root}cloudflare/tests/runtime.ts`], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
const egress = [];
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, cf: false, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['FILES'], queueProducers: { APPLICATION_QUEUE: 'ux' },
  bindings: { ACCESS_CODE: CODE, ALLOWED_ORIGINS: ORIGIN, PUBLIC_BASE_URL: `${ORIGIN}/api`, COOKIE_SAME_SITE: 'Lax', BROWSER_ENABLED: 'false', LLM_PROVIDER: 'none' },
  outboundService: async (r) => { egress.push(`${r.method} ${r.url}`); return new Response('<html><title>stub</title>stub</html>', { headers: { 'content-type': 'text/html' } }); } }));
const db = await mf.getD1Database('DB');
for (const f of readdirSync(`${root}cloudflare/migrations/`).filter(f => /^\d+.*\.sql$/.test(f)).sort()) await db.batch(unstable_splitSqlQuery(readFileSync(`${root}cloudflare/migrations/${f}`, 'utf8')).map(s => db.prepare(s)));
const { proxyRequest } = await import(pathToFileURL(`${root}frontend/server/worker-proxy.js`).href);
// headers from _headers
const rules = []; let cur = null;
for (const line of readFileSync(`${root}frontend/public/_headers`, 'utf8').split('\n')) { if (!line.trim()) continue; if (/^\S/.test(line)) { cur = { path: line.trim(), set: [], drop: [] }; rules.push(cur); } else if (line.trim().startsWith('!')) cur.drop.push(line.trim().slice(1).trim().toLowerCase()); else { const i = line.indexOf(':'); cur.set.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); } }
const match = (rule, p) => rule.path.endsWith('*') ? p.startsWith(rule.path.slice(0, -1)) : rule.path === p;
const headersFor = (p) => { const h = {}; for (const r of rules) if (match(r, p)) { for (const [k, v] of r.set) h[k.toLowerCase()] = v; for (const d of r.drop) delete h[d]; } return h; };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webm': 'video/webm', '.svg': 'image/svg+xml' };
const dist = `${root}frontend/dist`;
createServer(async (rq, rs) => {
  try {
    const url = new URL(rq.url, ORIGIN);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of rq) chunks.push(c);
      const request = new Request(url, { method: rq.method, headers: Object.fromEntries(Object.entries(rq.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))), body: ['GET', 'HEAD'].includes(rq.method) ? undefined : Buffer.concat(chunks) });
      const res = await proxyRequest(request, { origin: 'https://worker.local', workspaceAccessCode: CODE, fetcher: (u, init) => mf.dispatchFetch(u, init) });
      const h = {}; res.headers.forEach((v, k) => { if (k !== 'set-cookie') h[k] = v; }); const sc = res.headers.getSetCookie?.() || []; if (sc.length) h['set-cookie'] = sc;
      rs.writeHead(res.status, h); rs.end(Buffer.from(await res.arrayBuffer())); return;
    }
    let file = normalize(join(dist, url.pathname)); if (!file.startsWith(dist)) { rs.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    const rel = '/' + file.slice(dist.length + 1);
    rs.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', ...headersFor(rel === '/index.html' ? url.pathname : rel) }); rs.end(readFileSync(file));
  } catch (e) { rs.writeHead(500).end(String(e)); }
}).listen(PORT, '127.0.0.1', () => console.log(`READY ${ORIGIN}`));
process.on('SIGTERM', async () => { console.log(JSON.stringify({ egress })); await mf.dispose(); process.exit(0); });
