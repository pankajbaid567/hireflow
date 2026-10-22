PRAGMA foreign_keys = ON;
CREATE TABLE users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE, mode TEXT NOT NULL CHECK(mode IN ('job','internship')),
 weekly_quota INTEGER NOT NULL DEFAULT 10 CHECK(weekly_quota BETWEEN 1 AND 100), profile_version INTEGER NOT NULL DEFAULT 1,
 confirmation_mode TEXT NOT NULL DEFAULT 'batch', master_profile TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, company TEXT NOT NULL,
 url TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', location TEXT,
 listing_type TEXT NOT NULL CHECK(listing_type IN ('job','internship')),
 posted_date TEXT, is_spam INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE applications (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 match_score REAL NOT NULL DEFAULT 0, skill_gaps TEXT NOT NULL DEFAULT '[]', matched_skills TEXT NOT NULL DEFAULT '[]', scored_profile_version INTEGER NOT NULL DEFAULT 0,
 resume_path TEXT, resume_version INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','planned','confirmed','applying','applied','failed','needs_action','interview','rejected','offer')),
 failure_reason TEXT, manual_action_url TEXT, applied_at TEXT, cycle_start TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, processing_started_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(user_id,job_id)
);
CREATE INDEX applications_user_cycle ON applications(user_id,cycle_start,status);
CREATE TABLE application_status_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
 status TEXT NOT NULL, reason TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX status_events_application ON application_status_events(application_id,id);
CREATE TRIGGER application_created AFTER INSERT ON applications BEGIN
 INSERT INTO application_status_events(application_id,status,reason) VALUES(NEW.id,NEW.status,NEW.failure_reason);
END;
CREATE TRIGGER application_changed AFTER UPDATE OF status ON applications WHEN OLD.status <> NEW.status BEGIN
 INSERT INTO application_status_events(application_id,status,reason) VALUES(NEW.id,NEW.status,NEW.failure_reason);
END;
CREATE TABLE resumes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(application_id,version)
);
CREATE TABLE prep_guides (
 id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
 structured_data TEXT NOT NULL, company_intel TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE weekly_reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 week_start_date TEXT NOT NULL, content TEXT NOT NULL, metrics TEXT NOT NULL,
 applied_count INTEGER NOT NULL, avg_match_score REAL NOT NULL, html_path TEXT NOT NULL,
 email_sent_at TEXT, email_failure_reason TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(user_id,week_start_date)
);
CREATE TABLE shortlists (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
 jd_text TEXT NOT NULL, candidates TEXT NOT NULL, applicant_count INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('apply','prep')), dispatched_at TEXT,
 UNIQUE(application_id,kind)
);
CREATE TABLE browser_budget (
 day TEXT PRIMARY KEY, reserved_seconds INTEGER NOT NULL DEFAULT 0, last_launch_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE login_attempts (
 key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL
);
