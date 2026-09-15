/**
 * Order Service — persists finalized orders to the agent's Cloudflare D1 store.
 */

import { saveOrder as saveOrderToD1, findRecentDuplicateOrder } from './d1.js';
import { isDuplicateOrder } from '../utils/orderRules.js';

export async function saveOrder(payload) {
  return await saveOrderToD1(payload);
}

export async function findDuplicateOrder(senderId, productName) {
  const rows = await findRecentDuplicateOrder(senderId, productName);
  return rows.find(o => isDuplicateOrder(o, { productName })) || null;
}
