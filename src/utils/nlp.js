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
// HUMAN SALES REP LOGIC:
// Only query TiDB when customer explicitly asks about a product, price, stock,
// clothing type, size, color, or photo.
// Regular chat (greetings, shop location, delivery charges, bKash number,
// giving name/address for order) skips TiDB entirely.

const PRODUCT_TYPES = [
  // English & Banglish dress/apparel types
  'saree', 'sari', 'shari', 'sadi', 'sarii', 'sare',
  '3piece', '3pis', '3pic', '3 piece', 'three piece', 'three-piece', 'thripis', 'thri-piece',
  '2piece', '2pis', '2pic', '2 piece', 'two piece', 'two-piece', 'twopis',
  'kurti', 'kurtis', 'panjabi', 'punjabi', 'salwar', 'lehenga', 'lehenga', 'gown',
  'dress', 'dresses', 'top', 'tops', 'skirt', 'genji', 'tshirt', 't-shirt', 'shirt',
  'pant', 'pants', 'jama', 'poshak', 'kapor', 'orna', 'dupatta', 'hijab', 'borka', 'burqa',
  'bag', 'bags', 'juta', 'shoes', 'sandal', 'sandals', 'jewelry',

  // Bengali script dress types
  'শাড়ি', 'শাড়ি', 'থ্রি-পিস', 'থ্রিপিস', 'টুপিস', 'টু-পিস', 'কুর্তি', 'পাঞ্জাবি',
  'সালোয়ার', 'লেহেঙ্গা', 'লেহেংগা', 'গাউন', 'ড্রেস', 'টপ', 'স্কার্ট', 'গেঞ্জি',
  'টি-শার্ট', 'শার্ট', 'প্যান্ট', 'জামা', 'পোশাক', 'কাপড়', 'ওড়না', 'হিজাব', 'বোরকা',
  'ব্যাগ', 'জুতা', 'স্যান্ডেল', 'গহনা', 'গয়না',
];

const INTENT_SIGNALS = [
  // Price / Cost queries
  'dam', 'price', 'koto', 'কত', 'দাম', 'টাকা', 'দাম কত', 'কত টাকা', 'কত দাম', 'কত পরবে',
  // Availability / Stock
  'stock', 'available', 'ache', 'আছে', 'পাবো', 'পাওয়া যাবে', 'পাওয়া যাবে', 'স্টক',
  // Photos / Designs
  'chobi', 'cobi', 'pic', 'picture', 'photo', 'dekhi', 'dekhao', 'dekhon',
  'ছবি', 'পিক', 'পিকচার', 'ফটো', 'দেখান', 'দেখাও', 'দেখতে চাই', 'ছবি পাঠান',
  // Details (size, color, material)
  'size', 'সাইজ', 'color', 'colour', 'কালার', 'রং', 'রঙ', 'design', 'ডিজাইন', 'material',
  // Catalog / Collection
  'collection', 'catalogue', 'catalog', 'latest', 'new arrival', 'নতুন', 'কালেকশন', 'ক্যাটালগ',
];

/**
 * Returns true if the message is explicitly about a product inquiry or catalog search.
 * Mimics human rep behavior — skips DB for general chat, shop info, delivery, bKash, etc.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isProductQuery(text) {
  if (!text || text.trim().length === 0) return false;

  const lower = text.toLowerCase().trim();

  // If message contains any explicit product type (e.g. saree, kurti, 3pis)
  const hasProductType = PRODUCT_TYPES.some(pt => lower.includes(pt));

  // If message contains intent signals (e.g. dam koto, ache ki, pic dekhi)
  const hasIntentSignal = INTENT_SIGNALS.some(sig => lower.includes(sig));

  // Query DB only if customer mentions a product type OR asks a product/price/photo question
  return hasProductType || hasIntentSignal;
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
