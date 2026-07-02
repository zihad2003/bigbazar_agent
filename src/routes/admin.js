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
import { getConversations, getOrders, updateConversation } from '../services/d1.js';

export const adminRouter = Router();

// Simple bearer token guard — replace with proper auth for production
adminRouter.use((req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_SECRET) return res.sendStatus(401);
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
