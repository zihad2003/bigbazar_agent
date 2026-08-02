/**
 * Order Service — persists finalized orders to the agent's Cloudflare D1 store.
 */

import { saveOrder as saveOrderToD1 } from './d1.js';

export async function saveOrder({ sender_id, name, address, phone, product_name, product_price, variant }) {
  return await saveOrderToD1({ sender_id, name, address, phone, product_name, product_price, variant });
}
