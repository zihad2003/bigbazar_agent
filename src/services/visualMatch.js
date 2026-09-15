/**
 * Match a customer photo / social screenshot to catalog products.
 */
import { searchCachedCatalog } from './catalogCache.js';
import { parseScreenshot, rerankVisualMatch } from './gemini.js';
import { getProductImageUrls, isGenericProductFollowup } from '../utils/searchNormalize.js';

function pickSlots(products, max = 5) {
  const slots = [];
  for (const product of products) {
    const urls = getProductImageUrls(product);
    if (!urls.length) continue;
    slots.push({ product, imageUrl: urls[0] });
    if (slots.length >= max) break;
  }
  return slots;
}

function uniqueById(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const id = String(p.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}

/**
 * @returns {Promise<{ kind: 'PAYMENT'|'HIGH'|'AMBIGUOUS'|'NONE'|'OTHER', products: Array, parse: object|null, source: string }>}
 */
export async function matchCustomerImage(imageUrl, messageText, pendingProductName = null) {
  const parse = await parseScreenshot(imageUrl);

  if (parse?.imageKind === 'payment') {
    return { kind: 'PAYMENT', products: [], parse, source: 'parse' };
  }

  if (parse?.imageKind === 'other' && isGenericProductFollowup(messageText || '')) {
    return { kind: 'OTHER', products: [], parse, source: 'parse' };
  }

  const queryParts = [
    parse?.ocrText,
    parse?.searchKeywords,
    parse?.apparelType,
    parse?.colors,
    parse?.pattern,
    messageText,
  ].filter(Boolean);

  let candidates = [];
  if (queryParts.length) {
    candidates = await searchCachedCatalog(queryParts.join(' '), 8);
  }

  if (parse?.ocrText) {
    const ocrHits = await searchCachedCatalog(parse.ocrText, 3);
    candidates = uniqueById([...ocrHits, ...candidates]);
  }

  if (candidates.length === 0 && pendingProductName) {
    candidates = await searchCachedCatalog(pendingProductName, 5);
  }

  if (candidates.length === 0) {
    return { kind: 'NONE', products: [], parse, source: 'empty' };
  }

  if (candidates.length === 1 && (candidates[0]._score || 0) >= 4) {
    console.log(`🎯 [Visual Match] HIGH via strong lexical score on "${candidates[0].name}"`);
    return { kind: 'HIGH', products: candidates.slice(0, 1), parse, source: 'lexical' };
  }

  const slots = pickSlots(candidates, 5);
  if (slots.length === 0) {
    return {
      kind: candidates.length === 1 ? 'HIGH' : 'AMBIGUOUS',
      products: candidates.slice(0, 2),
      parse,
      source: 'no-images',
    };
  }

  const ranked = await rerankVisualMatch(imageUrl, slots);
  if (ranked.verdict === 'HIGH' && ranked.bestIndex >= 0 && slots[ranked.bestIndex]) {
    return { kind: 'HIGH', products: [slots[ranked.bestIndex].product], parse, source: 'rerank' };
  }

  if (ranked.verdict === 'AMBIGUOUS') {
    const picks = [];
    if (ranked.bestIndex >= 0 && slots[ranked.bestIndex]) picks.push(slots[ranked.bestIndex].product);
    if (ranked.secondIndex >= 0 && slots[ranked.secondIndex]) picks.push(slots[ranked.secondIndex].product);
    const products = uniqueById(picks.length ? picks : candidates.slice(0, 2));
    return { kind: 'AMBIGUOUS', products, parse, source: 'rerank' };
  }

  return { kind: 'NONE', products: [], parse, source: 'rerank' };
}
