/**
 * Big Bazar AI Agent — Main Application Entry
 * Stack: Node.js + Express + Supabase + Anthropic API
 */
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { webhookRouter } from './routes/webhook.js';
import { adminRouter } from './routes/admin.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
// Capture raw body bytes (needed for Meta's X-Hub-Signature-256 verification)
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(requestLogger);

// Serve static dashboard
app.use('/dashboard', express.static(path.join(__dirname, '../public')));
app.get('/dashbroad', (req, res) => res.redirect('/dashboard'));

app.get('/proxy-image', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).send('Missing url parameter');
    }

    try {
      const parsed = new URL(targetUrl);
      const host = parsed.hostname.toLowerCase();
      const whitelist = [
        'bigbazarbariarhat.com',
        'bigbazarbariarhat.pages.dev',
        'instagram.com',
        'cdninstagram.com',
        'cloudinary.com',
        'supabase.co',
        'images.weserv.nl'
      ];
      const isAllowed = whitelist.some(domain => host === domain || host.endsWith('.' + domain));
      if (!isAllowed) {
        console.warn(`🔒 [Security Alert] Blocked SSRF attempt to non-whitelisted domain: ${host}`);
        return res.status(403).send('Forbidden: Target domain is not whitelisted');
      }
    } catch (e) {
      return res.status(400).send('Invalid url format');
    }

    const imgRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });

    if (!imgRes.ok) {
      return res.status(imgRes.status).send(`Failed to fetch image: ${imgRes.statusText}`);
    }

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h

    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.send(buffer);
  } catch (err) {
    console.error('Proxy image error:', err.message);
    res.status(500).send(err.message);
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/webhook', webhookRouter);   // Facebook webhook
app.use('/admin', adminRouter);        // Human moderator dashboard API

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🛍️  Big Bazar Agent running on port ${PORT}`));

export default app;
