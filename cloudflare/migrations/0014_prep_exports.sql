-- Immutable private guide exports. Rendering runs in Queue, never in GET/POST.
ALTER TABLE prep_guides ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE prep_guides ADD COLUMN source_profile_version INTEGER;
ALTER TABLE prep_guides ADD COLUMN source_job_version INTEGER;
CREATE TRIGGER prep_guide_revision AFTER UPDATE OF structured_data,company_intel ON prep_guides
 WHEN OLD.structured_data IS NOT NEW.structured_data OR OLD.company_intel IS NOT NEW.company_intel BEGIN
 UPDATE prep_guides SET revision=OLD.revision+1 WHERE id=NEW.id;
END;
CREATE TABLE prep_guide_exports (
 id TEXT PRIMARY KEY,
 application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 guide_id INTEGER NOT NULL REFERENCES prep_guides(id) ON DELETE CASCADE,
 version INTEGER NOT NULL,
 guide_revision INTEGER NOT NULL,
 profile_version INTEGER NOT NULL,
 job_version INTEGER NOT NULL,
 guide_profile_version INTEGER,
 guide_job_version INTEGER,
 snapshot_hash TEXT NOT NULL,
 input_snapshot TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','ready','failed','expired')),
 html_key TEXT NOT NULL UNIQUE,
 pdf_key TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 work_expires_at TEXT NOT NULL,
 dispatched_at TEXT,
 started_at TEXT,
 finished_at TEXT,
 cleaned_at TEXT,
 failure_reason TEXT,
 UNIQUE(application_id,version)
);
CREATE UNIQUE INDEX prep_export_one_active ON prep_guide_exports(application_id) WHERE state IN ('queued','running');
CREATE INDEX prep_export_owner_version ON prep_guide_exports(user_id,application_id,version DESC);
CREATE INDEX prep_export_recovery ON prep_guide_exports(state,dispatched_at,work_expires_at);
