-- Run once on an existing install:   su postgres -c "psql -d e911" < /opt/e911-yeti/migrate-5.sql
-- Change e911 below if your app's database user has a different name.
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO e911;
