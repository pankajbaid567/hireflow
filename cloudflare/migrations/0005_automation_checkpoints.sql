-- External browser session state is encrypted before persistence; no public API
-- returns this row. The review binding prevents reuse with changed facts/PDFs.
CREATE TABLE automation_checkpoints (
 application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
 review_id TEXT NOT NULL,
 binding TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('ready','advancing','submitting','submitted','uncertain')),
 step INTEGER NOT NULL CHECK(step BETWEEN 0 AND 8),
 encrypted_state TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX automation_checkpoints_expiry ON automation_checkpoints(expires_at);
