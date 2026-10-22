-- Only token hashes are persisted. The browser receives a five-minute,
-- single-use fragment link for the configured, approved dashboard origin.
CREATE TABLE session_transfers (
 token_hash TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL
);
CREATE INDEX session_transfers_expiry ON session_transfers(expires_at);
