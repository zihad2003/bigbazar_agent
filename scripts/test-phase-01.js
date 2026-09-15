/**
 * Phase 0 + Phase 1 self-checks (no live Meta/Gemini required).
 * Run: node scripts/test-phase-01.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  tokenizeQuery,
  buildSearchBlob,
  scoreAgainstTokens,
  getProductImageUrls,
  isGenericProductFollowup,
} from '../src/utils/searchNormalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

console.log('\n== Phase 0 wiring ==');
const gemini = read('src/services/gemini.js');
const admin = read('src/routes/admin.js');
const webhook = read('src/routes/webhook.js');
const handler = read('src/services/messageHandler.js');
const messenger = read('src/services/messenger.js');
const cache = read('src/services/catalogCache.js');

assert(gemini.includes('async function getAIReplyTextOnly'), 'getAIReplyTextOnly exists');
assert(gemini.includes('return getAIReplyTextOnly('), 'vision fallback calls getAIReplyTextOnly');
assert(admin.includes('sendImageMessage'), 'admin imports/uses sendImageMessage');
assert(admin.includes('getAllProducts as getTiDBProducts'), 'sync-catalog uses TiDB');
assert(webhook.includes('Promise.allSettled'), 'webhook fans out in parallel');
assert(webhook.includes('MAX_ATTEMPTS'), 'webhook retries after ACK');
assert(handler.includes('rememberMid'), 'mid idempotency');
assert(handler.includes("sendTypingIndicator(senderId, false)"), 'typing_off on handoff/errors');
assert(messenger.includes('Skipping empty send'), 'empty Messenger send skipped');
assert(cache.includes('getAllProducts as getTiDBProducts'), 'catalog cache reads TiDB');

console.log('\n== Phase 1 search ==');
const catalog = [
  { name: 'Red Katan Jori Sadi', category: 'Women', colors: ['red', 'gold'] },
  { name: 'Blue Cotton Kurti', category: 'Women', colors: ['blue'] },
  { name: 'Black 3pis Embroidery', category: 'Women' },
  { name: 'Green Silk Panjabi', category: 'Men' },
];

function rank(query) {
  const tokens = tokenizeQuery(query);
  return catalog
    .map(p => ({ name: p.name, score: scoreAgainstTokens(buildSearchBlob(p), tokens) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

const sadiHits = rank('ei red sadi er dam koto apu');
assert(sadiHits.length > 0 && sadiHits[0].name.includes('Sadi'), `sadi query ranks saree first (${sadiHits[0]?.name || 'none'})`);
assert(!tokenizeQuery('dam koto apu').includes('koto'), 'fillers stripped from tokens');

const threeHits = rank('থ্রিপিস ছবি দাও');
assert(threeHits.length > 0 && threeHits[0].name.includes('3pis'), `threepiece bangla ranks 3pis (${threeHits[0]?.name || 'none'})`);

const kurtiHits = rank('blue kurti');
assert(kurtiHits[0]?.name.includes('Kurti'), 'blue kurti ranks kurti');

assert(isGenericProductFollowup('ছবি'), 'generic followup: ছবি');
assert(!isGenericProductFollowup('red sadi dam koto'), 'product query is not generic');

const urls = getProductImageUrls({
  imageUrl: 'https://cdn.example.com/cover.jpg',
  images: JSON.stringify(['https://cdn.example.com/a.jpg', { url: 'https://cdn.example.com/b.jpg' }]),
});
assert(urls.length === 3 && urls[0].includes('cover'), 'gallery URLs parsed from string JSON + objects');

const visual = read('src/services/visualMatch.js');
const search = read('src/services/productSearch.js');
const prompts = read('src/utils/prompts.js');
assert(visual.includes("imageKind === 'payment'"), 'visual match detects payment screenshots');
assert(visual.includes('rerankVisualMatch'), 'visual rerank wired');
assert(search.includes('return { products') && search.includes('visual'), 'searchProducts returns products+visual');
assert(handler.includes("visual?.kind === 'AMBIGUOUS'"), 'handler clarifies ambiguous screenshots');
assert(handler.includes("visual?.kind === 'NONE'"), 'handler handoff on unmatched product screenshot');
assert(handler.includes("visual?.kind === 'HIGH'"), 'handler grounds HIGH match from DB');
assert(prompts.includes('SCREENSHOT_MATCH'), 'prompt includes screenshot match block');
assert(handler.includes('skipVisual') || handler.includes('isPaymentStage'), 'payment-stage skips product visual match');

console.log('\n== Result ==');
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('Phase 0 + Phase 1 checks passed');
