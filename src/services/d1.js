/**
 * Cloudflare D1 — Agent State Store
 *
 * This is a SEPARATE, free Cloudflare D1 database used only for:
 *   - conversations (state machine, pause flag, in-progress order fields)
 *   - orders (finalized orders collected by the AI)
 *
 * Your product catalog lives in TiDB Cloud (see db/tidb.js) and is never
 * touched by this file. Keeping them separate means the AI agent can never
 * accidentally corrupt your live storefront data.
 */

import { decorateSla, clusterQueries, percentile } from '../utils/queryCluster.js';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DATABASE_ID = process.env.CLOUDFLARE_DATABASE_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

async function executeQuery(sql, params = []) {
  const response = await fetch(D1_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sql,
      params
    })
  });

  const data = await response.json();
  
  if (!response.ok || data.success === false) {
    throw new Error(`D1 Query Error: ${JSON.stringify(data.errors || data)}`);
  }

  return data.result[0];
}

function errText(err) {
  return String(err?.message || err || '');
}

/** SQLite vs D1 wording: "no such column" vs "no column named" */
function isMissingColumn(err) {
  const m = errText(err).toLowerCase();
  return m.includes('no such column') || m.includes('no column named');
}

async function tryAddColumn(table, column, type) {
  try {
    await executeQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`✅ D1 added ${table}.${column}`);
  } catch (err) {
    const m = errText(err).toLowerCase();
    if (m.includes('duplicate column') || m.includes('already exists')) return;
    console.warn(`⚠️ D1 ${table}.${column}: ${err.message}`);
  }
}

async function ensureAgentSchema() {
  await executeQuery(`
    CREATE TABLE IF NOT EXISTS unanswered_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT NOT NULL,
      customer_message TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await tryAddColumn('unanswered_queries', 'bot_draft', 'TEXT');
  await tryAddColumn('unanswered_queries', 'screenshot_url', 'TEXT');
  await tryAddColumn('unanswered_queries', 'reason', 'TEXT');
  await tryAddColumn('unanswered_queries', 'retrieved_ids', 'TEXT');
  await tryAddColumn('unanswered_queries', 'screenshot_match', 'TEXT');
  await tryAddColumn('unanswered_queries', 'cluster_id', 'TEXT');
  await tryAddColumn('orders', 'delivery_charge', 'REAL');
  await tryAddColumn('orders', 'delivery_zone', 'TEXT');
  await tryAddColumn('orders', 'advance_amount', 'REAL');
  await tryAddColumn('orders', 'total_amount', 'REAL');
  await tryAddColumn('orders', 'webhook_mid', 'TEXT');
  await executeQuery(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT,
      reply_ms INTEGER,
      screenshot_match TEXT,
      retrieved_ids TEXT,
      handoff INTEGER DEFAULT 0,
      order_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await executeQuery(`
    CREATE TABLE IF NOT EXISTS processed_mids (
      id TEXT PRIMARY KEY,
      sender_id TEXT,
      created_at INTEGER
    )
  `);
}

const DEFAULT_STATE = {
  state: 'GREETING',
  paused_by_ai: 0,
  paused_reason: null,
  message_history: '[]',
  pending_product_name: null,
  pending_product_price: null,
  pending_variant: null,
  order_name: null,
  order_address: null,
};

let settingsCache = {};
let tableChecked = false;

async function ensureSettingsTable() {
  if (tableChecked) return;
  await executeQuery(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  tableChecked = true;
}

// Preload all settings on application startup to avoid any HTTP database requests for settings during message handling
export async function preloadSettings() {
  try {
    await ensureSettingsTable();
    try {
      await ensureAgentSchema();
    } catch (schemaErr) {
      console.warn('⚠️ D1 schema ensure failed:', schemaErr.message);
    }
    const result = await executeQuery('SELECT key, value FROM settings');
    const rows = result?.results || [];
    for (const row of rows) {
      settingsCache[row.key] = row.value;
    }
    console.log('✅ Settings preloaded from D1:', Object.keys(settingsCache));
  } catch (err) {
    console.error('⚠️ Failed to preload settings from D1:', err);
  }
}

// Fire off preloading in background immediately on import
preloadSettings().catch(() => {});

export async function getSettingCached(key, defaultValue) {
  if (settingsCache[key] !== undefined) {
    return settingsCache[key];
  }
  await ensureSettingsTable();
  const result = await executeQuery('SELECT value FROM settings WHERE key = ? LIMIT 1', [key]);
  const rows = result?.results || [];
  if (rows.length > 0) {
    settingsCache[key] = rows[0].value;
    return rows[0].value;
  }
  const envVal = process.env[key];
  const finalVal = envVal !== undefined ? envVal : defaultValue;
  settingsCache[key] = finalVal;
  return finalVal;
}

export async function setSettingCached(key, value) {
  await ensureSettingsTable();
  await executeQuery(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    [key, value, value]
  );
  settingsCache[key] = value;
}

export async function getOrCreateConversation(senderId) {
  const result = await executeQuery(
    'SELECT * FROM conversations WHERE sender_id = ? LIMIT 1',
    [senderId]
  );

  const rows = result?.results || [];
  if (rows.length > 0) {
    const row = rows[0];
    // Convert SQLite boolean (0/1) to JS boolean
    row.paused_by_ai = row.paused_by_ai === 1;
    // Parse JSON fields
    row.message_history = JSON.parse(row.message_history || '[]');
    return row;
  }

  // Create new conversation
  await executeQuery(
    `INSERT INTO conversations (sender_id, state, paused_by_ai, paused_reason, message_history, 
     pending_product_name, pending_product_price, pending_variant, order_name, order_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      senderId,
      DEFAULT_STATE.state,
      DEFAULT_STATE.paused_by_ai,
      DEFAULT_STATE.paused_reason,
      DEFAULT_STATE.message_history,
      DEFAULT_STATE.pending_product_name,
      DEFAULT_STATE.pending_product_price,
      DEFAULT_STATE.pending_variant,
      DEFAULT_STATE.order_name,
      DEFAULT_STATE.order_address
    ]
  );

  return getOrCreateConversation(senderId);
}

export async function updateConversation(senderId, patch) {
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'message_history' || key === 'updated_at') {
      fields.push(`${key} = ?`);
      values.push(typeof value === 'object' ? JSON.stringify(value) : value);
    } else if (key === 'paused_by_ai') {
      fields.push(`${key} = ?`);
      values.push(value ? 1 : 0);
    } else {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return;

  values.push(senderId);
  await executeQuery(
    `UPDATE conversations SET ${fields.join(', ')} WHERE sender_id = ?`,
    values
  );
}

export async function saveOrder({ sender_id, name, address, phone, product_name, product_price, variant, payment_method, sender_number, transaction_id, claimed_amount, screenshot_url, delivery_charge, delivery_zone, advance_amount, total_amount, webhook_mid }) {
  // Server never auto-confirms money. New rows are unpaid until a moderator verifies.
  const status = (payment_method || sender_number || transaction_id || screenshot_url) ? 'pending_verification' : 'pending_payment';
  if (status === 'paid') {
    throw new Error('Orders cannot be created as paid');
  }

  const params = [
    sender_id, name, address, phone, product_name, product_price, variant, status,
    payment_method || null, sender_number || null, transaction_id || null, claimed_amount || null, screenshot_url || null,
    delivery_charge ?? null, delivery_zone || null, advance_amount ?? null, total_amount ?? null, webhook_mid || null,
  ];

  try {
    const result = await executeQuery(
      `INSERT INTO orders (sender_id, customer_name, customer_address, customer_phone,
       product_name, product_price, variant, status, payment_method, sender_number, transaction_id, claimed_amount, screenshot_url,
       delivery_charge, delivery_zone, advance_amount, total_amount, webhook_mid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
    return { id: result.meta.last_row_id };
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
    const result = await executeQuery(
      `INSERT INTO orders (sender_id, customer_name, customer_address, customer_phone,
       product_name, product_price, variant, status, payment_method, sender_number, transaction_id, claimed_amount, screenshot_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params.slice(0, 13)
    );
    return { id: result.meta.last_row_id };
  }
}

export async function findRecentDuplicateOrder(senderId, productName) {
  const result = await executeQuery(
    `SELECT * FROM orders
     WHERE sender_id = ? AND product_name = ?
       AND status IN ('pending_payment', 'pending_verification')
     ORDER BY id DESC LIMIT 5`,
    [senderId, productName]
  );
  return result?.results || [];
}

export async function getConversations(limit = 50) {
  const result = await executeQuery(
    'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?',
    [limit]
  );

  const rows = result?.results || [];
  return rows.map(row => ({
    ...row,
    paused_by_ai: row.paused_by_ai === 1,
    message_history: JSON.parse(row.message_history || '[]')
  }));
}

export async function getOrders(limit = 100) {
  const result = await executeQuery(
    'SELECT * FROM orders ORDER BY created_at DESC LIMIT ?',
    [limit]
  );

  return result?.results || [];
}

export async function updateOrderStatus(id, status) {
  await executeQuery(
    'UPDATE orders SET status = ? WHERE id = ?',
    [status, id]
  );
}

export async function getOrdersBySenderId(senderId, limit = 5) {
  const result = await executeQuery(
    'SELECT * FROM orders WHERE sender_id = ? ORDER BY id DESC LIMIT ?',
    [senderId, limit]
  );
  return result?.results || [];
}

/**
 * Cross-instance webhook dedupe. Returns false if this id was already claimed
 * (same Messenger mid, or a burst key still inside ttlMs).
 */
export async function claimMessageId(id, senderId, ttlMs = 0) {
  if (!id) return true;
  const now = Date.now();
  try {
    await executeQuery(
      'INSERT INTO processed_mids (id, sender_id, created_at) VALUES (?, ?, ?)',
      [id, senderId, now]
    );
    return true;
  } catch (err) {
    const m = errText(err).toLowerCase();
    if (!m.includes('unique') && !m.includes('constraint')) {
      console.warn('claimMessageId:', err.message);
      return true;
    }
    if (!ttlMs) return false;
    try {
      const row = await executeQuery('SELECT created_at FROM processed_mids WHERE id = ? LIMIT 1', [id]);
      const ts = Number(row?.results?.[0]?.created_at || 0);
      if (ts && now - ts < ttlMs) return false;
      await executeQuery('UPDATE processed_mids SET created_at = ? WHERE id = ?', [now, id]);
      return true;
    } catch (inner) {
      console.warn('claimMessageId ttl:', inner.message);
      return false;
    }
  }
}

// ── Training Examples (Human-in-the-Loop) ────────────────────────────────────

export async function saveTrainingExample({ customerMessage, wrongBotReply, correctReply, context }) {
  await executeQuery(
    `INSERT INTO training_examples (customer_message, wrong_bot_reply, correct_reply, context, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [customerMessage, wrongBotReply || null, correctReply, context || null]
  );
}

export async function getTrainingExamples(limit = 50) {
  const result = await executeQuery(
    'SELECT * FROM training_examples ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
  return result?.results || [];
}

/**
 * Get the most relevant training examples for the current message.
 * Simple keyword overlap approach — no vector DB needed.
 */
export async function getRelevantTrainingExamples(messageText, limit = 8) {
  // Fetch recent corrections and use them all (for now — simple and effective)
  const result = await executeQuery(
    'SELECT customer_message, correct_reply FROM training_examples ORDER BY created_at DESC LIMIT ?',
    [Math.min(limit * 3, 30)]
  );
  const all = result?.results || [];

  if (!messageText || all.length === 0) return all.slice(0, limit);

  // Score by word overlap
  const msgWords = new Set(messageText.toLowerCase().split(/\s+/));
  const scored = all.map(ex => {
    const exWords = ex.customer_message.toLowerCase().split(/\s+/);
    const overlap = exWords.filter(w => msgWords.has(w)).length;
    return { ...ex, score: overlap };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function deleteTrainingExample(id) {
  await executeQuery('DELETE FROM training_examples WHERE id = ?', [id]);
}

// ── Knowledge Base CRUD ──────────────────────────────────────────────────────

export async function getActiveKnowledgeBase() {
  const result = await executeQuery(
    'SELECT category, title, content FROM knowledge_base WHERE is_active = 1 ORDER BY priority DESC, id ASC'
  );
  return result?.results || [];
}

export async function getKnowledgeEntries(limit = 100) {
  const result = await executeQuery(
    'SELECT * FROM knowledge_base ORDER BY priority DESC, created_at DESC LIMIT ?',
    [limit]
  );
  return result?.results || [];
}

export async function saveKnowledgeEntry({ category, title, content, is_active = 1, priority = 0 }) {
  await executeQuery(
    `INSERT INTO knowledge_base (category, title, content, is_active, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [category, title, content, is_active ? 1 : 0, Number(priority)]
  );
}

export async function updateKnowledgeEntry(id, { category, title, content, is_active, priority }) {
  const fields = [];
  const values = [];

  if (category !== undefined) { fields.push('category = ?'); values.push(category); }
  if (title !== undefined) { fields.push('title = ?'); values.push(title); }
  if (content !== undefined) { fields.push('content = ?'); values.push(content); }
  if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active ? 1 : 0); }
  if (priority !== undefined) { fields.push('priority = ?'); values.push(Number(priority)); }

  if (fields.length === 0) return;

  fields.push("updated_at = datetime('now')");
  values.push(id);

  await executeQuery(
    `UPDATE knowledge_base SET ${fields.join(', ')} WHERE id = ?`,
    values
  );
}

export async function deleteKnowledgeEntry(id) {
  await executeQuery('DELETE FROM knowledge_base WHERE id = ?', [id]);
}

export async function deleteConversation(senderId) {
  await executeQuery('DELETE FROM conversations WHERE sender_id = ?', [senderId]);
}

export async function deleteOrder(id) {
  await executeQuery('DELETE FROM orders WHERE id = ?', [id]);
}

export async function updateTrainingExample(id, { customerMessage, wrongBotReply, correctReply }) {
  await executeQuery(
    `UPDATE training_examples 
     SET customer_message = ?, wrong_bot_reply = ?, correct_reply = ? 
     WHERE id = ?`,
    [customerMessage, wrongBotReply || null, correctReply, id]
  );
}

export async function createManualOrder({ sender_id, customer_name, customer_address, customer_phone, product_name, product_price, variant, status, payment_method, sender_number, transaction_id, claimed_amount, screenshot_url }) {
  if (status === 'paid') {
    throw new Error('Orders cannot be created as paid');
  }
  const safeStatus = status === 'pending_verification' ? 'pending_verification' : 'pending_payment';
  const result = await executeQuery(
    `INSERT INTO orders (sender_id, customer_name, customer_address, customer_phone, 
     product_name, product_price, variant, status, payment_method, sender_number, transaction_id, claimed_amount, screenshot_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [sender_id, customer_name, customer_address, customer_phone, product_name, product_price, variant, safeStatus,
     payment_method || null, sender_number || null, transaction_id || null, claimed_amount || null, screenshot_url || null]
  );
  return { id: result.meta.last_row_id };
}

// ── Payment Verification ─────────────────────────────────────────────────────

export async function updatePaymentVerification(orderId, { verifiedBy } = {}) {
  await executeQuery(
    `UPDATE orders SET status = 'paid', payment_verified_at = datetime('now'), payment_verified_by = ? WHERE id = ?`,
    [verifiedBy || 'admin', orderId]
  );
}

export async function updateOrderPaymentClaim(orderId, { payment_method, sender_number, transaction_id, claimed_amount, screenshot_url }) {
  await executeQuery(
    `UPDATE orders SET status = 'pending_verification',
     payment_method = COALESCE(?, payment_method),
     sender_number = COALESCE(?, sender_number),
     transaction_id = COALESCE(?, transaction_id),
     claimed_amount = COALESCE(?, claimed_amount),
     screenshot_url = COALESCE(?, screenshot_url)
     WHERE id = ?`,
    [payment_method || null, sender_number || null, transaction_id || null, claimed_amount || null, screenshot_url || null, orderId]
  );
}

// ── Products Cache (D1 Information Desk) ────────────────────────────────────

export async function searchD1Products(query, limit = 5) {
  const like = `%${query}%`;
  const result = await executeQuery(
    `SELECT id, name, price, category, image_url AS imageUrl, images, stock_count AS stock, colors, sizes
     FROM products_cache
     WHERE is_deleted = 0 AND (name LIKE ? OR category LIKE ?)
     ORDER BY stock_count DESC
     LIMIT ?`,
    [like, like, Number(limit)]
  );
  return result?.results || [];
}

export async function getD1CatalogSnapshot(limit = 80) {
  const result = await executeQuery(
    `SELECT name, price, category, stock_count AS stock
     FROM products_cache
     WHERE is_deleted = 0
     ORDER BY updated_at DESC
     LIMIT ?`,
    [Number(limit)]
  );
  return result?.results || [];
}

export async function upsertD1Products(products) {
  if (!products || products.length === 0) return;
  for (const p of products) {
    await executeQuery(
      `INSERT INTO products_cache (id, name, price, category, image_url, images, stock_count, colors, sizes, status, is_deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         price = excluded.price,
         category = excluded.category,
         image_url = excluded.image_url,
         images = excluded.images,
         stock_count = excluded.stock_count,
         colors = excluded.colors,
         sizes = excluded.sizes,
         status = excluded.status,
         is_deleted = excluded.is_deleted,
         updated_at = datetime('now')`,
      [
        String(p.id),
        String(p.name),
        Number(p.price || 0),
        p.category || 'Women',
        p.imageUrl || p.image_url || null,
        typeof p.images === 'object' ? JSON.stringify(p.images) : p.images || null,
        Number(p.stock || p.stock_count || 1),
        typeof p.colors === 'object' ? JSON.stringify(p.colors) : p.colors || null,
        typeof p.sizes === 'object' ? JSON.stringify(p.sizes) : p.sizes || null,
        p.status || 'published',
        p.is_deleted ? 1 : 0,
      ]
    );
  }
}

// ── Unanswered Queries (Active Learning Queue) ─────────────────────────────

export async function saveUnansweredQuery({ senderId, customerMessage, botDraft, screenshotUrl, reason, retrievedIds, screenshotMatch }) {
  const params = [
    senderId,
    customerMessage,
    botDraft || null,
    screenshotUrl || null,
    reason || null,
    retrievedIds || null,
    screenshotMatch || null,
  ];
  try {
    await executeQuery(
      `INSERT INTO unanswered_queries (sender_id, customer_message, status, bot_draft, screenshot_url, reason, retrieved_ids, screenshot_match, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, datetime('now'))`,
      params
    );
  } catch (err) {
    if (!isMissingColumn(err)) throw err;
    await executeQuery(
      `INSERT INTO unanswered_queries (sender_id, customer_message, status, created_at)
       VALUES (?, ?, 'pending', datetime('now'))`,
      [senderId, customerMessage]
    );
  }
}

export async function getUnansweredQueries(limit = 80) {
  const result = await executeQuery(
    `SELECT * FROM unanswered_queries WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    [limit]
  );
  return (result?.results || []).map(row => decorateSla(row));
}

export async function persistUnansweredClusters() {
  const pending = await getUnansweredQueries(200);
  const clusters = clusterQueries(pending);
  let labeled = 0;
  for (const cluster of clusters) {
    if (cluster.items.length < 2) continue;
    for (const item of cluster.items) {
      try {
        await executeQuery(
          `UPDATE unanswered_queries SET cluster_id = ? WHERE id = ?`,
          [cluster.id, item.id]
        );
        labeled++;
      } catch (err) {
        if (!isMissingColumn(err)) throw err;
        return { labeled: 0, clusters: clusters.filter(c => c.items.length >= 2).length };
      }
    }
  }
  return { labeled, clusters: clusters.filter(c => c.items.length >= 2).length };
}

export async function getUnansweredClusters() {
  const pending = await getUnansweredQueries(200);
  return clusterQueries(pending)
    .filter(c => c.items.length >= 2)
    .map(c => ({
      id: c.id,
      sample: c.sample,
      count: c.items.length,
      ids: c.ids,
      sla_breached: c.items.filter(i => i.sla_breached).length,
    }));
}

export async function resolveUnansweredQuery(id) {
  await executeQuery(
    `UPDATE unanswered_queries SET status = 'resolved' WHERE id = ?`,
    [id]
  );
}

// ── Admin Dashboard Product Functions (D1) ─────────────────────────────────

export async function getAllProducts({ limit = 30, offset = 0, search = '' } = {}) {
  let whereClause = `WHERE status = 'published' AND is_deleted = 0`;
  const params = [];

  if (search && search.trim()) {
    const like = `%${search.trim()}%`;
    whereClause += ` AND (name LIKE ? OR category LIKE ?)`;
    params.push(like, like);
  }

  // Count total before pagination
  const countResult = await executeQuery(
    `SELECT COUNT(*) AS total FROM products_cache ${whereClause}`,
    params
  );
  const total = countResult?.results?.[0]?.total || 0;

  params.push(Number(limit), Number(offset));

  const result = await executeQuery(
    `SELECT id, name, price, price AS originalPrice, category,
            image_url AS imageUrl, images,
            stock_count AS stock, colors, sizes,
            updated_at AS createdAt
     FROM products_cache
     ${whereClause}
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`,
    params
  );

  return {
    products: result?.results || [],
    total,
    limit,
    offset,
  };
}

export async function getProductStats() {
  const result = await executeQuery(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN stock_count > 0 THEN 1 ELSE 0 END) AS inStock,
       SUM(CASE WHEN stock_count <= 0 THEN 1 ELSE 0 END) AS outOfStock,
       0 AS onSale
     FROM products_cache
     WHERE status = 'published' AND is_deleted = 0`
  );
  return result?.results?.[0] || { total: 0, inStock: 0, outOfStock: 0, onSale: 0 };
}

export async function updateProductImages(productId, imagesArray) {
  const firstImage = imagesArray.length > 0 ? imagesArray[0] : null;
  const jsonStr = JSON.stringify(imagesArray);

  await executeQuery(
    `UPDATE products_cache
     SET images = ?, image_url = ?
     WHERE id = ?`,
    [jsonStr, firstImage, String(productId)]
  );
}

// ── Agent metrics (reply time, screenshot match, handoff, orders) ──────────

let agentEventsReady = false;

async function ensureAgentEventsTable() {
  if (agentEventsReady) return;
  await executeQuery(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id         TEXT,
      reply_ms          INTEGER,
      screenshot_match  TEXT,
      retrieved_ids     TEXT,
      handoff           INTEGER DEFAULT 0,
      order_id          TEXT,
      created_at        TEXT DEFAULT (datetime('now'))
    )
  `);
  agentEventsReady = true;
}

export async function logAgentEvent({ sender_id, reply_ms, screenshot_match, retrieved_ids, handoff, order_id }) {
  try {
    await ensureAgentEventsTable();
    await executeQuery(
      `INSERT INTO agent_events (sender_id, reply_ms, screenshot_match, retrieved_ids, handoff, order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        sender_id || null,
        Number.isFinite(reply_ms) ? Math.round(reply_ms) : null,
        screenshot_match || null,
        retrieved_ids || null,
        handoff ? 1 : 0,
        order_id ? String(order_id) : null,
      ]
    );
  } catch (err) {
    console.warn('agent_events skip:', err.message);
  }
}

export async function getAgentMetrics() {
  try {
    await ensureAgentEventsTable();
    const result = await executeQuery(
      `SELECT reply_ms, screenshot_match, handoff, order_id FROM agent_events ORDER BY id DESC LIMIT 500`
    );
    const rows = result?.results || [];
    const times = rows.map(r => Number(r.reply_ms)).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    const shots = rows.filter(r => r.screenshot_match);
    const high = shots.filter(r => r.screenshot_match === 'HIGH').length;
    const handoffs = rows.filter(r => Number(r.handoff) === 1).length;
    const orders = rows.filter(r => r.order_id).length;
    return {
      sample: rows.length,
      p50_reply_ms: percentile(times, 50),
      p95_reply_ms: percentile(times, 95),
      handoff_count: handoffs,
      handoff_rate: rows.length ? Math.round((handoffs / rows.length) * 100) : 0,
      screenshot_count: shots.length,
      screenshot_high: high,
      screenshot_match_rate: shots.length ? Math.round((high / shots.length) * 100) : 0,
      order_count: orders,
    };
  } catch (err) {
    console.warn('agent metrics skip:', err.message);
    return {
      sample: 0,
      p50_reply_ms: null,
      p95_reply_ms: null,
      handoff_count: 0,
      handoff_rate: 0,
      screenshot_count: 0,
      screenshot_high: 0,
      screenshot_match_rate: 0,
      order_count: 0,
    };
  }
}

