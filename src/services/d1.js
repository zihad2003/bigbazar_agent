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

export async function saveOrder({ sender_id, name, address, phone, product_name, product_price, variant }) {
  const result = await executeQuery(
    `INSERT INTO orders (sender_id, customer_name, customer_address, customer_phone, 
     product_name, product_price, variant, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sender_id, name, address, phone, product_name, product_price, variant, 'pending_payment']
  );

  return { id: result.meta.last_row_id };
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

export async function createManualOrder({ sender_id, customer_name, customer_address, customer_phone, product_name, product_price, variant, status }) {
  const result = await executeQuery(
    `INSERT INTO orders (sender_id, customer_name, customer_address, customer_phone, 
     product_name, product_price, variant, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [sender_id, customer_name, customer_address, customer_phone, product_name, product_price, variant, status || 'pending_payment']
  );
  return { id: result.meta.last_row_id };
}
