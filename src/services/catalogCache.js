/**
 * In-Memory Catalog Cache
 *
 * Pulls the full product catalog from TiDB into memory once on startup,
 * then refreshes every 5 minutes (configurable via CATALOG_REFRESH_MS).
 *
 * This eliminates per-message TiDB queries — searches hit the in-memory
 * array instead. TiDB remains the single source of truth; this is just
 * a read-through cache that resets on every server restart.
 */

import { getAllProducts, getProductStats, searchProductsByText } from '../db/tidb.js';

// ── State ────────────────────────────────────────────────────────────────────
let catalog = [];            // Array of product objects
let catalogMap = new Map();  // id → product (for fast lookup)
let lastRefreshedAt = null;
let initialLoadDone = false;
let refreshTimer = null;

const REFRESH_MS = Number(process.env.CATALOG_REFRESH_MS) || 300_000; // 5 min default

// ── Refresh Logic ────────────────────────────────────────────────────────────

async function refreshCatalog() {
  try {
    const data = await getAllProducts({ limit: 2000 });
    const products = data.products || [];

    const newMap = new Map();
    for (const p of products) {
      // Build a lowercased searchable blob for substring matching
      p._searchBlob = `${(p.name || '').toLowerCase()} ${(p.category || '').toLowerCase()}`;
      newMap.set(String(p.id), p);
    }

    catalog = products;
    catalogMap = newMap;
    lastRefreshedAt = new Date().toISOString();
    initialLoadDone = true;

    console.log(`[CatalogCache] refreshed ${products.length} products at ${lastRefreshedAt}`);
  } catch (err) {
    console.error(`[CatalogCache] refresh failed — serving stale data. Error: ${err.message}`);
    // If this was the very first attempt, mark it so cold-start fallback still works
    // but don't clear existing good data
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the full cached product array.
 */
export function getCachedCatalog() {
  return catalog;
}

/**
 * Returns cache health info.
 */
export function getCacheStatus() {
  return {
    productCount: catalog.length,
    lastRefreshedAt,
    initialLoadDone,
  };
}

/**
 * Substring search against the in-memory catalog, mirroring TiDB's
 * `WHERE name LIKE ? OR category LIKE ?` behavior.
 *
 * Falls back to live TiDB if the cache hasn't completed its first load yet.
 */
export async function searchCachedCatalog(query, limit = 5) {
  // Cold-start fallback: if initial load hasn't finished, hit TiDB directly
  if (!initialLoadDone) {
    console.log('[CatalogCache] Initial load pending — falling back to live TiDB search');
    return searchProductsByText(query, limit);
  }

  if (!query || !query.trim()) return [];

  const lower = query.toLowerCase().trim();
  const results = [];

  for (const p of catalog) {
    if (p._searchBlob.includes(lower)) {
      results.push(p);
      if (results.length >= limit) break;
    }
  }

  // Sort: in-stock first (matches TiDB ORDER BY stock DESC)
  results.sort((a, b) => (b.stock || 0) - (a.stock || 0));

  return results;
}

/**
 * Compute stats from in-memory cache (avoids a TiDB round-trip).
 * Falls back to live TiDB if cache isn't ready.
 */
export async function getCachedProductStats() {
  if (!initialLoadDone) {
    return getProductStats();
  }

  let total = 0, inStock = 0, outOfStock = 0, onSale = 0;
  for (const p of catalog) {
    total++;
    if (p.stock > 0) inStock++;
    if (p.stock === 0 || p.isSoldOut) outOfStock++;
    if (p.isSale) onSale++;
  }

  return { total, inStock, outOfStock, onSale };
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

// Fire initial load immediately
refreshCatalog().catch(() => {});

// Set up periodic refresh
refreshTimer = setInterval(() => {
  refreshCatalog().catch(() => {});
}, REFRESH_MS);

// Prevent the timer from keeping the process alive during graceful shutdown
if (refreshTimer.unref) refreshTimer.unref();
