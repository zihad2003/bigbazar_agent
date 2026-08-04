/**
 * Admin API — Human Moderator Dashboard
 *
 * Endpoints:
 *   GET  /admin/conversations          → list active / paused conversations
 *   POST /admin/conversations/:id/pause  → pause AI for a conversation
 *   POST /admin/conversations/:id/resume → re-enable AI
 *   GET  /admin/orders                 → list collected orders
 */

import { Router } from 'express';
import crypto from 'crypto';
import { getConversations, getOrders, updateConversation, getSettingCached, setSettingCached, updateOrderStatus, saveTrainingExample, getTrainingExamples, deleteTrainingExample, getKnowledgeEntries, saveKnowledgeEntry, updateKnowledgeEntry, deleteKnowledgeEntry, deleteConversation, deleteOrder, updateTrainingExample, createManualOrder, getUnansweredQueries, resolveUnansweredQuery, upsertD1Products, updatePaymentVerification, updateProductImages } from '../services/d1.js';
import { getCachedCatalog, getCachedProductStats, getCacheStatus, triggerRefresh } from '../services/catalogCache.js';
import { sendMessage } from '../services/messenger.js';

export const adminRouter = Router();

// Timing-safe bearer token guard to prevent timing attacks
adminRouter.use((req, res, next) => {
  const token = req.headers['x-admin-token'];
  
  if (!token || !process.env.ADMIN_SECRET) {
    return res.sendStatus(401);
  }

  const match = token.length === process.env.ADMIN_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(process.env.ADMIN_SECRET));

  if (!match) return res.sendStatus(401);
  next();
});

// ── Conversations ─────────────────────────────────────────────────────────────
adminRouter.get('/conversations', async (_req, res) => {
  try {
    const data = await getConversations(50);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/conversations/:id/pause', async (req, res) => {
  try {
    await updateConversation(req.params.id, {
      paused_by_ai: true,
      paused_reason: req.body.reason ?? 'manual'
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/conversations/:id/resume', async (req, res) => {
  try {
    await updateConversation(req.params.id, {
      paused_by_ai: false,
      paused_reason: null,
      state: 'GREETING'
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/conversations/:id/reply', async (req, res) => {
  try {
    const { text, imageUrl, unpause } = req.body;
    const senderId = req.params.id;
    if (!text && !imageUrl) {
      return res.status(400).json({ error: 'text or imageUrl is required' });
    }

    if (imageUrl) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      await sendImageMessage(senderId, imageUrl, baseUrl);
    }
    if (text) {
      await sendMessage(senderId, text);
    }

    if (unpause) {
      await updateConversation(senderId, {
        paused_by_ai: false,
        paused_reason: null,
        state: 'GREETING',
      });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.get('/unanswered', async (_req, res) => {
  try {
    const list = await getUnansweredQueries(50);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/resolve-query', async (req, res) => {
  try {
    const { queryId, senderId, replyText, isGlobal, category, title } = req.body;

    if (!senderId || !replyText) {
      return res.status(400).json({ error: 'senderId and replyText are required' });
    }

    // 1. Send reply to customer via Messenger
    await sendMessage(senderId, replyText);

    // 2. Unpause AI for that conversation
    await updateConversation(senderId, {
      paused_by_ai: false,
      paused_reason: null,
      state: 'GREETING',
    });

    // 3. Mark query as resolved in D1
    if (queryId) {
      await resolveUnansweredQuery(queryId);
    }

    // 4. Active Learning: If global knowledge, save into Knowledge Base / Training Examples
    if (isGlobal) {
      await saveKnowledgeEntry({
        category: category || 'general',
        title: title || 'Product & Shop Q&A',
        content: replyText,
        is_active: 1,
        priority: 1,
      });

      console.log(`[Active Learning] Learned new global knowledge: "${title || 'Q&A'}" -> "${replyText}"`);
    }

    res.json({ ok: true, learnedGlobal: !!isGlobal });
  } catch (error) {
    console.error('Resolve query error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Orders ────────────────────────────────────────────────────────────────────
adminRouter.get('/orders', async (_req, res) => {
  try {
    const data = await getOrders(100);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────
adminRouter.get('/settings', async (_req, res) => {
  try {
    const autoReplyEnabled = await getSettingCached('AUTO_REPLY_ENABLED', 'true');
    const testMode = await getSettingCached('TEST_MODE', 'false');
    const testerPsids = await getSettingCached('TESTER_PSIDS', '');
    res.json({
      AUTO_REPLY_ENABLED: autoReplyEnabled,
      TEST_MODE: testMode,
      TESTER_PSIDS: testerPsids
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/settings', async (req, res) => {
  try {
    const { AUTO_REPLY_ENABLED, TEST_MODE, TESTER_PSIDS } = req.body;
    if (AUTO_REPLY_ENABLED !== undefined) {
      await setSettingCached('AUTO_REPLY_ENABLED', String(AUTO_REPLY_ENABLED));
    }
    if (TEST_MODE !== undefined) {
      await setSettingCached('TEST_MODE', String(TEST_MODE));
    }
    if (TESTER_PSIDS !== undefined) {
      await setSettingCached('TESTER_PSIDS', String(TESTER_PSIDS));
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await updateOrderStatus(req.params.id, status);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/orders/:id/verify-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const verifiedBy = req.body.verifiedBy || 'admin';
    await updatePaymentVerification(id, { verifiedBy });
    res.json({ ok: true });
  } catch (error) {
    console.error('Verify payment error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Training Examples (Human-in-the-Loop) ─────────────────────────────────────
adminRouter.get('/training', async (_req, res) => {
  try {
    const data = await getTrainingExamples(100);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/training', async (req, res) => {
  try {
    const { customerMessage, wrongBotReply, correctReply, context } = req.body;
    if (!customerMessage || !correctReply) {
      return res.status(400).json({ error: 'customerMessage and correctReply are required' });
    }
    await saveTrainingExample({ customerMessage, wrongBotReply, correctReply, context });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.delete('/training/:id', async (req, res) => {
  try {
    await deleteTrainingExample(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Knowledge Base ────────────────────────────────────────────────────────────
adminRouter.get('/knowledge', async (_req, res) => {
  try {
    const data = await getKnowledgeEntries(100);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/knowledge', async (req, res) => {
  try {
    const { category, title, content, is_active, priority } = req.body;
    if (!category || !title || !content) {
      return res.status(400).json({ error: 'category, title, and content are required' });
    }
    await saveKnowledgeEntry({ category, title, content, is_active, priority });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.put('/knowledge/:id', async (req, res) => {
  try {
    const { category, title, content, is_active, priority } = req.body;
    await updateKnowledgeEntry(req.params.id, { category, title, content, is_active, priority });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.delete('/knowledge/:id', async (req, res) => {
  try {
    await deleteKnowledgeEntry(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.delete('/conversations/:id', async (req, res) => {
  try {
    await deleteConversation(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/orders', async (req, res) => {
  try {
    const { sender_id, customer_name, customer_address, customer_phone, product_name, product_price, variant, status } = req.body;
    if (!customer_name || !customer_phone || !product_name || !product_price) {
      return res.status(400).json({ error: 'customer_name, customer_phone, product_name, and product_price are required' });
    }
    const result = await createManualOrder({ sender_id, customer_name, customer_address, customer_phone, product_name, product_price, variant, status });
    res.json({ ok: true, id: result.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.delete('/orders/:id', async (req, res) => {
  try {
    await deleteOrder(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.put('/training/:id', async (req, res) => {
  try {
    const { customerMessage, wrongBotReply, correctReply } = req.body;
    if (!customerMessage || !correctReply) {
      return res.status(400).json({ error: 'customerMessage and correctReply are required' });
    }
    await updateTrainingExample(req.params.id, { customerMessage, wrongBotReply, correctReply });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Products (In-Memory Catalog Cache) ───────────────────────────────────────
adminRouter.get('/products', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 24));
    const search = (req.query.search || '').trim().toLowerCase();
    const offset = (page - 1) * limit;

    let products = getCachedCatalog();
    if (search) {
      products = products.filter(p => 
        (p.name || '').toLowerCase().includes(search) || 
        (p.category || '').toLowerCase().includes(search)
      );
    }

    const paginatedProducts = products.slice(offset, offset + limit);

    res.json({
      products: paginatedProducts,
      total: products.length,
      page,
      limit,
      totalPages: Math.ceil(products.length / limit),
    });
  } catch (error) {
    console.error('Products fetch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

adminRouter.get('/products/stats', async (_req, res) => {
  try {
    const stats = await getCachedProductStats();
    res.json(stats);
  } catch (error) {
    console.error('Product stats error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

adminRouter.get('/cache-status', async (_req, res) => {
  try {
    const status = getCacheStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/products', async (req, res) => {
  try {
    const { name, price, category, stock, imageUrl } = req.body;
    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Name and price are required' });
    }
    const product = {
      id: crypto.randomUUID(),
      name,
      price: Number(price),
      category,
      stock_count: Number(stock) || 1,
      image_url: imageUrl,
      images: imageUrl ? [imageUrl] : [],
      status: 'published'
    };
    await upsertD1Products([product]);
    await triggerRefresh();
    res.json({ success: true, product });
  } catch (error) {
    console.error('Add product error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

adminRouter.put('/products/:id/images', async (req, res) => {
  try {
    const { id } = req.params;
    const { images } = req.body;

    if (!Array.isArray(images)) {
      return res.status(400).json({ error: 'images must be an array of URLs' });
    }

    // Basic validation of URLs
    for (const url of images) {
      if (typeof url !== 'string' || !url.trim().startsWith('http')) {
        return res.status(400).json({ error: 'All image elements must be valid HTTP/HTTPS URLs' });
      }
    }

    await updateProductImages(id, images);
    await triggerRefresh();
    res.json({ ok: true, images });
  } catch (error) {
    console.error('Product images update error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Active Moderator Learning & Unanswered Query Queue ─────────────────────

adminRouter.get('/unanswered', async (_req, res) => {
  try {
    const list = await getUnansweredQueries(50);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

adminRouter.post('/resolve-query', async (req, res) => {
  try {
    const { queryId, senderId, replyText, isGlobal, category, title } = req.body;

    if (!senderId || !replyText) {
      return res.status(400).json({ error: 'senderId and replyText are required' });
    }

    // 1. Send reply to customer via Messenger
    await sendMessage(senderId, replyText);

    // 2. Unpause AI for that conversation
    await updateConversation(senderId, {
      paused_by_ai: false,
      paused_reason: null,
      state: 'GREETING',
    });

    // 3. Mark query as resolved in D1
    if (queryId) {
      await resolveUnansweredQuery(queryId);
    }

    // 4. Active Learning: If global knowledge, save into Knowledge Base / Training Examples
    if (isGlobal) {
      await saveKnowledgeEntry({
        category: category || 'general',
        title: title || 'Product & Shop Q&A',
        content: replyText,
        is_active: 1,
        priority: 1,
      });

      console.log(`🧠 [Active Learning] Learned new global knowledge: "${title || 'Q&A'}" -> "${replyText}"`);
    }

    res.json({ ok: true, learnedGlobal: !!isGlobal });
  } catch (error) {
    console.error('Resolve query error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Catalog Sync: TiDB -> D1 Products Cache ────────────────────────────────

adminRouter.post('/sync-catalog', async (_req, res) => {
  try {
    console.log('🔄 [Catalog Sync] Fetching catalog snapshot from TiDB...');
    const result = await getAllProducts({ limit: 1000 });
    const products = result.products || [];

    if (products.length > 0) {
      await upsertD1Products(products);
      console.log(`✅ [Catalog Sync] Successfully synced ${products.length} products to D1 products_cache!`);
    }

    res.json({ ok: true, syncedCount: products.length });
  } catch (error) {
    console.error('Catalog sync error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


