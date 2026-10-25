-- Heavy public-detail parsing/scoring belongs to the free Queue CPU allowance,
-- never the 10-ms HTTP handler. Tickets and captured preferences remain private.
CREATE TABLE discovery_runs (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 profile_version INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('internship','job')),
 profile_snapshot TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed')),
 result_json TEXT,
 failure_reason TEXT,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 claimed_at TEXT,
 dispatched_at TEXT,
 finished_at TEXT
);
CREATE UNIQUE INDEX discovery_one_active ON discovery_runs(user_id) WHERE state IN ('queued','running');
CREATE INDEX discovery_owner_created ON discovery_runs(user_id,created_at DESC);
CREATE INDEX discovery_recovery ON discovery_runs(state,dispatched_at,expires_at);
