/** Local operator restore only. Never connects to a remote D1/R2/KV account. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
assert.ok(args.includes('--run-isolated-restore'), 'Pass --run-isolated-restore after reviewing the private archive and destination.');
assert.ok(!args.includes('--remote'), 'Remote restore is intentionally unsupported.');
const archive = realpathSync(resolve(option('--archive') || 'missing-archive'));
const destinationArg = option('--destination'); assert.ok(destinationArg, 'Pass a new --destination directory.');
const destination = resolve(destinationArg), trustedHash = option('--manifest-sha256');
assert.ok(/^[a-f0-9]{64}$/.test(trustedHash || ''), 'Pass --manifest-sha256 from the authenticated backup status, kept separately from the archive.');
assert.ok(!existsSync(destination), 'Destination must not exist; existing databases or files are never overwritten.');
function readBounded(name, maximum) {
  const pieces = name.split('/'); assert.ok(pieces.every(p => p && p !== '.' && p !== '..'), 'Invalid archive filename.');
  let path = archive;
  for (const part of pieces) { path = join(path, part); assert.ok(!lstatSync(path).isSymbolicLink(), 'Archive symlinks are not accepted.'); }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); assert.ok(stat.isFile() && stat.size <= maximum, 'Archive entry exceeds the bounded size.'); return readFileSync(fd); } finally { closeSync(fd); }
}
const manifest = readBounded('manifest.json', 256000), snapshot = readBounded('snapshot.json', 4 * 1024 * 1024);
const parsed = JSON.parse(manifest); assert.ok(Array.isArray(parsed.artifacts) && parsed.artifacts.length <= 256, 'Invalid artifact catalog.');
for (const [i, entry] of parsed.artifacts.entries()) assert.equal(entry.name, `artifacts/${i}.bin`, 'Artifact names must match their ordinal.');
mkdirSync(destination, { mode: 0o700 }); writeFileSync(join(destination, '.restore-lock'), '', { flag: 'wx', mode: 0o600 });
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(new URL('../cloudflare/package.json', import.meta.url));
const { buildSync } = require('esbuild'), { Miniflare, convertV4MiniflareOptions } = require('miniflare'), { unstable_splitSqlQuery } = require('wrangler');
const script = buildSync({ stdin: { contents: `import {restoreWorkspaceArchive} from ${JSON.stringify(`${root}cloudflare/src/workspace_backup.ts`)};import {ApiError} from ${JSON.stringify(`${root}cloudflare/src/types.ts`)};export default {async fetch(request,env){try{if(new URL(request.url).pathname!=='/restore')return new Response(null,{status:404});const bytes=new Uint8Array(await request.arrayBuffer()),view=new DataView(bytes.buffer);const m=view.getUint32(0),s=view.getUint32(4);if(m>256000||s>4194304||bytes.length!==8+m+s)throw new ApiError(422,'Invalid archive envelope.');return Response.json(await restoreWorkspaceArchive(env,bytes.subarray(8,8+m),bytes.subarray(8+m),request.headers.get('x-manifest-sha256')||'',async ordinal=>{const response=await fetch('https://archive.invalid/'+ordinal);if(!response.ok)throw new ApiError(422,'Archive artifact is unavailable.');return new Uint8Array(await response.arrayBuffer());}));}catch(error){return Response.json({detail:error instanceof ApiError?error.message:'Isolated restore failed; source data was not changed.'},{status:error instanceof ApiError?error.status:500});}}};`, resolveDir: root }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false, logLevel: 'silent' }).outputFiles[0].text;
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], d1Persist: join(destination, 'd1'), kvNamespaces: ['FILES_KV'], kvPersist: join(destination, 'files'), bindings: { RESTORE_ISOLATED: 'true' }, outboundService: request => {
  const url = new URL(request.url); assert.equal(url.hostname, 'archive.invalid', 'Network access outside the local archive is forbidden.');
  assert.ok(/^\/\d+$/.test(url.pathname)); const ordinal = Number(url.pathname.slice(1)); assert.ok(Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < parsed.artifacts.length);
  return new Response(readBounded(`artifacts/${ordinal}.bin`, 4 * 1024 * 1024));
} }));
try {
  const db = await mf.getD1Database('DB');
  for (const name of readdirSync(`${root}cloudflare/migrations`).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    const statements = unstable_splitSqlQuery(readFileSync(`${root}cloudflare/migrations/${name}`, 'utf8')); if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
  }
  const envelope = new Uint8Array(8 + manifest.length + snapshot.length), view = new DataView(envelope.buffer); view.setUint32(0, manifest.length); view.setUint32(4, snapshot.length); envelope.set(manifest, 8); envelope.set(snapshot, 8 + manifest.length);
  const response = await mf.dispatchFetch('https://local.restore.invalid/restore', { method: 'POST', headers: { 'X-Manifest-Sha256': trustedHash }, body: envelope });
  const result = await response.json(); if (!response.ok) throw new Error(result.detail || 'Isolated restore failed.');
  writeFileSync(join(destination, 'mapping.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(destination, 'restore-receipt.json'), JSON.stringify({ state: 'restored_offline', format: parsed.format, manifest_sha256: trustedHash, restored_at: new Date().toISOString(), authentication_restored: false, outbound_authorizations_restored: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ state: 'restored_offline', user_id: result.user_id, application_count: Object.keys(result.application_ids).length, artifact_count: Object.keys(result.artifact_keys).length, destination, authentication_restored: false }));
} finally { await mf.dispose(); }
