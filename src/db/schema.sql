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
  time_visit    TEXT,                         -- visit time, e.g. '7:08' (time-of-day) or a full timestamp; ordering key (Req 3.1)
  visit_type    TEXT,
  store_group   TEXT,
  store_area    TEXT,
  customer_type TEXT,
  quantity      INTEGER                       -- จำนวนลง
);
CREATE INDEX IF NOT EXISTS idx_history_customer_code ON history_entries (customer_code);

-- Migration: earlier versions typed `time_visit` as TIMESTAMP, which rejects a
-- bare time-of-day value like '7:08' on insert. Relax it to TEXT so raw visit
-- times ingest as-is; chronological ordering is handled in the service layer.
-- Idempotent: only alters when the column is not already TEXT.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'history_entries'
      AND column_name = 'time_visit'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE history_entries
      ALTER COLUMN time_visit TYPE TEXT USING time_visit::text;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS presale_entries (
  id            BIGSERIAL PRIMARY KEY,
  customer_code TEXT,                         -- parsed prefix of CustomerName (Req 5.1)
  customer_name TEXT,
  delivery_date DATE,
  demand        INTEGER,                      -- จำนวน Presale
  -- Optional categorical columns (same names/semantics as history_entries) so
  -- the presale filter dropdowns (DC_Name, StoreName, StoreGroup, Store Area,
  -- CustomerType) can match directly on the presale row when the uploaded
  -- workbook carries them.
  dc_name       TEXT,
  store_name    TEXT,
  store_group   TEXT,
  store_area    TEXT,
  customer_type TEXT
);
CREATE INDEX IF NOT EXISTS idx_presale_customer_code ON presale_entries (customer_code);

-- Migration: earlier versions of presale_entries predate the categorical
-- columns above. Add them when missing so an existing database picks them up
-- without a manual migration step.
ALTER TABLE presale_entries ADD COLUMN IF NOT EXISTS dc_name TEXT;
ALTER TABLE presale_entries ADD COLUMN IF NOT EXISTS store_name TEXT;
ALTER TABLE presale_entries ADD COLUMN IF NOT EXISTS store_group TEXT;
ALTER TABLE presale_entries ADD COLUMN IF NOT EXISTS store_area TEXT;
ALTER TABLE presale_entries ADD COLUMN IF NOT EXISTS customer_type TEXT;

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

-- Live driver-side completion tracking (early/on-time/late feedback per stop,
-- plus an end-of-day summary). A completion snapshots the ETA it was compared
-- against at write time, since the in-memory presale-plan cache it comes from
-- (`presaleRoutes.js`'s getLatestPresalePlan) can be overwritten by any later
-- plan build. UNIQUE(driver_id, customer_code, day) makes "mark complete"
-- idempotent — a double-tap/retry upserts the same row instead of duplicating.
CREATE TABLE IF NOT EXISTS delivery_completions (
  id             BIGSERIAL PRIMARY KEY,
  driver_id      BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  route_id       TEXT NOT NULL,        -- snapshot of the driver's route_id/vehicleId at completion time
  customer_code  TEXT NOT NULL,
  customer_name  TEXT,
  scheduled_eta  TIMESTAMPTZ,          -- snapshot of stop.eta; NULL if the plan had none for this stop
  completed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deviation_min  INTEGER,              -- (completed_at - scheduled_eta) in minutes; NULL if no scheduled_eta
  category       TEXT,                 -- 'early' | 'on_time' | 'late' | NULL (mirrors classifyDeviation)
  day            TEXT NOT NULL,        -- 'YYYY-MM-DD', local day key of completed_at, for end-of-day queries
  UNIQUE (driver_id, customer_code, day)
);
CREATE INDEX IF NOT EXISTS idx_delivery_completions_driver_day ON delivery_completions (driver_id, day);

-- Admin auth (admin portal login). Mirrors the driver auth tables but has no
-- route assignment; an admin authenticates to reach the planner/dashboard.
CREATE TABLE IF NOT EXISTS admins (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL                 -- 'scrypt$<saltHex>$<hashHex>' — never plaintext
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,                -- opaque random bearer token
  admin_id   BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  expires_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id ON admin_sessions (admin_id);
