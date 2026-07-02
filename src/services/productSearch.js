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

/**
 * @param {string} messageText
 * @param {string|undefined} imageUrl
 * @returns {Promise<Array>}
 */
export async function searchProducts(messageText, imageUrl) {
  // If there's text, search by text first
  if (messageText?.trim()) {
    // Strip filler words so "এই শাড়িটার দাম কত" → "শাড়ি"
    const fillerWords = /\b(price|koto|dam|ki|ta|er|ei|the|what|is|কত|আছে|দাম|এই|টার|কি|কী|আপু|ভাইয়া)\b/gi;
    const cleaned = messageText.replace(fillerWords, '').trim();

    const query = cleaned.length >= 2 ? cleaned : messageText;
    const results = await searchProductsByText(query, 6);

    // If cleaned query returned nothing, try full original text
    if (results.length === 0 && cleaned !== messageText) {
      return searchProductsByText(messageText, 6);
    }

    return results;
  }

  // Image only, no text — return empty.
  // messageHandler/AI will ask "কী ধরনের পণ্য খুঁজছেন?"
  // This avoids dumping 80 products into the AI prompt unnecessarily.
  return [];
}
