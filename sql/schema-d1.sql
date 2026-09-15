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
  order_phone             TEXT,

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
  payment_method    TEXT,
  sender_number     TEXT,
  transaction_id    TEXT,
  claimed_amount    REAL,
  screenshot_url    TEXT,
  payment_verified_at TEXT,
  payment_verified_by TEXT,
  delivery_charge   REAL,
  delivery_zone     TEXT,
  advance_amount    REAL,
  total_amount      REAL,
  webhook_mid       TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);

-- Local Products Cache (Information Desk) — eliminates live TiDB calls during chats
CREATE TABLE IF NOT EXISTS products_cache (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  price             REAL NOT NULL,
  category          TEXT,
  image_url         TEXT,
  images            TEXT,
  stock_count       INTEGER DEFAULT 1,
  colors            TEXT,
  sizes             TEXT,
  status            TEXT DEFAULT 'published',
  is_deleted        INTEGER DEFAULT 0,
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_cache_category ON products_cache (category);
CREATE INDEX IF NOT EXISTS idx_products_cache_deleted ON products_cache (is_deleted);

-- Unanswered Queries — triggered when AI falls back to "একটু অপেক্ষা করুন"
CREATE TABLE IF NOT EXISTS unanswered_queries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id         TEXT NOT NULL,
  customer_message  TEXT NOT NULL,
  status            TEXT DEFAULT 'pending', -- pending | resolved
  bot_draft         TEXT,
  screenshot_url    TEXT,
  reason            TEXT,
  retrieved_ids     TEXT,
  screenshot_match  TEXT,
  cluster_id        TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_unanswered_status ON unanswered_queries (status);
CREATE INDEX IF NOT EXISTS idx_unanswered_cluster ON unanswered_queries (cluster_id);

CREATE TABLE IF NOT EXISTS training_examples (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_message  TEXT NOT NULL,
  wrong_bot_reply   TEXT,
  correct_reply     TEXT NOT NULL,
  context           TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_base (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  category   TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  is_active  INTEGER DEFAULT 1,
  priority   INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id         TEXT,
  reply_ms          INTEGER,
  screenshot_match  TEXT,
  retrieved_ids     TEXT,
  handoff           INTEGER DEFAULT 0,
  order_id          TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events (created_at DESC);

