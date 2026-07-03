/**
 * Product Search Service
 *
 * Changes from v1:
 *  - Removed getCatalogSnapshot(80) fallback for images.
 *    Dumping 80 products into the prompt was expensive and unhelpful —
 *    the AI couldn't reliably match an image against 80 text entries anyway.
 *    Instead, if no text match + image: return empty and let the AI ask
 *    "কী ধরনের পণ্য খুঁজছেন?" — that's the right UX.
 *
 *  - This function is only called when isProductQuery() returns true
 *    (controlled by messageHandler), so it will rarely return empty.
 */

import { searchProductsByText } from '../db/tidb.js';
import { describeImage } from './groq.js';

/**
 * @param {string} messageText
 * @param {string|undefined} imageUrl
 * @returns {Promise<Array>}
 */
export async function searchProducts(messageText, imageUrl) {
  const searchQueries = [];

  if (messageText?.trim()) {
    searchQueries.push(messageText);
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

  console.log(`🎯 [Product Search] Found ${uniqueProducts.length} unique products matching queries.`);
  return uniqueProducts.slice(0, 6);
}
