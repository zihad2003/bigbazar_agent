/**
 * Supabase — Agent State Store
 *
 * This is a SEPARATE, free Supabase project used only for:
 *   - conversations (state machine, pause flag, in-progress order fields)
 *   - orders (finalized orders collected by the AI)
 *
 * Your product catalog lives in TiDB Cloud (see db/tidb.js) and is never
 * touched by this file. Keeping them separate means the AI agent can never
 * accidentally corrupt your live storefront data.
 */

import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // service role — server-side only, never expose to client
  { auth: { persistSession: false } }
);

const DEFAULT_STATE = {
  state: 'GREETING',
  paused_by_ai: false,
  paused_reason: null,
  message_history: [],
  pending_product_name: null,
  pending_product_price: null,
  pending_variant: null,
  order_name: null,
  order_address: null,
};

export async function getOrCreateConversation(senderId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('sender_id', senderId)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: created, error: insertError } = await supabase
    .from('conversations')
    .insert({ sender_id: senderId, ...DEFAULT_STATE })
    .select()
    .single();

  if (insertError) throw insertError;
  return created;
}

export async function updateConversation(senderId, patch) {
  const { error } = await supabase
    .from('conversations')
    .update(patch)
    .eq('sender_id', senderId);

  if (error) throw error;
}
