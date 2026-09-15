/**
 * Phase 2 RAG + learning self-checks.
 * Run: node scripts/test-phase-02.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cosineSimilarity, lexicalScore, rankByRelevance } from '../src/services/embeddings.js';

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

delete process.env.GEMINI_API_KEY;

console.log('\n== Phase 2 ranking ==');
assert(cosineSimilarity([1, 0], [1, 0]) > 0.99, 'cosine identical vectors');
assert(cosineSimilarity([1, 0], [0, 1]) < 0.01, 'cosine orthogonal vectors');

const deliveryScore = lexicalScore('ডেলিভারি চার্জ কত', 'ডেলিভারি চার্জ মীরসরাই ফ্রি চট্টগ্রাম ১০০');
const refundScore = lexicalScore('ডেলিভারি চার্জ কত', 'রিফান্ড ৭ দিনের মধ্যে পণ্য ফেরত');
assert(deliveryScore > refundScore, `delivery KB outranks refund (${deliveryScore} > ${refundScore})`);

const ranked = await rankByRelevance('ডেলিভারি চার্জ কত', [
  { id: 'refund', _text: 'রিফান্ড ৭ দিনের মধ্যে পণ্য ফেরত' },
  { id: 'delivery', _text: 'ডেলিভারি চার্জ মীরসরাই ফ্রি চট্টগ্রাম ১০০ সারা বাংলাদেশ ১৫০' },
], 1);
assert(ranked[0]?.id === 'delivery', `top KB chunk is delivery (got ${ranked[0]?.id})`);

console.log('\n== Phase 2 wiring ==');
const handler = read('src/services/messageHandler.js');
const admin = read('src/routes/admin.js');
const html = read('public/index.html');
const prompts = read('src/utils/prompts.js');

assert(handler.includes('retrieveKnowledge') && handler.includes('retrieveTraining'), 'handler uses RAG retrieve not full dump');
assert(!handler.includes('getActiveKnowledgeBase()'), 'handler no longer dumps full KB');
assert((admin.match(/adminRouter.post\('\/resolve-query'/g) || []).length === 1, 'single resolve-query route');
assert(admin.includes('customerMessage') && admin.includes('invalidateRagCache'), 'resolve-query teaches + invalidates RAG cache');
assert(html.includes('শিখিয়ে রাখব') && html.includes('isGlobal: teach'), 'inbox asks before saving global knowledge');
assert(prompts.includes('শুধু এই খণ্ডগুলো ব্যবহার করো'), 'prompt forbids inventing policies outside retrieved chunks');
assert(handler.includes('currentMessage'), 'handoff logs the current customer message');

console.log('\n== Result ==');
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('Phase 2 checks passed');
