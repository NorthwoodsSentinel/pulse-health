-- pulse-health D1 schema

-- ---------- Step 1: subscriptions + push audit ----------

CREATE TABLE IF NOT EXISTS subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL DEFAULT 'rob',
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh_key    TEXT NOT NULL,
  auth_secret   TEXT NOT NULL,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_subs_user_active
  ON subscriptions(user_id, active);

CREATE TABLE IF NOT EXISTS push_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at         INTEGER NOT NULL,
  subscription_id INTEGER,
  title           TEXT,
  body            TEXT,
  status_code     INTEGER,
  error           TEXT,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

CREATE INDEX IF NOT EXISTS idx_push_log_sent ON push_log(sent_at DESC);

-- ---------- Step 2: readings (every breadcrumb) ----------

CREATE TABLE IF NOT EXISTS readings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,            -- 'oura' | 'strava' | 'garmin'
  kind          TEXT NOT NULL,            -- 'daily_sleep' | 'daily_readiness' | etc
  recorded_at   INTEGER NOT NULL,         -- ms epoch — the time the reading REPRESENTS
  received_at   INTEGER NOT NULL,         -- ms epoch — when we ingested it
  payload       TEXT NOT NULL,            -- raw JSON from the source
  UNIQUE (source, kind, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_readings_source_kind_recorded
  ON readings(source, kind, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_readings_source_received
  ON readings(source, received_at DESC);

-- ---------- Step 2: oauth tokens per source ----------

CREATE TABLE IF NOT EXISTS tokens (
  source         TEXT PRIMARY KEY,        -- 'oura' | 'strava' | 'garmin'
  access_token   TEXT NOT NULL,
  refresh_token  TEXT,
  expires_at     INTEGER NOT NULL,        -- ms epoch
  scopes         TEXT,
  updated_at     INTEGER NOT NULL
);

-- ---------- Step 2: ingest run log ----------

CREATE TABLE IF NOT EXISTS ingest_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  kinds       TEXT,             -- comma-separated list of kinds ingested
  rows_added  INTEGER DEFAULT 0,
  rows_seen   INTEGER DEFAULT 0,
  status      TEXT NOT NULL,    -- 'success' | 'partial' | 'error'
  error       TEXT,
  trigger     TEXT              -- 'cron' | 'manual' | 'oauth_callback'
);

CREATE INDEX IF NOT EXISTS idx_ingest_log_source_started
  ON ingest_log(source, started_at DESC);

-- ---------- Step 2: pending OAuth flows (PKCE verifier storage) ----------

CREATE TABLE IF NOT EXISTS oauth_pending (
  state         TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_pending_created
  ON oauth_pending(created_at);
