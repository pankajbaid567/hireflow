-- Existing immutable-resume leases also dispatch bounded match/PDF queue work.
ALTER TABLE resume_preparations ADD COLUMN job_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resume_preparations ADD COLUMN kind TEXT NOT NULL DEFAULT 'resume';
ALTER TABLE resume_preparations ADD COLUMN state TEXT NOT NULL DEFAULT 'running';
ALTER TABLE resume_preparations ADD COLUMN dispatched_at TEXT;
ALTER TABLE resume_preparations ADD COLUMN failure_reason TEXT;
ALTER TABLE resume_preparations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resume_preparations ADD COLUMN object_key TEXT;
CREATE INDEX plan_work_recovery ON resume_preparations(state,dispatched_at,expires_at);
