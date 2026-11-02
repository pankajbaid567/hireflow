-- Email ownership proof (audit follow-up). Additive only: old code ignores both objects.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
CREATE TABLE email_verifications(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_email_verifications_user ON email_verifications(user_id,created_at);
