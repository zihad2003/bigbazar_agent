/**
 * Phase 4 mod-ops / SLA self-checks (no live Meta/D1 required).
 * Run: node scripts/test-phase-04.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  SLA_MS,
  waitMs,
  isSlaBreach,
  decorateSla,
  clusterQueries,
  percentile,
} from '../src/utils/queryCluster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

console.log('\n== Phase 4 SLA ==');
assert(SLA_MS === 2 * 60 * 1000, '2 minute SLA');
const now = Date.parse('2026-09-15T12:00:00Z');
assert(waitMs('2026-09-15 11:59:30', now) === 30000, '30s wait');
assert(!isSlaBreach('2026-09-15 11:59:00', now), '90s is inside SLA');
assert(isSlaBreach('2026-09-15 11:57:00', now), '3 min is SLA breach');
assert(decorateSla({ created_at: '2026-09-15 11:57:00' }, now).sla_breached, 'decorate flags late tickets');

console.log('\n== Phase 4 clusters ==');
const clustered = clusterQueries([
  { id: 1, customer_message: 'ডেলিভারি চার্জ কত' },
  { id: 2, customer_message: 'delivery charge koto' },
  { id: 3, customer_message: 'রিফান্ড চাই' },
]);
const delivery = clustered.find(c => c.ids.includes(1));
assert(delivery?.ids.includes(2), `delivery questions cluster (got ${JSON.stringify(clustered.map(c => c.ids))})`);
assert(clustered.find(c => c.ids.includes(3))?.ids.length === 1, 'refund stays its own cluster');
assert(percentile([10, 20, 30, 40], 50) === 20, 'p50 of 4 samples');

console.log('\n== Phase 4 wiring ==');
const handler = read('src/services/messageHandler.js');
const d1 = read('src/services/d1.js');
const admin = read('src/routes/admin.js');
const html = read('public/index.html');
const app = read('src/app.js');
const schema = read('sql/schema-d1.sql');
const migrate = read('migrate-payment-fields.js');

assert(handler.includes('logAgentEvent') && handler.includes('reply_ms'), 'handler logs reply_ms');
assert(handler.includes('botDraft') && handler.includes('screenshotUrl'), 'handoff stores draft + screenshot');
assert(d1.includes('bot_draft') && d1.includes('ORDER BY created_at ASC'), 'inbox queue oldest-first with draft');
assert(d1.includes('agent_events') && d1.includes('getAgentMetrics'), 'agent_events metrics table');
assert(admin.includes('/unanswered-clusters') && admin.includes('/metrics'), 'admin cluster + metrics routes');
assert(html.includes('openInboxReply') && html.includes('পাঠাও ও শেখাও'), 'one-click teach inbox modal');
assert(html.includes('inbox-thumb') && html.includes('statSla'), 'SS thumb + SLA stat');
assert(html.includes('inboxClusters') && html.includes('একই ধরনের প্রশ্ন'), 'nightly-style cluster panel');
assert(app.includes('fbcdn.net') && app.includes('persistUnansweredClusters'), 'FB screenshot proxy + nightly cluster');
assert(schema.includes('bot_draft') && schema.includes('agent_events'), 'schema has inbox extras + events');
assert(migrate.includes('ADD COLUMN bot_draft') && migrate.includes('agent_events'), 'migrate adds phase 4 columns');

console.log('\n== Result ==');
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('Phase 4 checks passed');
