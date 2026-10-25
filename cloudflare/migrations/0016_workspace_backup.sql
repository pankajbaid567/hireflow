-- Private workspace snapshots are data exports, never credentials or execution authority.
CREATE TABLE workspace_revisions(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO workspace_revisions(user_id) SELECT id FROM users;
CREATE TRIGGER workspace_user_created AFTER INSERT ON users BEGIN INSERT INTO workspace_revisions(user_id) VALUES(NEW.id); END;
CREATE TABLE workspace_backups(
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 profile_version INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','ready','failed','expired')),
 snapshot_key TEXT,snapshot_hash TEXT,manifest_key TEXT,manifest_hash TEXT,captured_at TEXT,
 artifact_count INTEGER NOT NULL DEFAULT 0,total_bytes INTEGER NOT NULL DEFAULT 0,
 failure_reason TEXT,lease_token TEXT,lease_expires_at TEXT,dispatched_at TEXT,
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL
);
CREATE INDEX workspace_backup_owner ON workspace_backups(user_id,created_at);
CREATE UNIQUE INDEX workspace_backup_one_active ON workspace_backups(user_id) WHERE state IN ('queued','running');
CREATE TABLE workspace_backup_files(
 backup_id TEXT NOT NULL REFERENCES workspace_backups(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,
 source_key TEXT NOT NULL,object_key TEXT NOT NULL UNIQUE,purpose TEXT NOT NULL,
 size INTEGER,sha256 TEXT,content_type TEXT,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','captured')),
 PRIMARY KEY(backup_id,ordinal)
);
CREATE TABLE workspace_deletions(
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,profile_version INTEGER NOT NULL,revision INTEGER NOT NULL,
 session_hash TEXT,nonce_hash TEXT,expires_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('preview','queued','deleting','complete','cancelled')),
 preview_json TEXT NOT NULL,files_json TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,lease_expires_at TEXT,dispatched_at TEXT,failure_reason TEXT,created_at TEXT NOT NULL
);
CREATE INDEX workspace_deletion_recovery ON workspace_deletions(state,lease_expires_at);
CREATE UNIQUE INDEX workspace_deletion_one_active ON workspace_deletions(user_id) WHERE state IN ('queued','deleting');
CREATE TABLE workspace_orphan_candidates(object_key TEXT PRIMARY KEY,first_seen_at TEXT NOT NULL);
CREATE TABLE workspace_retention_cursor(id INTEGER PRIMARY KEY CHECK(id=1),prefix_index INTEGER NOT NULL DEFAULT 0,cursor TEXT);
INSERT INTO workspace_retention_cursor(id) VALUES(1);
CREATE TABLE workspace_restore_guard(id TEXT PRIMARY KEY,source_owner_id INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE workspace_artifact_tombstones(object_key TEXT PRIMARY KEY,claimed_at TEXT NOT NULL);
CREATE TRIGGER workspace_revision_users_update AFTER UPDATE ON users BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.id; END;
CREATE TRIGGER workspace_revision_users_delete AFTER DELETE ON users BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.id; END;
CREATE TRIGGER workspace_revision_applications_insert AFTER INSERT ON applications BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_applications_update AFTER UPDATE ON applications BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_applications_delete AFTER DELETE ON applications BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_weekly_reports_insert AFTER INSERT ON weekly_reports BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_weekly_reports_update AFTER UPDATE ON weekly_reports BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_weekly_reports_delete AFTER DELETE ON weekly_reports BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_shortlists_insert AFTER INSERT ON shortlists BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_shortlists_update AFTER UPDATE ON shortlists BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_shortlists_delete AFTER DELETE ON shortlists BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_workspace_backups_insert AFTER INSERT ON workspace_backups BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_workspace_backups_update AFTER UPDATE ON workspace_backups BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_workspace_backups_delete AFTER DELETE ON workspace_backups BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_resumes_insert AFTER INSERT ON resumes BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_resumes_update AFTER UPDATE ON resumes BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_resumes_delete AFTER DELETE ON resumes BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=OLD.application_id); END;
CREATE TRIGGER workspace_revision_prep_guides_insert AFTER INSERT ON prep_guides BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_prep_guides_update AFTER UPDATE ON prep_guides BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_prep_guides_delete AFTER DELETE ON prep_guides BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=OLD.application_id); END;
CREATE TRIGGER workspace_revision_application_status_events_insert AFTER INSERT ON application_status_events BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_application_status_events_update AFTER UPDATE ON application_status_events BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_application_status_events_delete AFTER DELETE ON application_status_events BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=OLD.application_id); END;
CREATE TRIGGER workspace_revision_files_insert AFTER INSERT ON workspace_backup_files BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM workspace_backups WHERE id=NEW.backup_id); END;
CREATE TRIGGER workspace_revision_files_update AFTER UPDATE ON workspace_backup_files BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM workspace_backups WHERE id=NEW.backup_id); END;
CREATE TRIGGER workspace_revision_files_delete AFTER DELETE ON workspace_backup_files BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM workspace_backups WHERE id=OLD.backup_id); END;

-- Global listing edits also invalidate snapshots of linked owner data.
CREATE TRIGGER workspace_revision_jobs_update AFTER UPDATE ON jobs BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id IN (SELECT user_id FROM applications WHERE job_id=NEW.id); END;
CREATE TRIGGER workspace_revision_guide_exports_insert AFTER INSERT ON prep_guide_exports BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_guide_exports_update AFTER UPDATE ON prep_guide_exports BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_guide_exports_delete AFTER DELETE ON prep_guide_exports BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;

-- Publication and garbage collection serialize through D1 tombstones. A late
-- writer cannot attach an artifact after cleanup atomically claimed its key.
CREATE TRIGGER workspace_artifact_guard_users_insert BEFORE INSERT ON users WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=json_extract(NEW.master_profile,'$.master_resume_path')) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_users_update BEFORE UPDATE ON users WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=json_extract(NEW.master_profile,'$.master_resume_path')) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_applications_insert BEFORE INSERT ON applications WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.resume_path) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_applications_update BEFORE UPDATE ON applications WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.resume_path) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_resumes_insert BEFORE INSERT ON resumes WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_resumes_update BEFORE UPDATE ON resumes WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_resumes_profile_insert BEFORE INSERT ON resumes WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=json_extract(NEW.profile_snapshot,'$.master_resume_path')) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_resumes_profile_update BEFORE UPDATE ON resumes WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=json_extract(NEW.profile_snapshot,'$.master_resume_path')) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_weekly_reports_insert BEFORE INSERT ON weekly_reports WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.html_path) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_weekly_reports_update BEFORE UPDATE ON weekly_reports WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.html_path) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_submission_reviews_insert BEFORE INSERT ON submission_reviews WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.resume_path) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_submission_reviews_update BEFORE UPDATE ON submission_reviews WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.resume_path) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_resume_preparations_insert BEFORE INSERT ON resume_preparations WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_resume_preparations_update BEFORE UPDATE ON resume_preparations WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_prep_guide_exports_insert BEFORE INSERT ON prep_guide_exports WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.html_key) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_prep_guide_exports_update BEFORE UPDATE ON prep_guide_exports WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.html_key) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_prep_guide_exports_pdf_insert BEFORE INSERT ON prep_guide_exports WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.pdf_key) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_prep_guide_exports_pdf_update BEFORE UPDATE ON prep_guide_exports WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.pdf_key) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_workspace_backup_files_insert BEFORE INSERT ON workspace_backup_files WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.source_key) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_workspace_backup_files_update BEFORE UPDATE ON workspace_backup_files WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.source_key) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;

-- Credential/workflow changes invalidate a concrete deletion preview too.
CREATE TRIGGER workspace_revision_sessions_insert AFTER INSERT ON sessions BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_sessions_update AFTER UPDATE ON sessions BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_sessions_delete AFTER DELETE ON sessions BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_session_transfers_insert AFTER INSERT ON session_transfers BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_session_transfers_update AFTER UPDATE ON session_transfers BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_session_transfers_delete AFTER DELETE ON session_transfers BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_account_owners_insert AFTER INSERT ON account_owners BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_account_owners_update AFTER UPDATE ON account_owners BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_account_owners_delete AFTER DELETE ON account_owners BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_account_passkeys_insert AFTER INSERT ON account_passkeys BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_account_passkeys_update AFTER UPDATE ON account_passkeys BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_account_passkeys_delete AFTER DELETE ON account_passkeys BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_account_challenges_insert AFTER INSERT ON account_challenges BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_account_challenges_update AFTER UPDATE ON account_challenges BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_account_challenges_delete AFTER DELETE ON account_challenges BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_account_recovery_keys_insert AFTER INSERT ON account_recovery_keys BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_account_recovery_keys_update AFTER UPDATE ON account_recovery_keys BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_account_recovery_keys_delete AFTER DELETE ON account_recovery_keys BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_discovery_runs_insert AFTER INSERT ON discovery_runs BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_discovery_runs_update AFTER UPDATE ON discovery_runs BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_discovery_runs_delete AFTER DELETE ON discovery_runs BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_discovery_cycles_insert AFTER INSERT ON discovery_cycles BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_discovery_cycles_update AFTER UPDATE ON discovery_cycles BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_discovery_cycles_delete AFTER DELETE ON discovery_cycles BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_outbox_insert AFTER INSERT ON outbox BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_outbox_update AFTER UPDATE ON outbox BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_outbox_delete AFTER DELETE ON outbox BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=OLD.application_id); END;
CREATE TRIGGER workspace_revision_resume_preparations_insert AFTER INSERT ON resume_preparations BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_resume_preparations_update AFTER UPDATE ON resume_preparations BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_resume_preparations_delete AFTER DELETE ON resume_preparations BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=OLD.application_id); END;
CREATE TRIGGER workspace_revision_automation_checkpoints_insert AFTER INSERT ON automation_checkpoints BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_automation_checkpoints_update AFTER UPDATE ON automation_checkpoints BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=NEW.application_id); END;
CREATE TRIGGER workspace_revision_automation_checkpoints_delete AFTER DELETE ON automation_checkpoints BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM applications WHERE id=OLD.application_id); END;
CREATE TRIGGER workspace_revision_discovery_candidates_insert AFTER INSERT ON discovery_candidates BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM discovery_cycles WHERE id=NEW.cycle_id); END;
CREATE TRIGGER workspace_revision_discovery_candidates_update AFTER UPDATE ON discovery_candidates BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM discovery_cycles WHERE id=NEW.cycle_id); END;
CREATE TRIGGER workspace_revision_discovery_candidates_delete AFTER DELETE ON discovery_candidates BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM discovery_cycles WHERE id=OLD.cycle_id); END;

-- Scheduling settings/work cannot change behind a deletion confirmation.
CREATE TRIGGER workspace_revision_weekly_schedules_insert AFTER INSERT ON weekly_schedules BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_weekly_schedules_update AFTER UPDATE ON weekly_schedules BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_weekly_schedules_delete AFTER DELETE ON weekly_schedules BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_weekly_schedule_runs_insert AFTER INSERT ON weekly_schedule_runs BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_weekly_schedule_runs_update AFTER UPDATE ON weekly_schedule_runs BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_weekly_schedule_runs_delete AFTER DELETE ON weekly_schedule_runs BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_revision_workspace_reminders_insert AFTER INSERT ON workspace_reminders BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_workspace_reminders_update AFTER UPDATE ON workspace_reminders BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_workspace_reminders_delete AFTER DELETE ON workspace_reminders BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
