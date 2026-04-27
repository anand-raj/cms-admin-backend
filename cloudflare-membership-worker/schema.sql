CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL UNIQUE,
  status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  token       TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL,
  approved_at TEXT,
  expires_at  TEXT,   -- ISO timestamp: approved_at + 1 year, NULL until approved
  occupation      TEXT,
  city            TEXT,
  state           TEXT,
  pincode         TEXT,
  phone           TEXT,
  reminders_sent  INTEGER NOT NULL DEFAULT 0  -- 0=none, 1=30-day, 2=7-day, 3=expiry
);

CREATE TABLE IF NOT EXISTS admins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  github_login TEXT    NOT NULL UNIQUE,
  role         TEXT    NOT NULL DEFAULT 'moderator', -- owner | moderator | section_editor
  section      TEXT,            -- state name; required when role = section_editor, NULL otherwise
  added_at     TEXT    NOT NULL
);
-- Migration for existing databases:
-- ALTER TABLE admins ADD COLUMN section TEXT;
