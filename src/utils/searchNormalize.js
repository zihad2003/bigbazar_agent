/**
 * Bangla / Banglish product query normalization for catalog search.
 */

const SYNONYM_GROUPS = [
  ['sadi', 'saree', 'sari', 'shari', 'sarii', 'sare', 'শাড়ি', 'শাড়ি'],
  ['3pis', '3piece', '3pic', '3pice', '3 piece', 'three piece', 'three-piece', 'thripis', 'থ্রিপিস', 'থ্রি-পিস', 'থ্রি পিস'],
  ['2pis', '2piece', '2pic', '2 piece', 'two piece', 'two-piece', 'টুপিস', 'টু-পিস', 'টু পিস'],
  ['kurti', 'kurtis', 'কুর্তি'],
  ['panjabi', 'punjabi', 'পাঞ্জাবি'],
  ['lehenga', 'লেহেঙ্গা', 'লেহেংগা'],
  ['gown', 'গাউন'],
  ['orna', 'dupatta', 'ওড়না', 'ওড়না'],
  ['hijab', 'হিজাব'],
  ['borka', 'burqa', 'বোরকা'],
  ['delivery', 'ডেলিভারি', 'ডেলিভারী', 'delivary'],
  ['bkash', 'bikash', 'বিকাশ', 'nagad', 'নগদ'],
];

const FILLERS = new Set([
  'price', 'koto', 'dam', 'ki', 'ta', 'er', 'ei', 'the', 'what', 'is', 'a', 'an',
  'please', 'apu', 'bhai', 'bhaiya', 'vai', 'sister', 'bro',
  'কত', 'আছে', 'দাম', 'এই', 'টার', 'টারটা', 'কি', 'কী', 'আপু', 'ভাইয়া', 'ভাইয়া',
  'আমার', 'একটা', 'একটি', 'টা', 'টি', 'খান', 'please', 'pls',
  'screenshot', 'ss', 'reel', 'reels', 'tiktok', 'instagram', 'insta', 'facebook', 'fb',
]);

const GENERIC_QUERY = /^(cobi|chobi|pic|picture|photo|image|url|link|ছবি|পিক|পিকচার|লিংক|দাম|dam|price|কত|koto|size|সাইজ|color|কালার|রং|আছে|ace|আছে কি|dekhaw|dekhon|দেখান|দেখাও|দাও|daw)$/i;

export function isGenericProductFollowup(text) {
  if (!text || !text.trim()) return true;
  return GENERIC_QUERY.test(text.trim());
}

export function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[-_.,!?;:()[\]{}'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function expandSynonyms(text) {
  let t = normalizeText(text);
  if (!t) return '';
  const extra = [];
  for (const group of SYNONYM_GROUPS) {
    if (group.some(g => t.includes(g))) {
      extra.push(...group);
    }
  }
  if (extra.length) t = `${t} ${extra.join(' ')}`;
  return t;
}

export function tokenizeQuery(text) {
  const expanded = expandSynonyms(text);
  const tokens = expanded
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !FILLERS.has(t));
  return [...new Set(tokens)];
}

export function fieldToSearchText(val) {
  if (val == null || val === '') return '';
  if (Array.isArray(val)) return val.map(fieldToSearchText).join(' ');
  if (typeof val === 'object') {
    try {
      return Object.values(val).map(fieldToSearchText).join(' ');
    } catch {
      return '';
    }
  }
  return String(val);
}

export function buildSearchBlob(product) {
  const raw = [
    product.name,
    product.category,
    fieldToSearchText(product.colors),
    fieldToSearchText(product.sizes),
  ].filter(Boolean).join(' ');
  return expandSynonyms(raw);
}

export function scoreAgainstTokens(searchBlob, tokens) {
  if (!searchBlob || !tokens.length) return 0;
  let score = 0;
  for (const tok of tokens) {
    if (searchBlob.includes(tok)) {
      score += tok.length >= 4 ? 2 : 1;
    }
  }
  return score;
}

export function getProductImageUrls(product) {
  if (!product) return [];
  const urls = [];
  const push = (u) => {
    if (typeof u === 'string' && u.trim().toLowerCase().startsWith('http')) {
      urls.push(u.trim());
    } else if (u && typeof u === 'object' && typeof u.url === 'string') {
      urls.push(u.url.trim());
    }
  };
  push(product.imageUrl || product.image_url);
  let images = product.images;
  if (typeof images === 'string') {
    try {
      images = JSON.parse(images);
    } catch {
      images = [];
    }
  }
  if (Array.isArray(images)) {
    for (const img of images) push(img);
  }
  return [...new Set(urls)];
}
