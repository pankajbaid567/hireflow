-- Scheduling prepares drafts only; it cannot create submission authorizations.
CREATE TABLE weekly_schedules(
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',weekday INTEGER NOT NULL DEFAULT 1 CHECK(weekday BETWEEN 0 AND 6),
 hour INTEGER NOT NULL DEFAULT 9 CHECK(hour BETWEEN 0 AND 23),minute INTEGER NOT NULL DEFAULT 0 CHECK(minute BETWEEN 0 AND 59),
 discovery_target INTEGER NOT NULL DEFAULT 20 CHECK(discovery_target BETWEEN 1 AND 50),
 prepare_guides INTEGER NOT NULL DEFAULT 1 CHECK(prepare_guides IN (0,1)),
 email_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(email_opt_in IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1,next_run_at TEXT,updated_at TEXT NOT NULL
);
CREATE INDEX weekly_schedule_due ON weekly_schedules(enabled,next_run_at);
CREATE TABLE weekly_schedule_runs(
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 local_week TEXT NOT NULL,schedule_version INTEGER NOT NULL,profile_version INTEGER NOT NULL,
 settings TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','waiting','completed','failed','cancelled')),
 stage TEXT NOT NULL DEFAULT 'discovery',discovery_id TEXT,application_ids TEXT NOT NULL DEFAULT '[]',
 attempts INTEGER NOT NULL DEFAULT 0,guide_cursor INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,lease_expires_at TEXT,next_wake_at TEXT,dispatched_at TEXT,
 reason TEXT,created_at TEXT NOT NULL,finished_at TEXT,expires_at TEXT NOT NULL,
 UNIQUE(user_id,local_week)
);
CREATE INDEX weekly_schedule_work ON weekly_schedule_runs(state,next_wake_at,lease_expires_at);
CREATE TABLE workspace_reminders(
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL UNIQUE REFERENCES weekly_schedule_runs(id) ON DELETE CASCADE,
 message TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT
);
ALTER TABLE discovery_cycles ADD COLUMN schedule_run_id TEXT REFERENCES weekly_schedule_runs(id) ON DELETE SET NULL;
CREATE INDEX discovery_schedule_owner ON discovery_cycles(schedule_run_id,state);
