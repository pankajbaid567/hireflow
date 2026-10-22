import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;
const directory = fileURLToPath(new URL('../migrations/', import.meta.url));

// Each fixture owns a fresh isolated database. Apply the real ordered schema;
// missing tables must fail tests rather than being hidden by runtime catches.
export async function applyTestMigrations(db: TestDatabase): Promise<void> {
  for (const file of readdirSync(directory).filter(file => /^\d+.*\.sql$/.test(file)).sort()) {
    const statements = unstable_splitSqlQuery(readFileSync(`${directory}${file}`, 'utf8'));
    if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
  }
}
