-- ════════════════════════════════════════════════════════════════════════
-- Big Bazar Agent — Cloudflare D1/SQLite Schema (agent state store, NOT product DB)
-- Run this in your Cloudflare D1 dashboard SQL Editor.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conversations (
  sender_id              TEXT PRIMARY KEY,
  state                  TEXT DEFAULT 'GREETING',
  paused_by_ai           INTEGER DEFAULT 0,
  paused_reason          TEXT,
  message_history        TEXT DEFAULT '[]',

  -- in-progress order fields, cleared after order is saved
  pending_product_name   TEXT,
  pending_product_price  REAL,
  pending_variant         TEXT,
  order_name             TEXT,
  order_address           TEXT,

  last_order_id          TEXT,
  created_at             TEXT DEFAULT (datetime('now')),
  updated_at             TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_paused ON conversations (paused_by_ai);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id         TEXT NOT NULL,
  customer_name     TEXT NOT NULL,
  customer_address  TEXT NOT NULL,
  customer_phone    TEXT NOT NULL,
  product_name      TEXT NOT NULL,
  product_price     REAL NOT NULL,
  variant           TEXT,
  status            TEXT DEFAULT 'pending_payment',
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
