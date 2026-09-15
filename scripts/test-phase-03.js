/**
 * Phase 3 order-safety self-checks (no live Meta/D1 required).
 * Run: node scripts/test-phase-03.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getBkashNumber,
  resolvePhone,
  validateOrderFields,
  calculateDelivery,
  calculateAdvance,
  orderFormReply,
  orderConfirmReply,
  missingFieldsReply,
  isDuplicateOrder,
  DUPLICATE_WINDOW_MS,
  quoteOrderTotal,
  lineTotal,
} from '../src/utils/orderRules.js';
import {
  extractOrderField,
  extractOrderDetails,
  extractPaymentRef,
  extractQuantity,
  extractDeliveryHint,
  isWantThisProduct,
  isPaymentProof,
  isShowMoreRequest,
  isPhotoRequest,
  isBargain,
  isTotalQuestion,
  isDeliveryQuestion,
} from '../src/utils/nlp.js';
import { buildSystemPrompt } from '../src/utils/prompts.js';

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

console.log('\n== Phase 3 phone / fields ==');
assert(extractOrderField('phone', '01712345678') === '01712345678', 'ascii BD mobile');
assert(extractOrderField('phone', '০১৭১২৩৪৫৬৭৮') === '01712345678', 'bangla digits → ascii');
assert(extractOrderField('phone', '01712-345678') === '01712345678', 'dashed mobile');
assert(extractOrderField('phone', '+8801712345678') === '01712345678', 'strips +88');
assert(extractOrderField('phone', '01112345678') === null, 'rejects 011 prefix');
assert(extractOrderField('phone', '01877') === null, 'rejects short number');

assert(resolvePhone('bad', '01711111111', 'hello') === '01711111111', 'phone falls back to conversation');
assert(resolvePhone('', '', 'নাম্বার ০১৮১২৩৪৫৬৭৮') === '01812345678', 'phone from message text');

const missingPhone = validateOrderFields({
  name: 'রহিম',
  address: 'বারইয়ারহাট, মীরসরাই, চট্টগ্রাম',
  phone: '12345',
  productName: 'গাউন',
  productPrice: 1420,
});
assert(!missingPhone.ok && missingPhone.errors.includes('phone'), 'invalid phone blocked');

const missingName = validateOrderFields({
  name: '17',
  address: 'বারইয়ারহাট, মীরসরাই, চট্টগ্রাম',
  phone: '01712345678',
  productName: 'গাউন',
  productPrice: 1420,
});
assert(!missingName.ok && missingName.errors.includes('name'), 'numeric name blocked');

const ok = validateOrderFields({
  name: 'রহিম',
  address: 'বারইয়ারহাট, মীরসরাই, চট্টগ্রাম',
  phone: '01712345678',
  productName: 'গাউন',
  productPrice: 1420,
});
assert(ok.ok && ok.phone === '01712345678', 'valid order fields pass');

const quoted = extractOrderDetails(
  'অর্ডার করতে নাম, মোবাইল আর ঠিকানা একসাথে পাঠায়েন:\nনাম:zihaf\nমো01857045449\nঠিকানা:Bangladesh\nমীরসরাই ফ্রি, চট্টগ্রাম ১০০, দেশে ১৫০ টাকা।'
);
assert(quoted.name === 'zihaf', 'quoted Facebook form name');
assert(quoted.phone === '01857045449', 'quoted Facebook form phone');
assert(quoted.address === 'Bangladesh', 'quoted Facebook form address');

const oneLine = extractOrderDetails('নাম:zihad মো01857045449 ঠিকানা:Bangladesh');
assert(oneLine.name === 'zihad' && oneLine.phone === '01857045449' && oneLine.address === 'Bangladesh', 'one-line filled form');

assert(isWantThisProduct('hea den to'), 'hea den to is buy intent');
assert(isWantThisProduct('kibabe order korbo'), 'kibabe order is buy intent');
assert(!isWantThisProduct('নাম:zihad মো01857045449 ঠিকানা:Bangladesh'), 'filled form is not buy-intent short-circuit');
assert(isPaymentProof('last number dile hobe'), 'last number is payment proof');
assert(extractPaymentRef('Transection id:hjs129ui') === 'hjs129ui', 'transection id extracted');

assert(isShowMoreRequest('hea ar ki ace dekhan'), 'ar ki ace dekhan is show-more');
assert(isPhotoRequest('hea ar ki ace dekhan'), 'show-more counts as photo request');
assert(!isWantThisProduct('hea ar ki ace dekhan'), 'show-more is not buy-this');
assert(isWantThisProduct('hea den to'), 'hea den to still buy-this');
assert(extractQuantity('aita 2 ta lagbe') === 2, '2 ta lagbe');
assert(extractQuantity('3 ta nibo') === 3, '3 ta nibo');
assert(extractQuantity('4000 taka rakhen') === null, 'bargain amount is not qty');
assert(isBargain('4000 taka rakhen'), '4000 taka rakhen is bargain');
assert(isTotalQuestion('tahole total koto'), 'tahole total');
assert(isTotalQuestion('koto asbe total'), 'koto asbe total');
assert(isDeliveryQuestion('sitakunda te koto'), 'sitakunda te koto is delivery');
assert(isDeliveryQuestion('delivery charge koto'), 'delivery charge koto');
assert(extractDeliveryHint('sitakunda te koto').includes('চট্টগ্রাম'), 'sitakunda hint');
assert(calculateDelivery('sitakunda').charge === 100, 'sitakunda is ctg 100');
assert(lineTotal(1450, 3) === 4350, '3 x 1450');
assert(quoteOrderTotal({ productName: 'three piece', unitPrice: 1450, qty: 3, addressHint: 'sitakunda' }).includes('4450'), 'sitakunda total 4450');

const quotedOk = validateOrderFields({
  name: quoted.name,
  address: quoted.address,
  phone: quoted.phone,
  productName: 'three piece',
  productPrice: 1450,
});
assert(quotedOk.ok, 'quoted form fields pass validation');

const noProduct = validateOrderFields({
  name: 'রহিম',
  address: 'বারইয়ারহাট, মীরসরাই, চট্টগ্রাম',
  phone: '01712345678',
  productName: '',
  productPrice: 0,
});
assert(noProduct.errors.includes('product') && noProduct.errors.includes('price'), 'missing product/price blocked');

console.log('\n== Phase 3 delivery / advance ==');
assert(calculateDelivery('মীরসরাই বারইয়ারহাট').charge === 0, 'mirsarai free');
assert(calculateDelivery('চট্টগ্রাম সদর').charge === 100, 'ctg 100');
assert(calculateDelivery('ঢাকা').charge === 150, 'rest of BD 150');
assert(calculateAdvance(6000, 150).amount === 1000, '5k+ advance 1000');
assert(calculateAdvance(3500, 150).amount === 500, '3k+ advance 500');
assert(calculateAdvance(800, 100).amount === 100, 'small order advance = delivery');
assert(calculateAdvance(800, 0).amount === 0, 'mirsarai small order no advance');

console.log('\n== Phase 3 duplicate window ==');
assert(DUPLICATE_WINDOW_MS === 30 * 60 * 1000, '30 minute duplicate window');
const now = Date.parse('2026-09-15T12:00:00Z');
assert(
  isDuplicateOrder(
    { product_name: 'গাউন', status: 'pending_payment', created_at: '2026-09-15 11:40:00' },
    { productName: 'গাউন', now }
  ),
  'same product within 30m is duplicate'
);
assert(
  !isDuplicateOrder(
    { product_name: 'গাউন', status: 'pending_payment', created_at: '2026-09-15 11:20:00' },
    { productName: 'গাউন', now }
  ),
  'older than 30m is not duplicate'
);
assert(
  !isDuplicateOrder(
    { product_name: 'গাউন', status: 'paid', created_at: '2026-09-15 11:50:00' },
    { productName: 'গাউন', now }
  ),
  'paid order is not treated as duplicate pending'
);
assert(
  !isDuplicateOrder(
    { product_name: 'কুর্তি', status: 'pending_payment', created_at: '2026-09-15 11:50:00' },
    { productName: 'গাউন', now }
  ),
  'different product is not duplicate'
);

console.log('\n== Phase 3 bKash / copy ==');
delete process.env.BKASH_NUMBER;
assert(getBkashNumber() === '01877765535', 'default bKash fallback');
process.env.BKASH_NUMBER = '01999999999';
assert(getBkashNumber() === '01999999999', 'bKash from env');

const form = orderFormReply();
assert(form.includes('নাম:') && form.includes('মোবাইল:') && form.includes('ঠিকানা:'), 'short bangla order form');
assert(!form.includes('Thank you') && !form.includes('Assalamu'), 'form is not english dump');

const confirm = orderConfirmReply({
  name: 'রহিম',
  product: 'গাউন',
  variant: 'লাল',
  address: 'ঢাকা',
  phone: '01712345678',
  productPrice: 1420,
  delivery: { charge: 150, zone: 'সারা বাংলাদেশ' },
  advance: { amount: 150, note: 'ডেলিভারি চার্জ' },
  total: 1570,
});
assert(confirm.includes('01999999999'), 'confirm uses env bKash');
assert(!/পেমেন্ট কনফার্ম হয়েছে|পেমেন্ট সফল/.test(confirm), 'confirm never auto-confirms payment');
assert(confirm.includes('যাচাই'), 'confirm asks for verification');
assert(missingFieldsReply(['phone']).includes('১১ ডিজিট'), 'phone-only missing copy');

const prompt = buildSystemPrompt({});
assert(prompt.includes('01999999999'), 'system prompt injects env bKash');
assert(!prompt.includes('{{BKASH_NUMBER}}'), 'placeholder replaced');
assert(prompt.includes('কখনোই পেমেন্ট কনফার্ম হয়েছে বলবে না'), 'prompt forbids payment confirm');

console.log('\n== Phase 3 wiring ==');
const handler = read('src/services/messageHandler.js');
const d1 = read('src/services/d1.js');
const schema = read('sql/schema-d1.sql');
const migrate = read('migrate-payment-fields.js');
const service = read('src/services/orderService.js');

assert(handler.includes('resolvePhone') && handler.includes('validateOrderFields'), 'handler validates name/phone/address');
assert(handler.includes('extractOrderDetails') && handler.includes('completeOrderIfPossible'), 'handler merges quoted form into confirm');
assert(handler.includes('isWantThisProduct') && handler.includes('isPaymentProof'), 'handler has want-this and payment short-circuits');
assert(handler.includes('salesFollowup') && handler.includes('extractQuantity'), 'handler answers qty/total/bargain mid-order');
assert(handler.includes('findDuplicateOrder') && handler.includes('webhook_mid'), 'handler dup-check + webhook_mid');
assert(handler.includes('orderConfirmReply') && handler.includes('orderFormReply'), 'handler uses orderRules copy');
assert(!handler.includes('01877765535'), 'handler has no hardcoded bKash');
assert(handler.includes('detectHandoffIntent'), 'handoff intent import kept');
assert(service.includes('isDuplicateOrder'), 'orderService uses 30m rule');
assert(d1.includes("Orders cannot be created as paid"), 'D1 refuses paid inserts');
assert(d1.includes("status = 'pending_verification'"), 'payment claim stays pending_verification');
assert(d1.includes('delivery_charge') && d1.includes('advance_amount') && d1.includes('webhook_mid'), 'saveOrder stores delivery/advance/mid');
assert(schema.includes('delivery_charge') && schema.includes('webhook_mid'), 'schema-d1 has payment + delivery columns');
assert(migrate.includes('ADD COLUMN webhook_mid') && migrate.includes('ADD COLUMN delivery_charge'), 'migrate adds new columns');
assert(!migrate.includes('];\n  \'ALTER TABLE'), 'migrate has no leftover syntax');

console.log('\n== Result ==');
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('Phase 3 checks passed');
