-- Run once on an existing install:   su postgres -c "psql -d e911" < /opt/e911-yeti/migrate-3.sql
-- Change e911 below if your app's database user has a different name.
CREATE TABLE IF NOT EXISTS call_events (
  id          bigserial PRIMARY KEY,
  call_id     text NOT NULL,
  event_type  text NOT NULL CHECK (event_type IN ('call.initiated','call.answered','call.hangup')),
  ts          timestamptz NOT NULL,
  src_number  text,
  dst_number  text,
  class       text,
  customer_id int,
  UNIQUE (call_id, event_type)
);
CREATE INDEX IF NOT EXISTS call_events_ts_idx ON call_events(ts DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO e911;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO e911;
