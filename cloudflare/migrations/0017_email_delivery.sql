-- A delivery owns an immutable report/source selection and one provider payload.
CREATE TABLE email_deliveries(
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 report_id INTEGER NOT NULL REFERENCES weekly_reports(id) ON DELETE CASCADE,
 report_key TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider IN ('resend','sendgrid')),
 recipient TEXT NOT NULL,sender TEXT NOT NULL,subject TEXT NOT NULL,
 payload_key TEXT NOT NULL UNIQUE,payload_hash TEXT,source_artifacts TEXT NOT NULL,source_snapshot TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','preparing','ready','sending','retry_wait','accepted','failed','needs_action','cancelled')),
 idempotency_key TEXT NOT NULL UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,
 schedule_run_id TEXT,schedule_version INTEGER,
 attachment_count INTEGER NOT NULL DEFAULT 0,linked_count INTEGER NOT NULL DEFAULT 0,
 provider_message_id TEXT,provider_status INTEGER,failure_reason TEXT,
 lease_token TEXT,lease_expires_at TEXT,dispatched_at TEXT,next_attempt_at TEXT,
 first_attempt_at TEXT,accepted_at TEXT,delivered_at TEXT,created_at TEXT NOT NULL,finished_at TEXT,expires_at TEXT NOT NULL,
 UNIQUE(user_id,report_key,provider,recipient)
);
CREATE INDEX email_delivery_recovery ON email_deliveries(state,next_attempt_at,lease_expires_at);
CREATE INDEX email_delivery_owner ON email_deliveries(user_id,created_at);
CREATE UNIQUE INDEX email_delivery_one_scheduled_run ON email_deliveries(schedule_run_id) WHERE schedule_run_id IS NOT NULL;
ALTER TABLE weekly_schedule_runs ADD COLUMN email_delivery_id TEXT REFERENCES email_deliveries(id) ON DELETE SET NULL;
CREATE TRIGGER workspace_revision_email_insert AFTER INSERT ON email_deliveries BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_email_update AFTER UPDATE ON email_deliveries BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_email_delete AFTER DELETE ON email_deliveries BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_artifact_guard_email_insert BEFORE INSERT ON email_deliveries WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.payload_key OR object_key=NEW.report_key OR object_key IN (SELECT value FROM json_each(NEW.source_artifacts))) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_email_update BEFORE UPDATE ON email_deliveries WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.payload_key OR object_key=NEW.report_key OR object_key IN (SELECT value FROM json_each(NEW.source_artifacts))) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
-- Delivery bindings never rotate after an uncertain external request.
CREATE TRIGGER email_delivery_binding_immutable BEFORE UPDATE ON email_deliveries WHEN NEW.user_id<>OLD.user_id OR NEW.report_id<>OLD.report_id OR NEW.report_key<>OLD.report_key OR NEW.provider<>OLD.provider OR NEW.recipient<>OLD.recipient OR NEW.sender<>OLD.sender OR NEW.subject<>OLD.subject OR NEW.payload_key<>OLD.payload_key OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.source_artifacts<>OLD.source_artifacts OR NEW.source_snapshot<>OLD.source_snapshot OR NEW.schedule_run_id IS NOT OLD.schedule_run_id OR NEW.schedule_version IS NOT OLD.schedule_version OR (OLD.payload_hash IS NOT NULL AND NEW.payload_hash IS NOT OLD.payload_hash) BEGIN SELECT RAISE(ABORT,'Email delivery bindings are immutable.'); END;
