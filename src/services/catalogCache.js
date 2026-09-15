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

import { buildSearchBlob, tokenizeQuery, scoreAgainstTokens } from '../utils/searchNormalize.js';
import { getAllProducts as getD1Products, getProductStats, searchD1Products } from './d1.js';
import { getAllProducts as getTiDBProducts } from '../db/tidb.js';

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
    let products = [];
    let source = 'tidb';
    try {
      const data = await getTiDBProducts({ limit: 2000 });
      products = data.products || [];
    } catch (tidbErr) {
      console.warn(`[CatalogCache] TiDB refresh failed (${tidbErr.message}). Falling back to D1 cache.`);
      source = 'd1';
      const data = await getD1Products({ limit: 2000 });
      products = data.products || [];
    }

    const newMap = new Map();
    for (const p of products) {
      p._searchBlob = buildSearchBlob(p);
      newMap.set(String(p.id), p);
    }

    catalog = products;
    catalogMap = newMap;
    lastRefreshedAt = new Date().toISOString();
    initialLoadDone = true;

    console.log(`[CatalogCache] refreshed ${products.length} products from ${source} at ${lastRefreshedAt}`);
  } catch (err) {
    console.error(`[CatalogCache] refresh failed — serving stale data. Error: ${err.message}`);
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
 * Token overlap search against the in-memory catalog.
 * Falls back to live D1 if the cache hasn't completed its first load yet.
 */
export async function searchCachedCatalog(query, limit = 5) {
  if (!initialLoadDone) {
    const tokens = tokenizeQuery(query);
    const fallbackQuery = tokens[0] || query;
    console.log('[CatalogCache] Initial load pending — falling back to live D1 search');
    return searchD1Products(fallbackQuery, limit);
  }

  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const scored = [];
  for (const p of catalog) {
    const score = scoreAgainstTokens(p._searchBlob, tokens);
    if (score > 0) scored.push({ product: p, score });
  }

  scored.sort((a, b) => b.score - a.score || (b.product.stock || 0) - (a.product.stock || 0));

  return scored.slice(0, limit).map(({ product, score }) => {
    product._score = score;
    return product;
  });
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

export async function triggerRefresh() {
  await refreshCatalog();
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
