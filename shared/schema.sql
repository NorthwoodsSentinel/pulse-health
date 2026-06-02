-- pulse-health D1 schema
-- Step 1: subscriptions only. Readings/tokens/digests/probes land in Step 2+.

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

-- audit: every test/manual push attempt
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
