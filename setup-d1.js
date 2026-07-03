/**
 * Setup script to create D1 tables
 * Run this once to initialize the database schema
 */

import dotenv from 'dotenv';
dotenv.config();

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DATABASE_ID = process.env.CLOUDFLARE_DATABASE_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  sender_id              TEXT PRIMARY KEY,
  state                  TEXT DEFAULT 'GREETING',
  paused_by_ai           INTEGER DEFAULT 0,
  paused_reason          TEXT,
  message_history        TEXT DEFAULT '[]',
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

CREATE TABLE IF NOT EXISTS training_examples (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_message  TEXT NOT NULL,
  wrong_bot_reply   TEXT,
  correct_reply     TEXT NOT NULL,
  context           TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_training_created ON training_examples (created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

async function executeSQL(sql) {
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    console.log(`Executing: ${statement.substring(0, 50)}...`);
    
    const response = await fetch(D1_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sql: statement
      })
    });

    const data = await response.json();
    
    if (!response.ok || data.success === false) {
      console.error(`Error: ${JSON.stringify(data.errors || data)}`);
      throw new Error('D1 Query Error');
    }
    
    console.log('✓ Success');
  }
}

async function main() {
  if (!ACCOUNT_ID || !DATABASE_ID || !API_TOKEN) {
    console.error('Missing environment variables. Please set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, and CLOUDFLARE_API_TOKEN in .env');
    process.exit(1);
  }

  console.log('Setting up D1 database schema...');
  await executeSQL(SCHEMA);
  console.log('✅ Database schema created successfully!');
}

main().catch(console.error);
