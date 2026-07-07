/**
 * Product Search Service
 *
 * Handles querying the TiDB database based on:
 *   - message text (with query expansion for popular categories)
 *   - image description (vision keywords)
 *   - fallback to pending product name when the query is generic or yields no results.
 */

import { searchProductsByText } from '../db/tidb.js';
import { describeImage } from './groq.js';

/**
 * Expand queries to map spelling variants of popular categories in the database.
 * Database contains "Sadi", "3pis", "2pis", "Saree", "unstitche 3 piece", etc.
 */
function expandQueryKeywords(messageText) {
  if (!messageText) return [];
  const lower = messageText.toLowerCase();
  const queries = [messageText];

  // Saree mapping
  const sareeKeywords = ['sari', 'saree', 'shari', 'sarii', 'sare', 'sadi', 'শাড়ি', 'শাড়ি'];
  if (sareeKeywords.some(kw => lower.includes(kw))) {
    queries.push('sadi', 'sari', 'saree', 'sarii');
  }

  // Three piece mapping
  const threePieceKeywords = ['three piece', 'three-piece', '3 piece', '3-piece', '3piece', '3pis', '3pic', 'three pices', 'three pices', 'ثري بيس', 'থ্রিপিস', 'থ্রি-পিস', 'thee piece', 'thee-piece', 'thee pis', 'thee pic', 'thre piece', 'thre-piece', 'thre pis', 'thre pic'];
  if (threePieceKeywords.some(kw => lower.includes(kw))) {
    queries.push('3piece', '3pis', 'three piece', 'three pices');
  }

  // Two piece mapping
  const twoPieceKeywords = ['two piece', 'two-piece', '2 piece', '2-piece', '2piece', '2pis', '2pic', 'two pices', 'টুপিস', 'টু-পিস', 'tow piece', 'tow-piece', 'tow pis', 'tow pic', 'to piece', 'to-piece', 'to pis', 'to pic'];
  if (twoPieceKeywords.some(kw => lower.includes(kw))) {
    queries.push('2 piece', '2pis');
  }

  // Kurti mapping
  const kurtiKeywords = ['kurti', 'কুর্তি'];
  if (kurtiKeywords.some(kw => lower.includes(kw))) {
    queries.push('kurti');
  }

  // Panjabi mapping
  const panjabiKeywords = ['panjabi', 'punjabi', 'পাঞ্জাবি'];
  if (panjabiKeywords.some(kw => lower.includes(kw))) {
    queries.push('panjabi');
  }

  // Lehenga mapping
  const lehengaKeywords = ['lehenga', 'লেহেঙ্গা', 'লেহেংগা'];
  if (lehengaKeywords.some(kw => lower.includes(kw))) {
    queries.push('lehenga');
  }

  return [...new Set(queries)];
}

/**
 * @param {string} messageText
 * @param {string|undefined} imageUrl
 * @param {string|null} pendingProductName
 * @returns {Promise<Array>}
 */
export async function searchProducts(messageText, imageUrl, pendingProductName = null) {
  const searchQueries = [];

  if (messageText?.trim()) {
    // Expand the query with database synonyms/aliases
    const expanded = expandQueryKeywords(messageText);
    searchQueries.push(...expanded);
  }

  if (imageUrl) {
    try {
      console.log(`📸 [Product Search] Analyzing image attachment: ${imageUrl}`);
      const imageKeywords = await describeImage(imageUrl);
      if (imageKeywords && imageKeywords.trim().length >= 2) {
        searchQueries.push(imageKeywords);
      }
    } catch (e) {
      console.error('Failed to describe image during search:', e.message);
    }
  }

  if (searchQueries.length === 0) {
    return [];
  }

  let allResults = [];
  const fillerWords = /\b(price|koto|dam|ki|ta|er|ei|the|what|is|কত|আছে|দাম|এই|টার|কি|কী|আপু|ভাইয়া)\b/gi;

  for (const q of searchQueries) {
    const cleaned = q.replace(fillerWords, '').trim();
    const query = cleaned.length >= 2 ? cleaned : q;
    
    console.log(`🔍 [Product Search] Searching DB for query: "${query}"`);
    const results = await searchProductsByText(query, 5);
    allResults = [...allResults, ...results];

    // If cleaned query returned nothing, try full original text
    if (results.length === 0 && cleaned !== q) {
      const fallbackResults = await searchProductsByText(q, 5);
      allResults = [...allResults, ...fallbackResults];
    }
  }

  // Deduplicate products by id
  const seenIds = new Set();
  const uniqueProducts = [];
  for (const product of allResults) {
    if (!seenIds.has(product.id)) {
      seenIds.add(product.id);
      uniqueProducts.push(product);
    }
  }

  // ── Context Retention Fallback ─────────────────────────────────────────────
  // If the query yields no results (or is very generic/short) but we have a
  // pending product name, search for the pending product name instead so the AI
  // gets context of what product was being discussed.
  const isGeneric = /^(cobi|chobi|pic|picture|photo|image|url|link|ছবি|পিক|পিকচার|লিংক|দাম|dam|price|কত|koto|size|সাইজ|color|কালার|রং|আছে|ace|আছে কি|dekhaw|dekhon|দেখান|দেখাও|দাও|daw)$/i.test(messageText?.trim().toLowerCase());
  
  if ((uniqueProducts.length === 0 || isGeneric) && pendingProductName) {
    console.log(`🔄 [Product Search] No match or generic query for "${messageText}". Falling back to pending product: "${pendingProductName}"`);
    const fallbackResults = await searchProductsByText(pendingProductName, 5);
    for (const product of fallbackResults) {
      if (!seenIds.has(product.id)) {
        seenIds.add(product.id);
        uniqueProducts.push(product);
      }
    }
  }

  console.log(`🎯 [Product Search] Found ${uniqueProducts.length} unique products matching queries.`);
  return uniqueProducts.slice(0, 6);
}
