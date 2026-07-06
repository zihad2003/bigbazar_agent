/**
 * Facebook Messenger Webhook Handler
 *
 * Two responsibilities:
 *   GET  /webhook  →  Verification challenge (Meta calls this once during setup)
 *   POST /webhook  →  Incoming messages / events
 */

import { Router } from 'express';
import { verifyWebhookSignature } from '../middleware/verifySignature.js';
import { handleMessage } from '../services/messageHandler.js';

export const webhookRouter = Router();

// ── 1. Webhook verification (Meta setup handshake) ────────────────────────────
webhookRouter.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  console.error('❌ Webhook verification failed');
  return res.sendStatus(403);
});

// ── 2. Incoming events ────────────────────────────────────────────────────────
webhookRouter.post('/', verifyWebhookSignature, async (req, res) => {
  // Always return 200 immediately — Meta will retry if you're slow
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== 'page') return;

  const host = req.get('host');
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      await handleMessage(event, baseUrl).catch(err =>
        console.error('handleMessage error:', err)
      );
    }
  }
});
