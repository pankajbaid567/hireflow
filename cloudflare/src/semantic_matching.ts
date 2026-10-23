/** Genuine 384-dimensional embeddings; six-factor lexical weights stay intact.
 * Only the existing 40% technical component receives a bounded semantic blend.
 * Vectors, source hashes and ownership never leave the private D1 cache.
 */
export const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5' as const;
export const MATCHING_ALGORITHM = 'six-factor-technical-hybrid-v1';
export const EMBEDDING_NAMESPACE = `${EMBEDDING_MODEL}:cls:profile-jd-v1`;
export const SEMANTIC_ALPHA = 0.2;
export const EMBEDDING_DIMENSIONS = 384;
const MAX_TEXT = 1800;
const MAX_JOBS = 20;
type Data = Record<string, unknown>;
export interface SemanticJob extends Data { id?: number; job_id?: number; lexical_score: number; technical_score: number; }
export interface EmbeddingBinding {
  run(model: typeof EMBEDDING_MODEL, input: { text: string[]; pooling: 'cls' }, options?: { signal: AbortSignal }): Promise<unknown>;
}
export interface SemanticEnv { DB: D1Database; AI?: EmbeddingBinding; SEMANTIC_MATCHING_ENABLED?: string; SEMANTIC_DAILY_TEXT_BUDGET?: string; }
export interface SemanticResult { job_id: number; score: number; lexical_score: number; semantic_score: number | null; matching_method: 'hybrid' | 'lexical'; embedding_model: string | null; matching_algorithm: string; }
export interface SemanticRanking { items: SemanticResult[]; state: 'ready' | 'disabled' | 'unavailable' | 'budget_limited'; model: string; embedded_texts: number; cache_hits: number; }
export function semanticDailyTextBudget(env: Pick<SemanticEnv, 'SEMANTIC_DAILY_TEXT_BUDGET'>): number {
  const configured = Number(env.SEMANTIC_DAILY_TEXT_BUDGET ?? 100);
  return Number.isFinite(configured) ? Math.max(0, Math.min(100, Math.floor(configured))) : 0;
}
/** Recomputable private vectors are not application evidence or PDF history. */
export async function pruneSemanticCache(env: Pick<SemanticEnv, 'DB'>): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM semantic_vectors WHERE created_at<?').bind(new Date(Date.now() - 30 * 86400000).toISOString()),
    env.DB.prepare('DELETE FROM semantic_usage WHERE day<?').bind(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)),
  ]);
}
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const round = (value: number) => Math.round(clamp(value) * 10000) / 10000;
const clean = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim() : '';
const list = (value: unknown): string[] => Array.isArray(value) ? value.slice(0, 100).flatMap(item => typeof item === 'string' ? [clean(item)] : []) : [];
function privateFacts(value: string): string {
  // Contact/URLs do not help matching. Never intentionally send them to the
  // embedding service, even when a user put them inside their summary.
  return value.replace(/https?:\/\/\S+/gi, ' ').replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, ' ').replace(/(?:\+?\d[\s().-]*){9,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}
export function profileEmbeddingText(profile: Data): string {
  const projects = Array.isArray(profile.projects) ? profile.projects.slice(0, 8).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const project = item as Data; return [clean(project.name), clean(project.description), ...list(project.tech)];
  }) : [];
  const skills = list(profile.skills).join(', '), roles = list(profile.target_roles).join(', ');
  return privateFacts([skills ? `Skills: ${skills}` : '', roles ? `Target roles: ${roles}` : '', clean(profile.summary), ...projects].filter(Boolean).join('. '));
}
export function jobEmbeddingText(job: Data): string {
  return privateFacts([clean(job.title), clean(job.description)].filter(Boolean).join('. '));
}
/** Inputs are not hiring probabilities. Negative similarities provide no boost. */
export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < left.length; i++) { if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) return 0; dot += left[i] * right[i]; aa += left[i] ** 2; bb += right[i] ** 2; }
  return aa && bb ? clamp(dot / Math.sqrt(aa * bb)) : 0;
}
export function hybridScore(lexical: number, technical: number, semantic: number, alpha = SEMANTIC_ALPHA): number {
  // The 40/20/15/10/10/5 factor weights are unchanged. Alpha is constrained
  // independently of config, so semantics cannot erase explicit skill gaps.
  return round(clamp(lexical) + 0.4 * Math.max(0, Math.min(SEMANTIC_ALPHA, alpha)) * (clamp(semantic) - clamp(technical)));
}
function vector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) return null;
  return value.some(item => item !== 0) ? value : null;
}
async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
interface Entry { key: string; type: 'profile' | 'job'; id: number; version: string; sourceHash: string; text: string; value: number[] | null; }
export async function rankWithSemantic(env: SemanticEnv, userId: number, profileVersion: number, profile: Data, jobs: SemanticJob[]): Promise<SemanticRanking> {
  const selected = jobs.slice(0, MAX_JOBS);
  const fallback = (state: SemanticRanking['state'], cacheHits = 0, embeddedTexts = 0): SemanticRanking => ({ state, model: EMBEDDING_NAMESPACE, cache_hits: cacheHits, embedded_texts: embeddedTexts, items: selected.map(job => ({ job_id: Number(job.job_id ?? job.id), score: round(job.lexical_score), lexical_score: round(job.lexical_score), semantic_score: null, matching_method: 'lexical', embedding_model: null, matching_algorithm: MATCHING_ALGORITHM })) });
  if (env.SEMANTIC_MATCHING_ENABLED !== 'true') return fallback('disabled');
  if (!env.AI || !Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(profileVersion) || profileVersion < 1 || selected.some(job => !Number.isSafeInteger(job.job_id ?? job.id) || Number(job.job_id ?? job.id) <= 0)) return fallback('unavailable');
  if (!profileEmbeddingText(profile)) return fallback('unavailable');
  if (!selected.length) return { ...fallback('ready'), items: [] };
  let cacheHits = 0, embeddedTexts = 0;
  try {
    const sources: Omit<Entry, 'key' | 'sourceHash' | 'value'>[] = [{ type: 'profile', id: userId, version: String(profileVersion), text: profileEmbeddingText(profile) }, ...selected.map(job => ({ type: 'job' as const, id: Number(job.job_id ?? job.id), version: '', text: jobEmbeddingText(job) }))];
    const fullSources = [JSON.stringify(canonical(profile)), ...selected.map(job => JSON.stringify(canonical({ title: job.title, description: job.description, listing_type: job.listing_type, location: job.location, required_skills: job.required_skills, required_experience: job.required_experience })))];
    const entries = await Promise.all(sources.map(async (source, index): Promise<Entry> => {
      const sourceHash = await hash(fullSources[index]), version = source.version || sourceHash;
      return { ...source, version, sourceHash, key: await hash(`${userId}:${source.type}:${source.id}:${version}:${EMBEDDING_NAMESPACE}:${sourceHash}`), value: null };
    }));
    const cached = await env.DB.prepare('SELECT cache_key,vector_json FROM semantic_vectors WHERE user_id=? AND cache_key IN (SELECT value FROM json_each(?))').bind(userId, JSON.stringify(entries.map(entry => entry.key))).all<{ cache_key: string; vector_json: string }>();
    const byKey = new Map(cached.results.map(row => [row.cache_key, row.vector_json]));
    for (const entry of entries) { const saved = byKey.get(entry.key); if (saved) { try { entry.value = vector(JSON.parse(saved)); } catch { /* Corrupt cache gets a bounded fresh embedding. */ } if (entry.value) cacheHits++; } }
    const missing = entries.filter(entry => !entry.value);
    if (missing.length) {
      const maximum = semanticDailyTextBudget(env);
      const characters = missing.reduce((sum, entry) => sum + entry.text.length, 0);
      const reservation = await env.DB.prepare(`INSERT INTO semantic_usage(day,texts_reserved,characters_reserved) SELECT ?,?,? WHERE ?<=?
        ON CONFLICT(day) DO UPDATE SET texts_reserved=texts_reserved+excluded.texts_reserved,characters_reserved=characters_reserved+excluded.characters_reserved
        WHERE texts_reserved+excluded.texts_reserved<=? RETURNING texts_reserved`).bind(new Date().toISOString().slice(0, 10), missing.length, characters, missing.length, maximum, maximum).first();
      if (!reservation) return fallback('budget_limited', cacheHits);
      // A reservation is not refunded if the provider result is uncertain.
      embeddedTexts = missing.length;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      let output: unknown;
      try { output = await env.AI.run(EMBEDDING_MODEL, { text: missing.map(entry => entry.text), pooling: 'cls' }, { signal: controller.signal }); }
      finally { clearTimeout(timer); }
      const values = output && typeof output === 'object' && 'data' in output ? output.data : null;
      if (!Array.isArray(values) || values.length !== missing.length) return fallback('unavailable', cacheHits, embeddedTexts);
      const normalized = values.map(vector);
      if (normalized.some(item => !item)) return fallback('unavailable', cacheHits, embeddedTexts);
      await env.DB.batch(missing.map((entry, index) => {
        entry.value = normalized[index];
        return env.DB.prepare(`INSERT INTO semantic_vectors(cache_key,user_id,entity_type,entity_id,entity_version,model,source_hash,dimensions,vector_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO NOTHING`).bind(entry.key, userId, entry.type, entry.id, entry.version, EMBEDDING_NAMESPACE, entry.sourceHash, EMBEDDING_DIMENSIONS, JSON.stringify(entry.value));
      }));
    }
    const profileVector = entries[0].value!;
    return { state: 'ready', model: EMBEDDING_NAMESPACE, cache_hits: cacheHits, embedded_texts: embeddedTexts, items: selected.map((job, index) => {
      const semantic = cosineSimilarity(profileVector, entries[index + 1].value!);
      return { job_id: Number(job.job_id ?? job.id), score: hybridScore(job.lexical_score, job.technical_score, semantic), lexical_score: round(job.lexical_score), semantic_score: round(semantic), matching_method: 'hybrid', embedding_model: EMBEDDING_NAMESPACE, matching_algorithm: MATCHING_ALGORITHM };
    }) };
  } catch { return fallback('unavailable', cacheHits, embeddedTexts); }
}
