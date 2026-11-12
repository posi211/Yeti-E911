-- Run once on an existing install:   su postgres -c "psql -d e911" < /opt/e911-yeti/migrate-4.sql
ALTER TABLE customers ADD COLUMN IF NOT EXISTS admin_emails text[] NOT NULL DEFAULT '{}';
