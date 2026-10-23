-- Every authorization is bound to the exact reviewed PDF, profile, JD and answers.
ALTER TABLE resumes ADD COLUMN profile_snapshot TEXT NOT NULL DEFAULT '{}';
ALTER TABLE applications ADD COLUMN confirmed_review_id TEXT;
ALTER TABLE applications ADD COLUMN resume_rejected_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN review_id TEXT;
CREATE TABLE submission_reviews (
 id TEXT PRIMARY KEY,
 application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 profile_version INTEGER NOT NULL,
 resume_version INTEGER NOT NULL,
 resume_path TEXT NOT NULL,
 resume_hash TEXT NOT NULL,
 jd_hash TEXT NOT NULL,
 binding TEXT NOT NULL,
 answers TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 approved_at TEXT,
 revoked_at TEXT
);
CREATE INDEX submission_reviews_application ON submission_reviews(application_id,created_at);
CREATE TABLE resume_retry_limits (
 application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
 attempts INTEGER NOT NULL DEFAULT 0,
 window_start INTEGER NOT NULL
);
-- Profile edits invalidate queued authorization as well as draft reviews.
CREATE TRIGGER review_profile_invalidated AFTER UPDATE OF profile_version ON users
 WHEN OLD.profile_version<>NEW.profile_version BEGIN
 UPDATE submission_reviews SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=NEW.id AND revoked_at IS NULL;
 UPDATE applications SET status=CASE WHEN status='confirmed' THEN 'planned' ELSE status END,confirmed_review_id=NULL,resume_path=NULL,
  failure_reason='Profile changed. Review the current resume and answers before confirming again.'
  WHERE user_id=NEW.id AND status IN ('pending','planned','confirmed');
 DELETE FROM outbox WHERE kind='apply' AND application_id IN (SELECT id FROM applications WHERE user_id=NEW.id AND status='planned');
END;
CREATE TRIGGER review_job_invalidated AFTER UPDATE OF description,url,title,company ON jobs
 WHEN OLD.description<>NEW.description OR OLD.url<>NEW.url OR OLD.title<>NEW.title OR OLD.company<>NEW.company BEGIN
 UPDATE submission_reviews SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE application_id IN (SELECT id FROM applications WHERE job_id=NEW.id) AND revoked_at IS NULL;
 UPDATE applications SET status=CASE WHEN status='confirmed' THEN 'planned' ELSE status END,confirmed_review_id=NULL,resume_path=NULL,
  failure_reason='Listing changed. Prepare and review the current resume and answers again.'
  WHERE job_id=NEW.id AND status IN ('pending','planned','confirmed');
 DELETE FROM outbox WHERE kind='apply' AND application_id IN (SELECT id FROM applications WHERE job_id=NEW.id AND status='planned');
END;
