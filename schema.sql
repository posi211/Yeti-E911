-- E911 for the Yeti stack. Run once:  psql -U postgres -c "CREATE DATABASE e911" ; psql -U postgres -d e911 -f schema.sql

CREATE TABLE IF NOT EXISTS customers (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  notify_emails text[] NOT NULL DEFAULT '{}',   -- who gets the 911 email for this customer
  notes         text,
  contact_email text,                           -- required for new customers; gets the NO ELIN alert even if not on the notification list
  admin_emails  text[] NOT NULL DEFAULT '{}',   -- staff-only copies of this customer's alerts (hidden Bcc; never shown to the customer)
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per DID. The ELIN address is what the PSAP sees and what goes in the alert.
CREATE TABLE IF NOT EXISTS dids (
  id            serial PRIMARY KEY,
  customer_id   int NOT NULL REFERENCES customers(id),
  did           text NOT NULL UNIQUE CHECK (did ~ '^[0-9]{10}$'),   -- 10 digits, no leading 1
  facility      text,
  elin_address1 text,                          -- may be empty: number is loaded (so the customer is known) but has no ELIN address yet
  elin_address2 text,
  city          text,
  state         text,
  zip           text,
  notes         text,
  notify_emails text[] NOT NULL DEFAULT '{}',   -- extra 911 alert recipients for just this number (added to the customer's)
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dids_customer_idx ON dids(customer_id);

-- Dialed numbers we capture. Exact match on digits only (so 9115551234 is NOT flagged).
CREATE TABLE IF NOT EXISTS patterns (
  pattern text PRIMARY KEY CHECK (pattern ~ '^[0-9]+$'),
  class   text NOT NULL CHECK (class IN ('real','test')),
  note    text
);
INSERT INTO patterns(pattern,class,note) VALUES
  ('911','real','911'),
  ('1911','real','1+911'),
  ('933','test','933 address verification'),
  ('1933','test','1+933'),
  ('19133','test','as listed in request; confirm intent'),
  ('15555550911','test','lab test number'),
  ('5555550911','test','lab test number')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS emergency_calls (
  id                bigserial PRIMARY KEY,
  call_id           text NOT NULL UNIQUE,        -- SIP Call-ID of the customer leg (orig_call_id)
  class             text NOT NULL CHECK (class IN ('real','test')),
  matched_pattern   text NOT NULL,
  src_number        text,
  dst_in            text,
  dst_routing       text,
  dst_out           text,
  did_id            int REFERENCES dids(id),     -- NULL = caller not in the ELIN list
  customer_id       int REFERENCES customers(id),
  started_at        timestamptz NOT NULL,
  connected_at      timestamptz,
  ended_at          timestamptz,
  duration_s        int,
  disconnect_code   int,
  disconnect_reason text,
  source            text NOT NULL DEFAULT 'live' CHECK (source IN ('live','cdr','both')),
  notified_at       timestamptz,
  notify_status     text,
  raw               jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ec_started_idx  ON emergency_calls(started_at DESC);
CREATE INDEX IF NOT EXISTS ec_customer_idx ON emergency_calls(customer_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ec_class_idx    ON emergency_calls(class, started_at DESC);

CREATE TABLE IF NOT EXISTS users (
  id          serial PRIMARY KEY,
  username    text NOT NULL UNIQUE,
  pass_hash   text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin','customer')),
  customer_id int REFERENCES customers(id),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'admin') OR customer_id IS NOT NULL)
);

-- Every sign-in attempt (shown on the Login Logs page).
CREATE TABLE IF NOT EXISTS login_log (
  id       bigserial PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  username text,
  role     text,
  success  boolean NOT NULL,
  ip       text
);
CREATE INDEX IF NOT EXISTS login_log_ts_idx ON login_log(ts DESC);

-- Call event stream (initiated / answered / hangup), built by the watcher for 911 and test calls.
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

-- Portal settings. admin_emails = staff who get a hidden copy of every alert (never shown to customers).
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
