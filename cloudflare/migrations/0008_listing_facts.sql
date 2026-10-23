ALTER TABLE jobs ADD COLUMN canonical_url TEXT;
ALTER TABLE jobs ADD COLUMN application_url TEXT;
ALTER TABLE jobs ADD COLUMN source TEXT;
ALTER TABLE jobs ADD COLUMN required_skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN required_experience TEXT;
ALTER TABLE jobs ADD COLUMN expires_at TEXT;
ALTER TABLE jobs ADD COLUMN selection_process TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN compensation TEXT;
ALTER TABLE jobs ADD COLUMN provenance TEXT NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN company_key TEXT;
ALTER TABLE jobs ADD COLUMN spam_confidence REAL;
ALTER TABLE jobs ADD COLUMN quality_reason TEXT;
ALTER TABLE jobs ADD COLUMN quality_method TEXT;
ALTER TABLE jobs ADD COLUMN facts_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE applications ADD COLUMN scored_job_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE applications ADD COLUMN job_snapshot TEXT;
UPDATE jobs SET canonical_url=url,application_url=url;
CREATE INDEX jobs_company_identity ON jobs(company_key);
CREATE INDEX jobs_expiry ON jobs(expires_at);
CREATE TRIGGER job_facts_changed AFTER UPDATE OF title,company,url,description,location,listing_type,posted_date,application_url,expires_at,required_skills,required_experience,compensation,selection_process ON jobs
 WHEN OLD.title IS NOT NEW.title OR OLD.company IS NOT NEW.company OR OLD.url IS NOT NEW.url OR OLD.description IS NOT NEW.description
 OR OLD.location IS NOT NEW.location OR OLD.listing_type IS NOT NEW.listing_type OR OLD.posted_date IS NOT NEW.posted_date OR OLD.application_url IS NOT NEW.application_url OR OLD.expires_at IS NOT NEW.expires_at
 OR OLD.required_skills IS NOT NEW.required_skills OR OLD.required_experience IS NOT NEW.required_experience OR OLD.compensation IS NOT NEW.compensation OR OLD.selection_process IS NOT NEW.selection_process BEGIN
 UPDATE jobs SET facts_version=OLD.facts_version+1 WHERE id=NEW.id;
END;
-- New material fields invalidate displayable review IDs as well as the hash gate.
DROP TRIGGER review_job_invalidated;
CREATE TRIGGER review_job_invalidated AFTER UPDATE OF description,url,title,company,location,listing_type,posted_date,application_url,expires_at,required_skills,required_experience,compensation,selection_process ON jobs
 WHEN OLD.description IS NOT NEW.description OR OLD.url IS NOT NEW.url OR OLD.title IS NOT NEW.title OR OLD.company IS NOT NEW.company
 OR OLD.location IS NOT NEW.location OR OLD.listing_type IS NOT NEW.listing_type OR OLD.posted_date IS NOT NEW.posted_date OR OLD.application_url IS NOT NEW.application_url OR OLD.expires_at IS NOT NEW.expires_at
 OR OLD.required_skills IS NOT NEW.required_skills OR OLD.required_experience IS NOT NEW.required_experience
 OR OLD.compensation IS NOT NEW.compensation OR OLD.selection_process IS NOT NEW.selection_process BEGIN
 UPDATE submission_reviews SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE application_id IN (SELECT id FROM applications WHERE job_id=NEW.id) AND revoked_at IS NULL;
 UPDATE applications SET status=CASE WHEN status='confirmed' THEN 'planned' ELSE status END,confirmed_review_id=NULL,resume_path=NULL,
  failure_reason='Listing facts changed. Prepare and review the current resume and answers again.'
  WHERE job_id=NEW.id AND status IN ('pending','planned','confirmed');
 DELETE FROM outbox WHERE kind='apply' AND application_id IN (SELECT id FROM applications WHERE job_id=NEW.id AND status='planned');
END;
