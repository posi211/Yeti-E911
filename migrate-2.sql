-- Run once on an existing install, as the postgres user:
--   sudo -u postgres psql -d e911 -f /opt/e911-yeti/migrate-2.sql
-- Change e911 below if your app's database user has a different name.
ALTER TABLE dids ADD COLUMN IF NOT EXISTS notify_emails text[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS login_log (
  id       bigserial PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  username text,
  role     text,
  success  boolean NOT NULL,
  ip       text
);
CREATE INDEX IF NOT EXISTS login_log_ts_idx ON login_log(ts DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO e911;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO e911;
