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

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/webhook', webhookRouter);   // Facebook webhook
app.use('/admin', adminRouter);        // Human moderator dashboard API

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🛍️  Big Bazar Agent running on port ${PORT}`));

export default app;
