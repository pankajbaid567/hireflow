-- The latest owner request sample must not sort/scan unrelated cycle/provider
-- history before its 1000-row cap. Keep the owner boundary as the leading key.
CREATE INDEX operation_events_owner_request_time
 ON operation_events(user_id,operation,created_at DESC);
