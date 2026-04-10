CREATE TABLE IF NOT EXISTS event_registrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_slug  TEXT    NOT NULL,
  event_title TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  phone       TEXT,
  participants INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | confirmed | cancelled
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_slug  ON event_registrations(event_slug);
CREATE INDEX IF NOT EXISTS idx_email       ON event_registrations(email);
CREATE INDEX IF NOT EXISTS idx_status      ON event_registrations(status);

CREATE TABLE IF NOT EXISTS admins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  github_login TEXT    NOT NULL UNIQUE,
  role         TEXT    NOT NULL DEFAULT 'moderator',
  added_at     TEXT    NOT NULL
);
