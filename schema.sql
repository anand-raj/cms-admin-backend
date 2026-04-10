-- Consolidated CMS database schema
-- Single D1 database for all workers: membership, books, events
--
-- Apply with:
--   NODE_TLS_REJECT_UNAUTHORIZED=0 npx wrangler d1 execute cms --remote --file=../schema.sql

-- ── Admins ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  github_login TEXT    NOT NULL UNIQUE,
  role         TEXT    NOT NULL DEFAULT 'moderator', -- owner | moderator
  added_at     TEXT    NOT NULL
);

-- ── Members ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  email           TEXT    NOT NULL UNIQUE,
  status          TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  token           TEXT    NOT NULL UNIQUE,
  created_at      TEXT    NOT NULL,
  approved_at     TEXT,
  expires_at      TEXT,
  occupation      TEXT,
  city            TEXT,
  state           TEXT,
  pincode         TEXT,
  phone           TEXT,
  reminders_sent  INTEGER NOT NULL DEFAULT 0
);

-- ── Books ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS books (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    UNIQUE NOT NULL,
  title       TEXT    NOT NULL,
  author      TEXT,
  description TEXT,
  price_paise INTEGER NOT NULL,
  in_stock    INTEGER DEFAULT 1
);

-- ── Orders ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  razorpay_order_id   TEXT UNIQUE NOT NULL,
  razorpay_payment_id TEXT,
  book_slug           TEXT NOT NULL,
  book_title          TEXT NOT NULL,
  buyer_name          TEXT NOT NULL,
  buyer_email         TEXT NOT NULL,
  buyer_phone         TEXT,
  shipping_address    TEXT NOT NULL,
  amount_paise        INTEGER NOT NULL,
  status              TEXT DEFAULT 'pending',  -- pending | paid | shipped
  created_at          TEXT NOT NULL,
  paid_at             TEXT
);

-- ── Event Registrations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_registrations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_slug   TEXT    NOT NULL,
  event_title  TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  email        TEXT    NOT NULL,
  phone        TEXT,
  participants INTEGER NOT NULL DEFAULT 1,
  notes        TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending | confirmed | cancelled
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_slug ON event_registrations(event_slug);
CREATE INDEX IF NOT EXISTS idx_event_email ON event_registrations(email);
CREATE INDEX IF NOT EXISTS idx_event_status ON event_registrations(status);
