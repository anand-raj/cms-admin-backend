CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL UNIQUE,
  status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  token       TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL,
  approved_at TEXT
);
