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
import { getConversations, getOrders, updateConversation, getSettingCached, setSettingCached, updateOrderStatus, saveTrainingExample, getTrainingExamples, deleteTrainingExample, getKnowledgeEntries, saveKnowledgeEntry, updateKnowledgeEntry, deleteKnowledgeEntry } from '../services/d1.js';

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
