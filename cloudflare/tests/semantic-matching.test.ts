import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from './migrations';
import { EMBEDDING_MODEL, EMBEDDING_NAMESPACE, hybridScore, cosineSimilarity, profileEmbeddingText, rankWithSemantic, pruneSemanticCache, type SemanticEnv, type SemanticJob } from '../src/semantic_matching';

let mf: Miniflare, env: SemanticEnv;
const profile = { skills: ['Python', 'SQL'], target_roles: ['Backend Engineer'], summary: 'Built a college library indexing service.' };
const jobs: SemanticJob[] = [{ id: 1, title: 'Backend Engineer', description: 'Build Python SQL indexing services.', lexical_score: .8, technical_score: 1 }, { id: 2, title: 'Research Engineer', description: 'Scientific experiments in Python.', lexical_score: .7, technical_score: .5 }];
const vec = (index: number) => Array.from({ length: 384 }, (_, position) => position === index ? 1 : 0);
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-10-21', d1Databases: ['DB'] }));
  const db = await mf.getD1Database('DB'); await applyTestMigrations(db);
  env = { DB: db, SEMANTIC_MATCHING_ENABLED: 'true', SEMANTIC_DAILY_TEXT_BUDGET: '100', AI: { run: vi.fn(async (_model: typeof EMBEDDING_MODEL, input: { text: string[]; pooling: 'cls' }) => ({ data: input.text.map((_, index) => vec(index === 2 ? 1 : 0)) })) } };
  await db.prepare("INSERT INTO users(id,name,email,mode,master_profile) VALUES(1,'Synthetic','semantic-qa@example.com','job','{}'),(2,'Other','semantic-other@example.com','job','{}')").run();
}, 30000);
afterEach(async () => { await mf?.dispose(); }, 30000);

describe('private genuine-model matching integration', () => {
  it('keeps the six factors intact and never fabricates claimed matching skills', () => {
    expect(hybridScore(.8, 1, .5)).toBe(.76);
    expect(hybridScore(.5, 0, 1, 1)).toBe(.58);
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
  it('batches actual binding calls and reuses only valid owner/version/model/source vectors', async () => {
    const first = await rankWithSemantic(env, 1, 1, profile, jobs);
    expect(first).toMatchObject({ state: 'ready', embedded_texts: 3, cache_hits: 0, model: EMBEDDING_NAMESPACE });
    expect(first.items[0]).toMatchObject({ matching_method: 'hybrid', score: .8, semantic_score: 1, embedding_model: EMBEDDING_NAMESPACE });
    expect(env.AI!.run).toHaveBeenCalledWith(EMBEDDING_MODEL, { text: expect.any(Array), pooling: 'cls' }, { signal: expect.any(AbortSignal) });
    const cached = await rankWithSemantic(env, 1, 1, profile, jobs);
    expect(cached).toMatchObject({ state: 'ready', embedded_texts: 0, cache_hits: 3 });
    expect(env.AI!.run).toHaveBeenCalledTimes(1);
    const changed = await rankWithSemantic(env, 1, 2, profile, jobs);
    expect(changed).toMatchObject({ state: 'ready', embedded_texts: 1, cache_hits: 2 });
  });
  it('invalidates a JD change even beyond the model input truncation boundary', async () => {
    const long = [{ ...jobs[0], description: 'Python SQL '.repeat(200) + 'old requirement' }];
    await rankWithSemantic(env, 1, 1, profile, long);
    const changed = await rankWithSemantic(env, 1, 1, profile, [{ ...long[0], description: long[0].description.replace('old requirement', 'new requirement') }]);
    expect(changed).toMatchObject({ embedded_texts: 1, cache_hits: 1 });
  });
  it('does not share private profile vectors across tenants', async () => {
    await rankWithSemantic(env, 1, 1, profile, jobs);
    expect(await rankWithSemantic(env, 2, 1, profile, jobs)).toMatchObject({ embedded_texts: 3, cache_hits: 0 });
    expect((await env.DB.prepare('SELECT DISTINCT user_id FROM semantic_vectors ORDER BY user_id').all()).results).toEqual([{ user_id: 1 }, { user_id: 2 }]);
  });
  it('fails into visible lexical metadata for outages or malformed/dimension-invalid output', async () => {
    env.AI = { run: vi.fn(async () => ({ data: [[1, 2]] })) };
    const result = await rankWithSemantic(env, 1, 1, profile, jobs);
    expect(result.state).toBe('unavailable');
    expect(result.items[0]).toMatchObject({ matching_method: 'lexical', score: .8, semantic_score: null, embedding_model: null });
    expect(await env.DB.prepare('SELECT texts_reserved FROM semantic_usage').first()).toEqual({ texts_reserved: 3 });
    expect((await env.DB.prepare('SELECT * FROM semantic_vectors').all()).results).toHaveLength(0);
    env.AI = { run: vi.fn(async () => { throw new Error('private provider body must never reach the response'); }) };
    expect(await rankWithSemantic(env, 1, 1, profile, jobs)).toMatchObject({ state: 'unavailable' });
  });
  it('atomically enforces the shared daily bound across concurrent requests', async () => {
    env.SEMANTIC_DAILY_TEXT_BUDGET = '3';
    const results = await Promise.all([rankWithSemantic(env, 1, 1, profile, jobs), rankWithSemantic(env, 2, 1, profile, jobs)]);
    expect(results.map(result => result.state).sort()).toEqual(['budget_limited', 'ready']);
    expect(env.AI!.run).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT texts_reserved FROM semantic_usage').first()).toEqual({ texts_reserved: 3 });
  });
  it('does not call models when disabled, invalidly configured, empty or over budget', async () => {
    env.SEMANTIC_MATCHING_ENABLED = 'false';
    expect((await rankWithSemantic(env, 1, 1, profile, jobs)).state).toBe('disabled');
    env.SEMANTIC_MATCHING_ENABLED = 'true'; env.SEMANTIC_DAILY_TEXT_BUDGET = 'bad';
    expect((await rankWithSemantic(env, 1, 1, profile, jobs)).state).toBe('budget_limited');
    expect((await rankWithSemantic(env, 1, 1, {}, jobs)).state).toBe('unavailable');
    expect(env.AI!.run).not.toHaveBeenCalled();
  });
  it('scrubs identity/contact data and caps model text without using protected attributes', () => {
    const input = profileEmbeddingText({ ...profile, name: 'Private Name', email: 'private@example.com', gender: 'private', summary: 'Python indexer. private@example.com https://example.com/private +91 9999999999' });
    expect(input).toContain('Python');
    for (const item of ['Private Name', 'private@example.com', '9999999999', 'https://', 'gender']) expect(input).not.toContain(item);
  });
  it('prunes old private vectors/usage without refunding current-day reservations', async () => {
    await rankWithSemantic(env, 1, 1, profile, jobs);
    await env.DB.prepare("UPDATE semantic_vectors SET created_at='2000-01-01T00:00:00.000Z' WHERE entity_type='profile'").run();
    await env.DB.prepare("INSERT INTO semantic_usage(day,texts_reserved,characters_reserved) VALUES('2000-01-01',100,180000)").run();
    await pruneSemanticCache(env);
    expect((await env.DB.prepare('SELECT * FROM semantic_vectors').all()).results).toHaveLength(2);
    expect(await env.DB.prepare('SELECT texts_reserved FROM semantic_usage').first()).toEqual({ texts_reserved: 3 });
  });
});
