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
  id:            'id',
  name:          'name',              // product title, e.g. "Red Katan Jori Saree"
  price:         'price',             // numeric, in BDT
  category:      'category',          // e.g. "saree", "kurti"
  imageUrl:      'image_url',         // legacy/primary single image URL
  images:        'images',            // JSON array of image URLs (multi-photo gallery)
  description:   'description',       // product description text
  videoUrl:      'video_url',         // video URL (if any)
  originalPrice: 'original_price',    // original price before discount
  stock:         'stock_count',       // integer; 0 = out of stock
  colors:        'available_colors',  // JSON array
  sizes:         'available_sizes',   // JSON array
  badge:         'status',            // status (e.g. published) as fallback for badge
  isSale:        'is_sale',           // TINYINT — sale badge
  isHot:         'is_hot',            // TINYINT — hot/trending badge
  isNew:         'is_new',            // TINYINT — new arrival badge
  isSoldOut:     'is_sold_out',       // TINYINT — sold out flag
  serialNo:      'serial_no',         // display/sort order
  createdAt:     'created_at',
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

  const [rows] = await db.query(
    `SELECT ${COLUMNS.id} AS id, ${COLUMNS.name} AS name, ${COLUMNS.price} AS price,
            ${COLUMNS.category} AS category, ${COLUMNS.imageUrl} AS imageUrl,
            ${COLUMNS.images} AS images,
            ${COLUMNS.stock} AS stock, ${COLUMNS.colors} AS colors, ${COLUMNS.sizes} AS sizes
     FROM ${TABLE}
     WHERE ${COLUMNS.name} LIKE ? OR ${COLUMNS.category} LIKE ?
     ORDER BY ${COLUMNS.stock} DESC
     LIMIT ?`,
    [like, like, Number(limit)]
  );

  return rows;
}

/** Fetch a single product by exact ID (used after AI narrows down a match). */
export async function getProductById(id) {
  const db = getTiDBPool();
  const [rows] = await db.execute(
    `SELECT ${COLUMNS.id} AS id, ${COLUMNS.name} AS name, ${COLUMNS.price} AS price,
            ${COLUMNS.category} AS category, ${COLUMNS.imageUrl} AS imageUrl,
            ${COLUMNS.images} AS images, ${COLUMNS.description} AS description,
            ${COLUMNS.videoUrl} AS videoUrl, ${COLUMNS.originalPrice} AS originalPrice,
            ${COLUMNS.stock} AS stock, ${COLUMNS.colors} AS colors, ${COLUMNS.sizes} AS sizes,
            ${COLUMNS.isSale} AS isSale, ${COLUMNS.isHot} AS isHot, ${COLUMNS.isNew} AS isNew
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
  const [rows] = await db.query(
    `SELECT ${COLUMNS.name} AS name, ${COLUMNS.price} AS price,
            ${COLUMNS.category} AS category, ${COLUMNS.stock} AS stock
     FROM ${TABLE}
     ORDER BY ${COLUMNS.createdAt} DESC
     LIMIT ?`,
    [Number(limit)]
  );
   return rows;
}

/**
 * Fetch all products for the admin dashboard — includes gallery images,
 * description, video, badges, and other fields not needed by the AI agent.
 * Supports pagination and optional text search.
 */
export async function getAllProducts({ limit = 30, offset = 0, search = '' } = {}) {
  const db = getTiDBPool();

  let whereClause = `WHERE ${COLUMNS.badge} = 'published'`;
  const params = [];

  if (search && search.trim()) {
    const like = `%${search.trim()}%`;
    whereClause += ` AND (${COLUMNS.name} LIKE ? OR ${COLUMNS.category} LIKE ?)`;
    params.push(like, like);
  }

  // Count total before pagination
  const [countResult] = await db.query(
    `SELECT COUNT(*) AS total FROM ${TABLE} ${whereClause}`,
    params.length ? [...params] : undefined
  );

  params.push(Number(limit), Number(offset));

  const [rows] = await db.query(
    `SELECT ${COLUMNS.id} AS id, ${COLUMNS.serialNo} AS serialNo,
            ${COLUMNS.name} AS name, ${COLUMNS.price} AS price,
            ${COLUMNS.originalPrice} AS originalPrice,
            ${COLUMNS.category} AS category, ${COLUMNS.description} AS description,
            ${COLUMNS.imageUrl} AS imageUrl, ${COLUMNS.images} AS images,
            ${COLUMNS.videoUrl} AS videoUrl,
            ${COLUMNS.stock} AS stock, ${COLUMNS.colors} AS colors, ${COLUMNS.sizes} AS sizes,
            ${COLUMNS.isSale} AS isSale, ${COLUMNS.isHot} AS isHot,
            ${COLUMNS.isNew} AS isNew, ${COLUMNS.isSoldOut} AS isSoldOut,
            ${COLUMNS.createdAt} AS createdAt
     FROM ${TABLE}
     ${whereClause}
     ORDER BY ${COLUMNS.serialNo} ASC, ${COLUMNS.createdAt} DESC
     LIMIT ? OFFSET ?`,
    params
  );

  return {
    products: rows,
    total: countResult[0]?.total ?? 0,
    limit,
    offset,
  };
}

/**
 * Quick aggregate stats for the dashboard stat cards.
 */
export async function getProductStats() {
  const db = getTiDBPool();
  const [rows] = await db.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN ${COLUMNS.stock} > 0 THEN 1 ELSE 0 END) AS inStock,
       SUM(CASE WHEN ${COLUMNS.stock} = 0 OR ${COLUMNS.isSoldOut} = 1 THEN 1 ELSE 0 END) AS outOfStock,
       SUM(CASE WHEN ${COLUMNS.isSale} = 1 THEN 1 ELSE 0 END) AS onSale
     FROM ${TABLE}
     WHERE ${COLUMNS.badge} = 'published'`
  );
  return rows[0] ?? { total: 0, inStock: 0, outOfStock: 0, onSale: 0 };
}
