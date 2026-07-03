/**
 * Lightweight NLP helpers — deterministic, zero AI cost.
 *
 * isProductQuery() is the key new addition:
 *   Returns true only when the message likely contains a product inquiry.
 *   Used by messageHandler to decide whether to call TiDB at all.
 *   Greetings, thanks, and payment messages skip the DB entirely.
 */

// ── Handoff triggers ──────────────────────────────────────────────────────────
const HANDOFF_KEYWORDS = [
  'manager', 'real agent', 'human', 'manush', 'মানুষ',
  'complaint', 'refund', 'return', 'ফেরত', 'রিফান্ড',
  'fraud', 'cheat', 'প্রতারণা', 'ঠকানো',
  'admin', 'সমস্যা আছে', 'সমস্যা হচ্ছে', 'problem ache',
  'shomossha', 'দেখতে পাচ্ছি না', 'পাচ্ছি না',
];

export function detectHandoffIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return HANDOFF_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Product query detection ───────────────────────────────────────────────────
// If message matches any of these patterns, we query TiDB.
// Everything else (greetings, thanks, payment, gibberish) skips the DB.

const PRODUCT_KEYWORDS = [
  // Bengali product types
  'শাড়ি', 'saree', 'sari',
  'থ্রি-পিস', 'থ্রিপিস', 'three piece', '3 piece', '3piece',
  'কুর্তি', 'kurti',
  'পাঞ্জাবি', 'panjabi', 'punjabi',
  'সালোয়ার', 'salwar',
  'লেহেঙ্গা', 'lehenga',
  'ড্রেস', 'dress',
  'টপ', 'top',
  'স্কার্ট', 'skirt',
  'গেঞ্জি', 'genji', 'tshirt', 't-shirt',
  'শার্ট', 'shirt',
  'প্যান্ট', 'pant', 'pants',
  'জামা', 'jama',
  'পোশাক', 'poshak',
  'কাপড়', 'kapor',
  'ওড়না', 'orna', 'dupatta',
  'হিজাব', 'hijab',
  'বোরকা', 'borka', 'burqa',
  'ব্যাগ', 'bag',
  'জুতা', 'juta', 'shoes', 'sandal', 'স্যান্ডেল',
  'গহনা', 'গয়না', 'jewelry',

  // Query words that signal product search
  'দাম', 'dam', 'price', 'দাম কত', 'কত টাকা', 'কত দাম',
  'আছে কি', 'আছে?', 'পাওয়া যাবে', 'পাবো',
  'দেখান', 'দেখাও', 'দেখতে চাই',
  'কিনতে চাই', 'নিতে চাই', 'কিনবো', 'নেবো',
  'স্টক', 'stock', 'available',
  'নতুন', 'latest', 'new arrival',
  'সাইজ', 'size', 'কালার', 'color', 'colour', 'রং',
  'ডিজাইন', 'design', 'ছবি পাঠান',
  'order', 'অর্ডার', 'অর্ডার করা', 'কিনতে', 'নিতে',
  'কোনটা ভালো', 'কোনটা নেবো',
];

/**
 * Returns true if the message likely contains a product inquiry.
 * Call this BEFORE querying TiDB to avoid unnecessary DB hits.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isProductQuery(text) {
  if (!text || text.trim().length === 0) return false;

  // Very short messages (1-2 words) that are greetings — skip DB
  const greetings = [
    'হ্যালো', 'hello', 'hi', 'হাই',
    'আসসালামু আলাইকুম', 'assalamu alaikum', 'salam', 'সালাম',
    'ওয়ালাইকুম', 'walaikum',
    'ধন্যবাদ', 'thanks', 'thank you', 'shukriya',
    'ঠিক আছে', 'ok', 'okay', 'আচ্ছা', 'জি',
    'বিদায়', 'bye', 'goodbye',
  ];

  const lower = text.toLowerCase().trim();

  // If it's just a greeting phrase, skip DB
  if (greetings.some(g => lower === g || lower === g + '!' || lower === g + '?')) {
    return false;
  }

  // If message contains any product keyword, query DB
  if (PRODUCT_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))) {
    return true;
  }

  // Heuristic: messages longer than 15 chars that aren't pure greetings
  // might contain product queries in informal Bengali — let AI handle without DB
  // (DB query would return empty anyway)
  return false;
}

// ── Bengali digit conversion ──────────────────────────────────────────────────
const BANGLA_DIGITS = { '০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9' };

function banglaToAscii(text) {
  return text.replace(/[০-৯]/g, ch => BANGLA_DIGITS[ch] || ch);
}

// ── Field extraction ──────────────────────────────────────────────────────────

/**
 * Extracts structured fields from free text.
 * Currently supports: phone
 * Bangladeshi mobile: 01[3-9]XXXXXXXX (11 digits)
 * Accepts both Bengali (০১৭...) and ASCII (017...) digits.
 */
export function extractOrderField(field, text) {
  if (field === 'phone') {
    // Convert Bengali digits → ASCII, then strip whitespace/dashes
    const ascii = banglaToAscii(text);
    const cleaned = ascii.replace(/[\s\-().]/g, '');
    const match = cleaned.match(/(?:\+88)?01[3-9]\d{8}/);
    return match ? match[0].replace('+88', '') : null;
  }
  return null;
}
