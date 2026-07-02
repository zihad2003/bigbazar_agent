/**
 * Lightweight NLP helpers — deterministic, no AI call needed for these.
 * Keeps handoff detection instant and not dependent on AI judgment alone.
 */

const HANDOFF_KEYWORDS = [
  'manager', 'real agent', 'human', 'manush', 'manusher sathe',
  'complaint', 'refund', 'return', 'fraud', 'cheat', 'admin',
  'shomossha', 'problem ache',
];

export function detectHandoffIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return HANDOFF_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Extracts structured fields from free text. Currently supports phone.
 * Bangladeshi mobile format: 01[3-9]XXXXXXXX (11 digits total)
 */
export function extractOrderField(field, text) {
  if (field === 'phone') {
    const match = text.replace(/[\s-]/g, '').match(/01[3-9]\d{8}/);
    return match ? match[0] : null;
  }
  return null;
}
