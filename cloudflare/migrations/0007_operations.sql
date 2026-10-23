CREATE TABLE operation_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 correlation_id TEXT NOT NULL,
 user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
 cycle_id TEXT,
 operation TEXT NOT NULL,
 provider TEXT,
 model TEXT,
 outcome TEXT NOT NULL,
 latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
 error_kind TEXT,
 http_status INTEGER,
 attempt INTEGER,
 queue_delay_seconds INTEGER,
 budget_reserved_seconds INTEGER,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX operation_events_owner_cycle ON operation_events(user_id,cycle_id,created_at);
CREATE INDEX operation_events_retention ON operation_events(created_at);
CREATE INDEX operation_events_correlation ON operation_events(correlation_id);
CREATE TABLE provider_health (
 provider TEXT NOT NULL,
 model TEXT NOT NULL,
 state TEXT NOT NULL,
 error_kind TEXT,
 latency_ms INTEGER NOT NULL,
 consecutive_failures INTEGER NOT NULL DEFAULT 0,
 checked_at TEXT NOT NULL,
 PRIMARY KEY(provider,model)
);
CREATE TABLE provider_diagnostic_limits (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 next_allowed_at INTEGER NOT NULL
);
