/**
 * Migration: Add payment verification columns to the orders table in D1.
 * Run once: node migrate-payment-fields.js
 */

import dotenv from 'dotenv';
dotenv.config();

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DATABASE_ID = process.env.CLOUDFLARE_DATABASE_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

const MIGRATIONS = [
  'ALTER TABLE orders ADD COLUMN payment_method TEXT',
  'ALTER TABLE orders ADD COLUMN sender_number TEXT',
  'ALTER TABLE orders ADD COLUMN transaction_id TEXT',
  'ALTER TABLE orders ADD COLUMN claimed_amount REAL',
  'ALTER TABLE orders ADD COLUMN screenshot_url TEXT',
  'ALTER TABLE orders ADD COLUMN payment_verified_at TEXT',
  'ALTER TABLE orders ADD COLUMN payment_verified_by TEXT',
];

async function runSQL(sql) {
  const res = await fetch(D1_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });
  const data = await res.json();
  return { ok: res.ok && data.success !== false, data };
}

async function main() {
  if (!ACCOUNT_ID || !DATABASE_ID || !API_TOKEN) {
    console.error('Missing Cloudflare env vars.');
    process.exit(1);
  }

  console.log('Running payment-fields migration on D1...');

  for (const sql of MIGRATIONS) {
    const col = sql.match(/ADD COLUMN (\w+)/)?.[1];
    try {
      const { ok, data } = await runSQL(sql);
      if (ok) {
        console.log(`  ✓ Added column: ${col}`);
      } else {
        const errMsg = JSON.stringify(data.errors || data);
        // "duplicate column" means it already exists — safe to skip
        if (errMsg.includes('duplicate column') || errMsg.includes('already exists')) {
          console.log(`  ⏭ Column "${col}" already exists — skipped`);
        } else {
          console.error(`  ✗ Failed to add "${col}": ${errMsg}`);
        }
      }
    } catch (err) {
      console.error(`  ✗ Error adding "${col}": ${err.message}`);
    }
  }

  console.log('✅ Migration complete.');
}

main().catch(console.error);
