/**
 * TiDB Cloud — Product Database Connection
 *
 * Your existing storefront (bigbazar-Products-Price-List) already stores
 * products here. We connect READ-ONLY — this agent never writes to TiDB.
 *
 * ⚠️  CONFIG NOTE: column names below are best-guess defaults based on a
 * typical product catalog schema. Once you run:
 *      SHOW CREATE TABLE products;
 * in the TiDB Cloud SQL console, send me the output and I'll update the
 * COLUMN MAP below in one pass — nothing else in the codebase needs to change.
 */

import mysql from 'mysql2/promise';

// ── COLUMN MAP — edit this block once you confirm real schema ────────────────
const TABLE = 'products';
const COLUMNS = {
  id:        'id',
  name:      'name',          // product title, e.g. "Red Katan Jori Saree"
  price:     'price',         // numeric, in BDT
  category:  'category',      // e.g. "saree", "kurti"
  imageUrl:  'image_url',
  stock:     'stock_quantity',// integer; 0 = out of stock
  colors:    'colors',        // text or JSON array
  sizes:     'sizes',         // text or JSON array
  badge:     'badge',         // e.g. "New", "Best Seller" (from admin panel)
  createdAt: 'created_at',
};
// ───────────────────────────────────────────────────────────────────────────

let pool;

export function getTiDBPool() {
  if (pool) return pool;

  pool = mysql.createPool({
    host: process.env.TIDB_HOST,
    port: Number(process.env.TIDB_PORT || 4000),
    user: process.env.TIDB_USER,
    password: process.env.TIDB_PASSWORD,
    database: process.env.TIDB_DATABASE,
    ssl: {
      // Aiven uses self-signed certificates - allow them for connection
      minVersion: 'TLSv1.2',
      rejectUnauthorized: false,
    },
    waitForConnections: true,
    connectionLimit: 5,       // keep low — serverless tiers throttle connections
    queueLimit: 0,
  });

  return pool;
}

/**
 * Text search across product name/category.
 * Simple LIKE-based search — good enough for a few hundred SKUs.
 * If your catalog grows large, switch to TiDB's native FULLTEXT or a
 * vector embedding column for semantic search.
 */
export async function searchProductsByText(query, limit = 5) {
  const db = getTiDBPool();
  const like = `%${query}%`;

  const [rows] = await db.execute(
    `SELECT ${COLUMNS.id} AS id, ${COLUMNS.name} AS name, ${COLUMNS.price} AS price,
            ${COLUMNS.category} AS category, ${COLUMNS.imageUrl} AS imageUrl,
            ${COLUMNS.stock} AS stock, ${COLUMNS.colors} AS colors, ${COLUMNS.sizes} AS sizes
     FROM ${TABLE}
     WHERE ${COLUMNS.name} LIKE ? OR ${COLUMNS.category} LIKE ?
     ORDER BY ${COLUMNS.stock} DESC
     LIMIT ?`,
    [like, like, limit]
  );

  return rows;
}

/** Fetch a single product by exact ID (used after AI narrows down a match). */
export async function getProductById(id) {
  const db = getTiDBPool();
  const [rows] = await db.execute(
    `SELECT ${COLUMNS.id} AS id, ${COLUMNS.name} AS name, ${COLUMNS.price} AS price,
            ${COLUMNS.category} AS category, ${COLUMNS.imageUrl} AS imageUrl,
            ${COLUMNS.stock} AS stock, ${COLUMNS.colors} AS colors, ${COLUMNS.sizes} AS sizes
     FROM ${TABLE} WHERE ${COLUMNS.id} = ? LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Pull a lightweight catalog snapshot to inject into the AI prompt as
 * context (name + price + stock only — keeps token usage low).
 * Refreshed on every message so prices are always live.
 */
export async function getCatalogSnapshot(limit = 80) {
  const db = getTiDBPool();
  const [rows] = await db.execute(
    `SELECT ${COLUMNS.name} AS name, ${COLUMNS.price} AS price,
            ${COLUMNS.category} AS category, ${COLUMNS.stock} AS stock
     FROM ${TABLE}
     ORDER BY ${COLUMNS.createdAt} DESC
     LIMIT ?`,
    [limit]
  );
  return rows;
}
