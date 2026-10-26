-- Extend the real provider enum without relabelling existing provider facts.
-- D1 always enforces foreign keys; deferral does NOT suppress CASCADE/SET NULL.
-- Stage receipts and scheduled bindings before the parent swap, then restore
-- them in this same transaction. No queued work or signed evidence is dropped.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE email_receipts_saved AS SELECT * FROM email_receipt_events;
CREATE TABLE email_schedule_links_saved AS SELECT id,email_delivery_id FROM weekly_schedule_runs WHERE email_delivery_id IS NOT NULL;
CREATE TABLE email_workspace_revisions_saved AS SELECT * FROM workspace_revisions WHERE user_id IN (SELECT user_id FROM email_deliveries);
DROP TABLE email_receipt_events;
CREATE TABLE email_deliveries_next(
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 report_id INTEGER NOT NULL REFERENCES weekly_reports(id) ON DELETE CASCADE,
 report_key TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider IN ('resend','sendgrid','gmail')),
 recipient TEXT NOT NULL,sender TEXT NOT NULL,subject TEXT NOT NULL,
 payload_key TEXT NOT NULL UNIQUE,payload_hash TEXT,source_artifacts TEXT NOT NULL,source_snapshot TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','preparing','ready','sending','retry_wait','accepted','failed','needs_action','cancelled')),
 idempotency_key TEXT NOT NULL UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,
 schedule_run_id TEXT,schedule_version INTEGER,
 attachment_count INTEGER NOT NULL DEFAULT 0,linked_count INTEGER NOT NULL DEFAULT 0,
 provider_message_id TEXT,provider_status INTEGER,failure_reason TEXT,
 lease_token TEXT,lease_expires_at TEXT,dispatched_at TEXT,next_attempt_at TEXT,
 first_attempt_at TEXT,accepted_at TEXT,delivered_at TEXT,created_at TEXT NOT NULL,finished_at TEXT,expires_at TEXT NOT NULL,
 delivery_status TEXT CHECK(delivery_status IN ('accepted','delayed','delivered','bounced','failed','complained')),
 delivery_status_at TEXT,receipt_received_at TEXT,receipt_provider_message_id TEXT,
 UNIQUE(user_id,report_key,provider,recipient)
);
INSERT INTO email_deliveries_next SELECT * FROM email_deliveries;
DROP TABLE email_deliveries;
ALTER TABLE email_deliveries_next RENAME TO email_deliveries;
CREATE INDEX email_delivery_recovery ON email_deliveries(state,next_attempt_at,lease_expires_at);
CREATE INDEX email_delivery_owner ON email_deliveries(user_id,created_at);
CREATE UNIQUE INDEX email_delivery_one_scheduled_run ON email_deliveries(schedule_run_id) WHERE schedule_run_id IS NOT NULL;
CREATE TABLE email_receipt_events(
 provider TEXT NOT NULL CHECK(provider IN ('resend','sendgrid')),
 event_id_hash TEXT NOT NULL,
 delivery_id TEXT NOT NULL REFERENCES email_deliveries(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('accepted','delayed','delivered','bounced','failed','complained')),
 occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,
 content_hash TEXT NOT NULL,ingestion_id TEXT NOT NULL,
 PRIMARY KEY(provider,event_id_hash)
);
CREATE INDEX email_receipt_delivery ON email_receipt_events(delivery_id,occurred_at);
CREATE INDEX email_receipt_message ON email_deliveries(provider,provider_message_id);
INSERT INTO email_receipt_events SELECT * FROM email_receipts_saved;
UPDATE weekly_schedule_runs SET email_delivery_id=(SELECT email_delivery_id FROM email_schedule_links_saved WHERE email_schedule_links_saved.id=weekly_schedule_runs.id) WHERE id IN (SELECT id FROM email_schedule_links_saved);
DROP TABLE email_receipts_saved;
DROP TABLE email_schedule_links_saved;
CREATE TRIGGER workspace_revision_email_insert AFTER INSERT ON email_deliveries BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_email_update AFTER UPDATE ON email_deliveries BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER workspace_revision_email_delete AFTER DELETE ON email_deliveries BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
CREATE TRIGGER workspace_artifact_guard_email_insert BEFORE INSERT ON email_deliveries WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.payload_key OR object_key=NEW.report_key OR object_key IN (SELECT value FROM json_each(NEW.source_artifacts))) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
CREATE TRIGGER workspace_artifact_guard_email_update BEFORE UPDATE ON email_deliveries WHEN EXISTS(SELECT 1 FROM workspace_artifact_tombstones WHERE object_key=NEW.payload_key OR object_key=NEW.report_key OR object_key IN (SELECT value FROM json_each(NEW.source_artifacts))) BEGIN SELECT RAISE(ABORT,'Artifact was retired; generate a fresh immutable artifact.'); END;
-- Delivery bindings never rotate after an uncertain external request.
CREATE TRIGGER email_delivery_binding_immutable BEFORE UPDATE ON email_deliveries WHEN NEW.user_id<>OLD.user_id OR NEW.report_id<>OLD.report_id OR NEW.report_key<>OLD.report_key OR NEW.provider<>OLD.provider OR NEW.recipient<>OLD.recipient OR NEW.sender<>OLD.sender OR NEW.subject<>OLD.subject OR NEW.payload_key<>OLD.payload_key OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.source_artifacts<>OLD.source_artifacts OR NEW.source_snapshot<>OLD.source_snapshot OR NEW.schedule_run_id IS NOT OLD.schedule_run_id OR NEW.schedule_version IS NOT OLD.schedule_version OR (OLD.payload_hash IS NOT NULL AND NEW.payload_hash IS NOT OLD.payload_hash) BEGIN SELECT RAISE(ABORT,'Email delivery bindings are immutable.'); END;
-- A new historical event invalidates an exact deletion preview even when it
-- cannot replace a newer visible delivery outcome.
CREATE TRIGGER workspace_revision_email_receipt_insert AFTER INSERT ON email_receipt_events BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM email_deliveries WHERE id=NEW.delivery_id); END;
CREATE TRIGGER email_receipt_immutable BEFORE UPDATE ON email_receipt_events BEGIN SELECT RAISE(ABORT,'Verified email receipt evidence is immutable.'); END;
-- The atomic table swap changes no owner content. Preserve counters affected
-- only by SQLite's DROP/cascade bookkeeping, before any concurrent query runs.
UPDATE workspace_revisions SET revision=(SELECT revision FROM email_workspace_revisions_saved WHERE email_workspace_revisions_saved.user_id=workspace_revisions.user_id) WHERE user_id IN (SELECT user_id FROM email_workspace_revisions_saved);
DROP TABLE email_workspace_revisions_saved;
PRAGMA defer_foreign_keys=OFF;
-- Shared across weekly and hiring sends; uncertain attempts are never refunded.
CREATE TABLE gmail_daily_usage(day TEXT PRIMARY KEY,attempts INTEGER NOT NULL CHECK(attempts>=0));
