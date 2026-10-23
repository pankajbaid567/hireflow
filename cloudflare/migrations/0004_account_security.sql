ALTER TABLE sessions ADD COLUMN id TEXT;
ALTER TABLE sessions ADD COLUMN created_at TEXT;
ALTER TABLE sessions ADD COLUMN label TEXT;
UPDATE sessions SET id=lower(hex(randomblob(16))),
 created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),label='Existing browser session';
CREATE UNIQUE INDEX sessions_public_id ON sessions(id);
-- Pre-migration links have no source binding and intentionally cannot be used.
-- Their signed-in owners can mint a new five-minute link after migration.
ALTER TABLE session_transfers ADD COLUMN source_session_hash TEXT;
ALTER TABLE session_transfers ADD COLUMN claimed_session_id TEXT;

CREATE TABLE account_owners (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 user_handle TEXT NOT NULL UNIQUE
);
CREATE TABLE account_passkeys (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
 transports TEXT NOT NULL DEFAULT '[]', name TEXT NOT NULL,
 created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE INDEX passkeys_owner ON account_passkeys(user_id);
CREATE TABLE account_challenges (
 id TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK(purpose IN ('register','authenticate')),
 user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
 session_hash TEXT, browser_hash TEXT NOT NULL,
 challenge TEXT NOT NULL, origin TEXT NOT NULL, rp_id TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
CREATE INDEX challenges_expiry ON account_challenges(expires_at);
CREATE TABLE account_recovery_keys (
 token_hash TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_session_id TEXT
);
CREATE INDEX recovery_keys_owner ON account_recovery_keys(user_id,expires_at);
