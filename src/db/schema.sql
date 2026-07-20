-- Schema for the Excel Route Planning feature.
-- Applied by db/pool.js `initSchema()`. Uses CREATE ... IF NOT EXISTS so it is
-- idempotent and safe to run on every boot / in integration-test setup.

CREATE TABLE IF NOT EXISTS shops (
  customer_code    TEXT PRIMARY KEY,
  shop_name        TEXT,
  lat              DOUBLE PRECISION,          -- NULL when unresolved
  lng              DOUBLE PRECISION,          -- NULL when unresolved
  coord_source     TEXT NOT NULL,             -- 'master' | 'longdo' | 'unresolved'
  service_time_min INTEGER,                   -- Session_Duration
  open_time        TEXT,                      -- Working_Time start, e.g. '08:00'
  close_time       TEXT                       -- Working_Time end,   e.g. '17:00'
);

CREATE TABLE IF NOT EXISTS history_entries (
  id            BIGSERIAL PRIMARY KEY,
  customer_code TEXT NOT NULL,
  customer_name TEXT,
  dc_name       TEXT,
  store_name    TEXT,
  invoice_date  DATE,                         -- delivered date (DELIVERY_DATE range filter)
  time_visit    TIMESTAMP,                    -- ordering key (Req 3.1)
  visit_type    TEXT,
  store_group   TEXT,
  store_area    TEXT,
  customer_type TEXT,
  quantity      INTEGER                       -- จำนวนลง
);
CREATE INDEX IF NOT EXISTS idx_history_customer_code ON history_entries (customer_code);

CREATE TABLE IF NOT EXISTS presale_entries (
  id            BIGSERIAL PRIMARY KEY,
  customer_code TEXT,                         -- parsed prefix of CustomerName (Req 5.1)
  customer_name TEXT,
  delivery_date DATE,
  demand        INTEGER                       -- จำนวน Presale
);
CREATE INDEX IF NOT EXISTS idx_presale_customer_code ON presale_entries (customer_code);

-- Driver auth (Requirement 10)
CREATE TABLE IF NOT EXISTS drivers (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                -- 'scrypt$<saltHex>$<hashHex>' — never plaintext
  route_id      TEXT                          -- assigned route reference
);

CREATE TABLE IF NOT EXISTS driver_sessions (
  token      TEXT PRIMARY KEY,                -- opaque random bearer token
  driver_id  BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  expires_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_driver_id ON driver_sessions (driver_id);
