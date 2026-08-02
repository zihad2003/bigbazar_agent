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
// INVERTED LOGIC: We search TiDB by default. Only skip the DB for messages
// that are clearly NOT product queries (greetings, payment messages, etc.).
// This ensures Banglish/misspelled product queries always reach the database.

// Messages that should SKIP the database
const SKIP_DB_EXACT = [
  // Greetings
  'হ্যালো', 'hello', 'hi', 'হাই',
  'আসসালামু আলাইকুম', 'assalamu alaikum', 'salam', 'সালাম',
  'ওয়ালাইকুম', 'walaikum', 'walaikum assalam',
  // Thanks & acknowledgments
  'ধন্যবাদ', 'thanks', 'thank you', 'shukriya',
  'ঠিক আছে', 'ok', 'okay', 'আচ্ছা', 'জি', 'হ্যাঁ', 'yes', 'না', 'no',
  // Goodbye
  'বিদায়', 'bye', 'goodbye',
  // Short affirmations
  'hmm', 'হুম', 'ki', 'কি', 'জ্বি',
];

// Payment-related keywords — these shouldn't trigger product search
const PAYMENT_KEYWORDS = [
  'paid', 'পেইড', 'পেমেন্ট', 'bkash', 'বিকাশ', 'nagad', 'নগদ',
  'পাঠিয়েছি', 'পাঠালাম', 'দিলাম', 'send money', 'sent',
  'transaction', 'ট্রানজেকশন', 'last digit', 'লাস্ট ডিজিট',
];

/**
 * Returns true if the message likely contains a product inquiry.
 * Call this BEFORE querying TiDB to avoid unnecessary DB hits.
 *
 * INVERTED LOGIC: returns true by default, false only for known non-product messages.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isProductQuery(text) {
  if (!text || text.trim().length === 0) return false;

  const lower = text.toLowerCase().trim();

  // If it's just a short greeting/acknowledgment, skip DB
  if (SKIP_DB_EXACT.some(g => lower === g || lower === g + '!' || lower === g + '?')) {
    return false;
  }

  // If it's a payment message, skip DB
  if (PAYMENT_KEYWORDS.some(kw => lower.includes(kw))) {
    return false;
  }

  // If it looks like just a phone number or digits (payment reference), skip DB
  if (/^[\d০-৯\s\-+().]{4,15}$/.test(lower)) {
    return false;
  }

  // Everything else → search the DB (this catches Banglish, misspellings, etc.)
  return true;
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
