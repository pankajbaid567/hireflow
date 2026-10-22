-- Lease generation before calling external providers. A profile edit changes
-- the version and a completed draft keeps its immutable per-version metadata.
CREATE TABLE resume_preparations (
 application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
 profile_version INTEGER NOT NULL,
 token TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
CREATE INDEX resume_preparation_expiry ON resume_preparations(expires_at);
ALTER TABLE resumes ADD COLUMN tailoring_metadata TEXT NOT NULL DEFAULT '{}';
