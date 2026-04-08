CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL UNIQUE,
  status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  token       TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL,
  approved_at TEXT,
  expires_at  TEXT    -- ISO timestamp: approved_at + 1 year, NULL until approved
);

CREATE TABLE IF NOT EXISTS admins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  github_login TEXT    NOT NULL UNIQUE,
  role         TEXT    NOT NULL DEFAULT 'moderator', -- owner | moderator
  added_at     TEXT    NOT NULL
);
