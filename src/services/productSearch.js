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
  let results = [];

  if (messageText?.trim()) {
    // Strip common filler words so "price koto ei saree ta" → "saree"
    const cleaned = messageText
      .replace(/\b(price|koto|dam|ki|ta|er|ei|the|what|is)\b/gi, '')
      .trim();

    results = await searchProductsByText(cleaned || messageText, 6);

    // Fallback: if nothing matched the cleaned query, try the raw message
    if (results.length === 0 && cleaned !== messageText) {
      results = await searchProductsByText(messageText, 6);
    }
  }

  // If we have an image and no text search results, return a larger catalog snapshot
  // so the vision model can match the image against the actual products in the prompt context.
  if (results.length === 0 && imageUrl) {
    return getCatalogSnapshot(80);
  }

  return results;
}
