/**
 * Product Search Service — hybrid token search + screenshot visual match.
 */
import { searchCachedCatalog } from './catalogCache.js';
import { describeAudio } from './ai.js';
import { matchCustomerImage } from './visualMatch.js';
import { isGenericProductFollowup } from '../utils/searchNormalize.js';

async function textSearch(messageText, audioUrl, pendingProductName) {
  const parts = [];
  if (messageText?.trim()) parts.push(messageText.trim());

  if (audioUrl) {
    try {
      console.log(`🎤 [Product Search] Analyzing voice message: ${audioUrl}`);
      const audioKeywords = await describeAudio(audioUrl);
      if (audioKeywords && audioKeywords.trim().length >= 2) {
        parts.push(audioKeywords.trim());
      }
    } catch (e) {
      console.error('Failed to describe audio during search:', e.message);
    }
  }

  const query = parts.join(' ');
  let products = query ? await searchCachedCatalog(query, 5) : [];

  if ((products.length === 0 || isGenericProductFollowup(messageText)) && pendingProductName) {
    console.log(`🔄 [Product Search] Fallback to pending product: "${pendingProductName}"`);
    products = await searchCachedCatalog(pendingProductName, 5);
  }

  return products.slice(0, 3);
}

/**
 * @returns {Promise<{ products: Array, visual: object|null }>}
 */
export async function searchProducts(messageText, imageUrl, audioUrl, pendingProductName = null) {
  if (imageUrl) {
    try {
      const visual = await matchCustomerImage(imageUrl, messageText, pendingProductName);
      console.log(`🎯 [Product Search] Visual ${visual.kind} via ${visual.source}, ${visual.products.length} product(s)`);
      return { products: visual.products.slice(0, 3), visual };
    } catch (e) {
      console.error('Visual match failed, falling back to text search:', e.message);
    }
  }

  const products = await textSearch(messageText, audioUrl, pendingProductName);
  console.log(`🎯 [Product Search] Found ${products.length} products for text/audio query.`);
  return { products, visual: null };
}
