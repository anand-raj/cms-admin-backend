-- Run against the existing cms-membership D1 database:
--   npx wrangler d1 execute cms-membership --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS books (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    UNIQUE NOT NULL,
  title       TEXT    NOT NULL,
  author      TEXT,
  description TEXT,
  price_paise         INTEGER NOT NULL,   -- price in paise (₹ × 100), e.g. 49900 = ₹499
  in_stock            INTEGER DEFAULT 1,  -- 1 = in stock, 0 = out of stock
  image_data          TEXT,               -- base64-encoded cover image (≤ 500 KB raw)
  image_content_type  TEXT                -- MIME type, e.g. image/jpeg
);

CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  razorpay_order_id   TEXT UNIQUE NOT NULL,
  razorpay_payment_id TEXT,
  book_slug           TEXT NOT NULL,
  book_title          TEXT NOT NULL,
  buyer_name          TEXT NOT NULL,
  buyer_email         TEXT NOT NULL,
  buyer_phone         TEXT,
  shipping_address    TEXT NOT NULL,  -- JSON: { address, city, state, pincode }
  amount_paise        INTEGER NOT NULL,
  status              TEXT DEFAULT 'pending',  -- pending | paid | shipped
  created_at          TEXT NOT NULL,
  paid_at             TEXT
);

-- To register a book (run once per book after creating it in the CMS):
-- npx wrangler d1 execute cms-membership --remote --command \
--   "INSERT INTO books (slug, title, price_paise, in_stock) VALUES ('my-book-slug', 'My Book Title', 49900, 1);"

-- To mark a book out of stock:
-- npx wrangler d1 execute cms-membership --remote --command \
--   "UPDATE books SET in_stock = 0 WHERE slug = 'my-book-slug';"

-- Migration: add image columns to existing databases (skip if running schema fresh):
-- npx wrangler d1 execute cms-membership --remote --command \
--   "ALTER TABLE books ADD COLUMN image_data TEXT;"
-- npx wrangler d1 execute cms-membership --remote --command \
--   "ALTER TABLE books ADD COLUMN image_content_type TEXT;"

-- To view all orders:
-- npx wrangler d1 execute cms-membership --remote --command \
--   "SELECT id, book_title, buyer_name, buyer_email, status, paid_at FROM orders ORDER BY created_at DESC;"
