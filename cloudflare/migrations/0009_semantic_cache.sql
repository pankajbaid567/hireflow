-- Private, bounded embedding cache. A fingerprint change never reuses a stale
-- vector; the model includes pooling/algorithm version in its cache namespace.
CREATE TABLE semantic_vectors (
 cache_key TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 entity_type TEXT NOT NULL CHECK(entity_type IN ('profile','job')),
 entity_id INTEGER NOT NULL,
 entity_version TEXT NOT NULL,
 model TEXT NOT NULL,
 source_hash TEXT NOT NULL,
 dimensions INTEGER NOT NULL CHECK(dimensions=384),
 vector_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX semantic_vectors_owner ON semantic_vectors(user_id,entity_type,entity_id);
CREATE INDEX semantic_vectors_age ON semantic_vectors(created_at);
CREATE TABLE semantic_usage (
 day TEXT PRIMARY KEY,
 texts_reserved INTEGER NOT NULL CHECK(texts_reserved>=0),
 characters_reserved INTEGER NOT NULL CHECK(characters_reserved>=0)
);
ALTER TABLE applications ADD COLUMN lexical_score REAL;
ALTER TABLE applications ADD COLUMN semantic_score REAL;
ALTER TABLE applications ADD COLUMN matching_method TEXT NOT NULL DEFAULT 'lexical';
ALTER TABLE applications ADD COLUMN embedding_model TEXT;
ALTER TABLE applications ADD COLUMN matching_algorithm TEXT NOT NULL DEFAULT 'lexical-v1';

ALTER TABLE applications ADD COLUMN matching_state TEXT NOT NULL DEFAULT 'not_scored';
