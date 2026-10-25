-- Explicit owner-requested refreshes are transient queue authority, not backups.
CREATE TABLE prep_refreshes (
 application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
 token TEXT NOT NULL,
 profile_version INTEGER NOT NULL,
 job_version INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed')),
 expires_at TEXT NOT NULL,
 dispatched_at TEXT,
 failure_reason TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX prep_refresh_recovery ON prep_refreshes(state,dispatched_at,expires_at);
CREATE TRIGGER workspace_revision_prep_refresh_insert AFTER INSERT ON prep_refreshes BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_prep_refresh_update AFTER UPDATE ON prep_refreshes BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_prep_refresh_delete AFTER DELETE ON prep_refreshes BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=OLD.application_id); END;
