/**
 * Product Search Service
 * Wraps TiDB queries and combines text + image-derived search terms.
 */

import { searchProductsByText, getCatalogSnapshot } from '../db/tidb.js';

/**
 * Given a customer's message text and/or an image URL, return the most
 * relevant products to ground the AI's reply.
 *
 * Image handling: Claude's vision describes the product (color, type,
 * pattern) as part of getAIReply() — that description is then used here
 * as the search query. See messageHandler.js for the call order.
 */
export async function searchProducts(messageText, imageUrl) {
  // If there's no useful text yet (e.g. image just arrived, not yet
  // described by the AI), return a broad recent-catalog snapshot so the
  // AI has *something* to ground itself with on the first pass.
  if (!messageText?.trim() && imageUrl) {
    return getCatalogSnapshot(40);
  }

  if (!messageText?.trim()) return [];

  // Strip common filler words so "price koto ei saree ta" → "saree"
  const cleaned = messageText
    .replace(/\b(price|koto|dam|ki|ta|er|ei|the|what|is)\b/gi, '')
    .trim();

  const results = await searchProductsByText(cleaned || messageText, 6);

  // Fallback: if nothing matched the cleaned query, try the raw message
  if (results.length === 0 && cleaned !== messageText) {
    return searchProductsByText(messageText, 6);
  }

  return results;
}
