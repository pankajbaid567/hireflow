-- Signed provider outcomes are separate from the queue/API-acceptance state.
-- No email body, address, provider error text or tracking IP enters this ledger.
ALTER TABLE email_deliveries ADD COLUMN delivery_status TEXT CHECK(delivery_status IN ('accepted','delayed','delivered','bounced','failed','complained'));
ALTER TABLE email_deliveries ADD COLUMN delivery_status_at TEXT;
ALTER TABLE email_deliveries ADD COLUMN receipt_received_at TEXT;
ALTER TABLE email_deliveries ADD COLUMN receipt_provider_message_id TEXT;
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
-- A new historical event invalidates an exact deletion preview even when it
-- cannot replace a newer visible delivery outcome.
CREATE TRIGGER workspace_revision_email_receipt_insert AFTER INSERT ON email_receipt_events BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM email_deliveries WHERE id=NEW.delivery_id); END;
CREATE TRIGGER email_receipt_immutable BEFORE UPDATE ON email_receipt_events BEGIN SELECT RAISE(ABORT,'Verified email receipt evidence is immutable.'); END;
