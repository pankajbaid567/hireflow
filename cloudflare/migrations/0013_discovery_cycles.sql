-- Public read cache and shared, bounded budgets are distinct from private cycles.
CREATE TABLE source_read_cache (url TEXT PRIMARY KEY, status INTEGER NOT NULL, content_type TEXT NOT NULL, body TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX source_cache_expiry ON source_read_cache(expires_at);
CREATE TABLE source_domain_limits (host TEXT PRIMARY KEY, next_at INTEGER NOT NULL DEFAULT 0, blocked_until INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_status INTEGER);
CREATE TABLE discovery_daily_usage (day TEXT PRIMARY KEY, searches INTEGER NOT NULL DEFAULT 0, details INTEGER NOT NULL DEFAULT 0);
CREATE TABLE discovery_cycles (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 profile_version INTEGER NOT NULL, mode TEXT NOT NULL, profile_snapshot TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','partial','paused','cancelled','failed')),
 target_count INTEGER NOT NULL, max_searches INTEGER NOT NULL, max_details INTEGER NOT NULL,
 search_calls INTEGER NOT NULL DEFAULT 0, detail_calls INTEGER NOT NULL DEFAULT 0,
 imported_count INTEGER NOT NULL DEFAULT 0, verified_count INTEGER NOT NULL DEFAULT 0,
 query_cursor INTEGER NOT NULL DEFAULT 0, queries_json TEXT NOT NULL, sources_json TEXT NOT NULL,
 lease_token TEXT, lease_expires_at TEXT, dispatched_at TEXT, next_wake_at TEXT,
 failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 finished_at TEXT, precision_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX discovery_cycle_one_active ON discovery_cycles(user_id) WHERE state IN ('queued','running');
CREATE INDEX discovery_cycles_owner ON discovery_cycles(user_id,created_at DESC);
CREATE INDEX discovery_cycles_recovery ON discovery_cycles(state,next_wake_at,lease_expires_at);
CREATE TABLE discovery_candidates (
 cycle_id TEXT NOT NULL REFERENCES discovery_cycles(id) ON DELETE CASCADE,
 url TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
 location TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','verified','rejected','error')),
 attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT, job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
 reason TEXT, evidence_json TEXT, created_at TEXT NOT NULL, verified_at TEXT,
 PRIMARY KEY(cycle_id,url)
);
CREATE INDEX discovery_candidate_work ON discovery_candidates(cycle_id,state,created_at);
