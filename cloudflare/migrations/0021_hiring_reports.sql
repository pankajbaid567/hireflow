-- Private evidence-based hiring reports and separately authorized Gmail delivery.
ALTER TABLE shortlists ADD COLUMN state TEXT NOT NULL DEFAULT 'completed' CHECK(state IN ('queued','running','completed','failed'));
ALTER TABLE shortlists ADD COLUMN input_snapshot TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(input_snapshot));
ALTER TABLE shortlists ADD COLUMN report_data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(report_data));
ALTER TABLE shortlists ADD COLUMN report_html TEXT NOT NULL DEFAULT '';
ALTER TABLE shortlists ADD COLUMN report_hash TEXT;
ALTER TABLE shortlists ADD COLUMN failure_reason TEXT;
ALTER TABLE shortlists ADD COLUMN lease_token TEXT;
ALTER TABLE shortlists ADD COLUMN lease_expires_at TEXT;
ALTER TABLE shortlists ADD COLUMN dispatched_at TEXT;
ALTER TABLE shortlists ADD COLUMN completed_at TEXT;
ALTER TABLE shortlists ADD COLUMN score_attempts INTEGER NOT NULL DEFAULT 0 CHECK(score_attempts BETWEEN 0 AND 3);
CREATE INDEX shortlists_owner_created ON shortlists(user_id,id DESC);
CREATE TRIGGER hiring_report_immutable BEFORE UPDATE OF jd_text,candidates,applicant_count,input_snapshot,report_data,report_html,report_hash ON shortlists WHEN OLD.state='completed' AND OLD.report_hash IS NOT NULL AND (NEW.jd_text<>OLD.jd_text OR NEW.candidates<>OLD.candidates OR NEW.applicant_count<>OLD.applicant_count OR NEW.input_snapshot<>OLD.input_snapshot OR NEW.report_data<>OLD.report_data OR NEW.report_html<>OLD.report_html OR NEW.report_hash IS NOT OLD.report_hash) BEGIN SELECT RAISE(ABORT,'Completed hiring reports are immutable'); END;
CREATE TABLE hiring_email_deliveries (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 shortlist_id INTEGER NOT NULL REFERENCES shortlists(id) ON DELETE CASCADE,
 recipient TEXT NOT NULL, sender TEXT NOT NULL, report_hash TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)), payload_hash TEXT NOT NULL,
 message_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','accepted','failed','needs_action','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1),
 failure_reason TEXT, provider_status INTEGER, provider_message_id TEXT,
 lease_token TEXT, lease_expires_at TEXT, dispatched_at TEXT,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, started_at TEXT, accepted_at TEXT, finished_at TEXT,
 UNIQUE(shortlist_id,recipient,report_hash)
);
CREATE INDEX hiring_email_pending ON hiring_email_deliveries(state,created_at);
CREATE TRIGGER hiring_email_owner_binding BEFORE INSERT ON hiring_email_deliveries WHEN NOT EXISTS(SELECT 1 FROM shortlists WHERE id=NEW.shortlist_id AND user_id=NEW.user_id AND state='completed' AND report_hash=NEW.report_hash) BEGIN SELECT RAISE(ABORT,'Hiring report owner or hash does not match'); END;
CREATE TABLE hiring_email_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 delivery_id TEXT NOT NULL REFERENCES hiring_email_deliveries(id) ON DELETE CASCADE,
 state TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL
);
CREATE TRIGGER hiring_email_initial_event AFTER INSERT ON hiring_email_deliveries BEGIN INSERT INTO hiring_email_events(delivery_id,state,reason,created_at) VALUES(NEW.id,NEW.state,NEW.failure_reason,NEW.created_at); END;
CREATE TRIGGER hiring_email_state_event AFTER UPDATE OF state ON hiring_email_deliveries WHEN OLD.state<>NEW.state BEGIN INSERT INTO hiring_email_events(delivery_id,state,reason,created_at) VALUES(NEW.id,NEW.state,NEW.failure_reason,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER hiring_email_event_immutable BEFORE UPDATE ON hiring_email_events BEGIN SELECT RAISE(ABORT,'Hiring email history is append-only'); END;
CREATE TRIGGER hiring_email_event_revision AFTER INSERT ON hiring_email_events BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=(SELECT user_id FROM hiring_email_deliveries WHERE id=NEW.delivery_id); END;
CREATE TRIGGER hiring_email_binding_immutable BEFORE UPDATE OF user_id,shortlist_id,recipient,sender,report_hash,payload,payload_hash,message_id ON hiring_email_deliveries WHEN NEW.user_id<>OLD.user_id OR NEW.shortlist_id<>OLD.shortlist_id OR NEW.recipient<>OLD.recipient OR NEW.sender<>OLD.sender OR NEW.report_hash<>OLD.report_hash OR NEW.payload<>OLD.payload OR NEW.payload_hash<>OLD.payload_hash OR NEW.message_id<>OLD.message_id BEGIN SELECT RAISE(ABORT,'Hiring email binding is immutable'); END;
CREATE TRIGGER hiring_email_no_deleted_owner BEFORE INSERT ON hiring_email_deliveries WHEN EXISTS(SELECT 1 FROM workspace_deletions WHERE user_id=NEW.user_id AND state IN ('queued','deleting')) BEGIN SELECT RAISE(ABORT,'Workspace deletion is active'); END;
CREATE TRIGGER hiring_email_revision_insert AFTER INSERT ON hiring_email_deliveries BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER hiring_email_revision_update AFTER UPDATE ON hiring_email_deliveries BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=NEW.user_id; END;
CREATE TRIGGER hiring_email_revision_delete AFTER DELETE ON hiring_email_deliveries BEGIN UPDATE workspace_revisions SET revision=revision+1 WHERE user_id=OLD.user_id; END;
