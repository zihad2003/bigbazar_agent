/**
 * Verifies the X-Hub-Signature-256 header Meta sends with every webhook
 * POST, proving the request actually came from Facebook and wasn't forged.
 *
 * Requires the raw request body — see app.js for the express.json
 * verify hook that captures it.
 */

import crypto from 'crypto';

export function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.warn('⚠️  Missing signature header — rejecting');
    return res.sendStatus(401);
  }

  const expectedHash = crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(req.rawBody ?? JSON.stringify(req.body))
    .digest('hex');

  const expectedSignature = `sha256=${expectedHash}`;

  const valid =
    signature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));

  if (!valid) {
    console.warn('⚠️  Invalid webhook signature — rejecting');
    return res.sendStatus(401);
  }

  next();
}
