/**
 * Message Handler — Conversation State Machine
 *
 * States:
 *   GREETING              → first contact / unknown
 *   PRODUCT_SEARCH        → identifying what customer wants
 *   AWAITING_CONFIRMATION → shown price, waiting for "haa/yes/nibo"
 *   COLLECT_NAME          → collecting customer full name
 *   COLLECT_ADDRESS       → collecting delivery address
 *   COLLECT_PHONE         → collecting phone number
 *   COLLECT_VARIANT       → collecting size/color if needed
 *   ORDER_CONFIRM         → order summary sent, awaiting payment
 *   HANDOFF               → paused, human moderator active
 */

import { getOrCreateConversation, updateConversation } from './d1.js';
import { getAIReply } from './groq.js';
import { searchProducts } from './productSearch.js';
import { saveOrder } from './orderService.js';
import { sendMessage, sendTypingIndicator } from './messenger.js';
import { notifyModerator } from './notifier.js';
import { detectHandoffIntent, extractOrderField } from '../utils/nlp.js';
import { buildSystemPrompt } from '../utils/prompts.js';

export async function handleMessage(event) {
  // Ignore delivery/read receipts
  if (!event.message) return;
  // Ignore bot's own echo messages
  if (event.message.is_echo) return;

  const senderId = event.sender.id;
  const messageText = event.message.text ?? '';
  const attachments = event.message.attachments ?? [];

  // ── Load or create conversation state ────────────────────────────────────────
  const conversation = await getOrCreateConversation(senderId);

  // ── If paused, human moderator is active — do nothing ────────────────────────
  if (conversation.paused_by_ai) {
    console.log(`⏸  Conversation ${senderId} is paused — skipping AI reply`);
    return;
  }

  // ── Detect if customer wants a human ─────────────────────────────────────────
  if (detectHandoffIntent(messageText)) {
    await triggerHandoff(senderId, conversation, 'Customer requested human agent');
    return;
  }

  // ── Show typing indicator ─────────────────────────────────────────────────────
  await sendTypingIndicator(senderId, true);

  // ── State machine ─────────────────────────────────────────────────────────────
  let reply;
  let stateUpdate = {};

  switch (conversation.state) {

    case 'COLLECT_NAME': {
      const name = messageText.trim();
      stateUpdate = { state: 'COLLECT_ADDRESS', order_name: name };
      reply = `Dhonnobad, ${name} apu/bhai! 😊\n\nEkhon delivery address ta share korben please? (Gram/Moholla, Thana, Zilla)`;
      break;
    }

    case 'COLLECT_ADDRESS': {
      stateUpdate = { state: 'COLLECT_PHONE', order_address: messageText.trim() };
      reply = `Perfect! ✅\n\nApnar active phone number ta bolun?`;
      break;
    }

    case 'COLLECT_PHONE': {
      const phone = extractOrderField('phone', messageText);
      if (!phone) {
        reply = `Apu, valid phone number ta bolun please (e.g. 017XXXXXXXX)`;
        break;
      }

      // Save the complete order
      const order = await saveOrder({
        sender_id: senderId,
        name: conversation.order_name,
        address: conversation.order_address,
        phone,
        product_name: conversation.pending_product_name,
        product_price: conversation.pending_product_price,
        variant: conversation.pending_variant,
      });

      stateUpdate = {
        state: 'ORDER_CONFIRM',
        order_phone: phone,
        last_order_id: order.id,
      };

      const total = (conversation.pending_product_price ?? 0) + 80;
      reply =
`✅ *Order Confirmed!* 🎉

👤 Nam: ${conversation.order_name}
📦 Product: ${conversation.pending_product_name}${conversation.pending_variant ? ` (${conversation.pending_variant})` : ''}
📍 Address: ${conversation.order_address}
📞 Phone: ${phone}
💰 Price: ${conversation.pending_product_price} taka
🚚 Delivery: 80 taka
💵 *Total: ${total} taka*

──────────────────
bKash / Nagad: *${process.env.BKASH_NUMBER}*
Payment korle "paid" likhe pathaben! 🙏

Delivery hobe 2-3 business day-er moddhe. Onek dhonnobad! 🛍️`;

      await notifyModerator({
        type: 'NEW_ORDER',
        order: { id: order.id, name: conversation.order_name, product: conversation.pending_product_name, total },
        senderId,
      });
      break;
    }

    default: {
      // ── For all other states, call the AI ──────────────────────────────────
      const imageUrl = attachments.find(a => a.type === 'image')?.payload?.url;

      // Search products if there's a product query
      const products = await searchProducts(messageText, imageUrl);

      // Build context for the AI
      const context = {
        state: conversation.state,
        history: conversation.message_history ?? [],
        products,
        imageUrl,
        pendingProduct: conversation.pending_product_name,
      };

      const systemPrompt = buildSystemPrompt(context);
      const aiResult = await getAIReply(systemPrompt, messageText, imageUrl, conversation.message_history ?? []);

      reply = aiResult.text;

      // Parse AI intent flags
      if (aiResult.intent === 'PRODUCT_FOUND') {
        stateUpdate = {
          state: 'AWAITING_CONFIRMATION',
          pending_product_name: aiResult.productName,
          pending_product_price: aiResult.productPrice,
          pending_variant: aiResult.variant,
        };
      } else if (aiResult.intent === 'START_ORDER') {
        stateUpdate = { state: 'COLLECT_NAME' };
      } else if (aiResult.intent === 'HANDOFF') {
        await triggerHandoff(senderId, conversation, 'AI could not resolve query');
        return;
      }
    }
  }

  // ── Persist state changes + append to history ─────────────────────────────
  const newHistory = [
    ...(conversation.message_history ?? []).slice(-10), // keep last 10 turns
    { role: 'user', content: messageText, ts: Date.now() },
    { role: 'assistant', content: reply, ts: Date.now() },
  ];

  await updateConversation(senderId, {
    ...stateUpdate,
    message_history: newHistory,
    updated_at: new Date().toISOString(),
  });

  // ── Send reply ────────────────────────────────────────────────────────────
  await sendTypingIndicator(senderId, false);
  await sendMessage(senderId, reply);
}

async function triggerHandoff(senderId, conversation, reason) {
  await updateConversation(senderId, {
    paused_by_ai: true,
    paused_reason: reason,
    state: 'HANDOFF',
  });

  await sendMessage(
    senderId,
    'Ji apu/bhai, ektu wait korun! 🙏\n\nAmader team member apnar shonge shigghiri kotha bolbe. Dhonnobad apnar shathe! 😊'
  );

  await notifyModerator({
    type: 'HANDOFF_NEEDED',
    reason,
    senderId,
    lastMessage: conversation.message_history?.slice(-1)?.[0]?.content ?? '',
  });

  console.log(`🤝 Handoff triggered for ${senderId}: ${reason}`);
}
