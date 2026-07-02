/**
 * Message Handler — Conversation State Machine
 *
 * Key changes from v1:
 *  - DB (TiDB product search) is only called when message is product-related
 *  - All states explicitly handled — no unintentional fallthrough to AI
 *  - ORDER_CONFIRM / PAID state added
 *  - GREETING state handled without any DB call
 *  - Response length enforced via prompt (see utils/prompts.js)
 */

import { getOrCreateConversation, updateConversation, getSettingCached } from './d1.js';
import { getAIReply } from './groq.js';
import { searchProducts } from './productSearch.js';
import { saveOrder } from './orderService.js';
import { sendMessage, sendImageMessage, sendTypingIndicator } from './messenger.js';
import { notifyModerator } from './notifier.js';
import { detectHandoffIntent, extractOrderField, isProductQuery } from '../utils/nlp.js';
import { buildSystemPrompt } from '../utils/prompts.js';

export async function handleMessage(event) {
  // Ignore delivery/read receipts and echo messages
  if (!event.message) return;
  if (event.message.is_echo) return;

  const senderId = event.sender.id;

  // ── 1. Global kill switch ────────────────────────────────────────────────────
  const autoReplyEnabled = await getSettingCached('AUTO_REPLY_ENABLED', 'true');
  if (autoReplyEnabled === 'false') {
    console.log(`⏸ [KILL SWITCH] Auto-reply disabled. Ignoring PSID: ${senderId}`);
    return;
  }

  // ── 2. Test mode — only allow specific PSIDs ─────────────────────────────────
  const testMode = await getSettingCached('TEST_MODE', 'false');
  if (testMode === 'true') {
    const testerPsidsVal = await getSettingCached('TESTER_PSIDS', '');
    const testerPsids = testerPsidsVal.split(',').map(id => id.trim()).filter(Boolean);
    console.log(`🧪 [TEST MODE] Sender: ${senderId} | Allowed testers: [${testerPsids.join(', ')}] | Match: ${testerPsids.includes(senderId)}`);
    if (!testerPsids.includes(senderId)) {
      console.log(`⏸ [TEST MODE] Blocked non-tester PSID: ${senderId}`);
      return;
    }
  }

  const messageText = (event.message.text ?? '').trim();
  const attachments = event.message.attachments ?? [];
  const imageUrl = attachments.find(a => a.type === 'image')?.payload?.url;

  // ── 3. Load conversation state ───────────────────────────────────────────────
  const conversation = await getOrCreateConversation(senderId);

  // ── 4. Human moderator active — do nothing ───────────────────────────────────
  if (conversation.paused_by_ai) return;

  // ── 5. Handoff detection (fast, no AI needed) ────────────────────────────────
  if (detectHandoffIntent(messageText)) {
    await triggerHandoff(senderId, conversation, 'Customer requested human agent');
    return;
  }

  // ── 6. State machine ─────────────────────────────────────────────────────────
  await sendTypingIndicator(senderId, true);

  let reply;
  let stateUpdate = {};
  let needsAI = false;

  switch (conversation.state) {

    // ── Structured data collection states — no AI, no DB needed ──────────────

    case 'COLLECT_NAME': {
      const name = messageText;
      if (!name || name.length < 2) {
        reply = 'আপনার পুরো নামটা লিখুন।';
        break;
      }
      stateUpdate = { state: 'COLLECT_ADDRESS', order_name: name };
      reply = `ধন্যবাদ ${name}! এবার ডেলিভারি ঠিকানা দিন (গ্রাম/মহল্লা, থানা, জেলা)।`;
      break;
    }

    case 'COLLECT_ADDRESS': {
      if (!messageText || messageText.length < 5) {
        reply = 'সম্পূর্ণ ঠিকানা লিখুন (গ্রাম, থানা, জেলা)।';
        break;
      }
      stateUpdate = { state: 'COLLECT_PHONE', order_address: messageText };
      reply = 'ধন্যবাদ! এবার সচল মোবাইল নম্বর দিন।';
      break;
    }

    case 'COLLECT_PHONE': {
      // Escape hatch: if customer sends cancel/reset keywords or a product query, break out
      const cancelWords = ['না', 'cancel', 'বাদ', 'থাক', 'দরকার নেই', 'লাগবে না', 'আর না'];
      const lowerMsg = messageText.toLowerCase();
      if (cancelWords.some(w => lowerMsg.includes(w))) {
        stateUpdate = { state: 'GREETING', pending_product_name: null, pending_product_price: null, pending_variant: null, order_name: null, order_address: null };
        reply = 'ঠিক আছে, অর্ডার বাতিল করা হয়েছে। 🙏 অন্য কিছু দেখতে চাইলে বলুন!';
        break;
      }

      // If customer types a product keyword while stuck, reset and let AI handle
      if (isProductQuery(messageText)) {
        stateUpdate = { state: 'GREETING', pending_product_name: null, pending_product_price: null, pending_variant: null, order_name: null, order_address: null };
        needsAI = true;
        break;
      }

      const phone = extractOrderField('phone', messageText);
      if (!phone) {
        reply = 'মোবাইল নম্বরটি সঠিকভাবে লিখুন (যেমন: ০১৭XXXXXXXX)। অর্ডার বাতিল করতে "বাদ" লিখুন।';
        break;
      }

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
        `✅ অর্ডার কনফার্ম!\n\n` +
        `👤 ${conversation.order_name}\n` +
        `📦 ${conversation.pending_product_name}${conversation.pending_variant ? ` (${conversation.pending_variant})` : ''}\n` +
        `📍 ${conversation.order_address}\n` +
        `📞 ${phone}\n` +
        `💰 পণ্য: ${conversation.pending_product_price} টাকা + ডেলিভারি: ৮০ টাকা = মোট ${total} টাকা\n\n` +
        `বিকাশ (পার্সোনাল): *${process.env.BKASH_NUMBER}*\n` +
        `পেমেন্ট করে "paid" লিখে জানান। ২-৩ কর্মদিবসে ডেলিভারি। 🛍️`;

      await notifyModerator({
        type: 'NEW_ORDER',
        order: {
          id: order.id,
          name: conversation.order_name,
          product: conversation.pending_product_name,
          total,
        },
        senderId,
      });
      break;
    }

    case 'ORDER_CONFIRM': {
      // Customer said "paid" / "পেইড" / "payment করেছি"
      const lowerText = messageText.toLowerCase();
      const paidKeywords = ['paid', 'পেইড', 'pay', 'পেমেন্ট', 'bkash', 'বিকাশ', 'send', 'পাঠিয়েছি'];
      const isPaid = paidKeywords.some(kw => lowerText.includes(kw));

      if (isPaid) {
        stateUpdate = { state: 'GREETING' }; // reset after payment confirmed
        reply = 'ধন্যবাদ! 🙏 পেমেন্ট কনফার্ম হলেই শিপমেন্ট শুরু হবে।';
        await notifyModerator({
          type: 'PAYMENT_CLAIMED',
          senderId,
          lastMessage: messageText,
        });
        break;
      }

      // Not payment-related — let AI handle (e.g. asking about another product)
      needsAI = true;
      break;
    }

    case 'HANDOFF': {
      // Human moderator should be active — this is a safety fallthrough
      // Don't respond, moderator will handle it
      await sendTypingIndicator(senderId, false);
      return;
    }

    default: {
      // GREETING, PRODUCT_SEARCH, AWAITING_CONFIRMATION, and any unknown state
      needsAI = true;
      break;
    }
  }

  // ── 7. AI path — only runs when needsAI = true ───────────────────────────────
  if (needsAI) {
    // Only query DB if the message seems product-related OR there's an image
    // This avoids querying TiDB for greetings, thanks, and other non-product messages
    let products = [];
    if (imageUrl || isProductQuery(messageText)) {
      products = await searchProducts(messageText, imageUrl);
    }

    const context = {
      state: conversation.state,
      history: conversation.message_history ?? [],
      products,
      imageUrl,
      pendingProduct: conversation.pending_product_name,
    };

    const systemPrompt = buildSystemPrompt(context);
    const aiResult = await getAIReply(
      systemPrompt,
      messageText,
      imageUrl,
      conversation.message_history ?? []
    );

    reply = aiResult.text;

    // Act on AI intent flags
    if (aiResult.intent === 'PRODUCT_FOUND' && aiResult.productName) {
      stateUpdate = {
        state: 'AWAITING_CONFIRMATION',
        pending_product_name: aiResult.productName,
        pending_product_price: aiResult.productPrice ?? null,
        pending_variant: aiResult.variant ?? null,
      };

      // Send product image if AI provided one
      if (aiResult.imageUrl) {
        try {
          await sendImageMessage(senderId, aiResult.imageUrl);
        } catch (e) {
          console.error('Failed to send product image:', e.message);
        }
      }
    } else if (aiResult.intent === 'START_ORDER') {
      stateUpdate = { state: 'COLLECT_NAME' };
    } else if (aiResult.intent === 'HANDOFF') {
      await triggerHandoff(senderId, conversation, 'AI could not resolve query');
      return;
    }
  }

  // ── 8. Persist state + history ───────────────────────────────────────────────
  // Only store if there's actual text (avoid storing empty for image-only or receipt events)
  const userEntry = messageText || (imageUrl ? '[ছবি পাঠিয়েছে]' : null);

  const newHistory = [
    ...(conversation.message_history ?? []).slice(-8), // keep last 8 turns
    ...(userEntry ? [{ role: 'user', content: userEntry, ts: Date.now() }] : []),
    { role: 'assistant', content: reply, ts: Date.now() },
  ];

  await updateConversation(senderId, {
    ...stateUpdate,
    message_history: newHistory,
    updated_at: new Date().toISOString(),
  });

  // ── 9. Send reply ────────────────────────────────────────────────────────────
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
    'একটু অপেক্ষা করুন। 🙏 আমাদের টিম এখনই আপনার সাথে যোগাযোগ করবে।'
  );

  await notifyModerator({
    type: 'HANDOFF_NEEDED',
    reason,
    senderId,
    lastMessage: conversation.message_history?.slice(-1)?.[0]?.content ?? '',
  });
}
