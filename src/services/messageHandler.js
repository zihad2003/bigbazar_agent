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

import { getOrCreateConversation, updateConversation, getSettingCached, getOrdersBySenderId, getRelevantTrainingExamples } from './d1.js';
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

    case 'COLLECT_NAME':
    case 'COLLECT_ADDRESS':
    case 'COLLECT_PHONE': {
      // ── Shared escape logic for ALL collect states ──────────────────────────
      const lowerMsg = messageText.toLowerCase();

      // Cancel/escape keywords — Bengali, English, Banglish
      const cancelWords = [
        'না', 'cancel', 'বাদ', 'থাক', 'দরকার নেই', 'লাগবে না', 'আর না',
        'no', 'nah', 'stop', 'bad', 'thak', 'lagbe na', 'dorkar nei',
      ];
      if (cancelWords.some(w => lowerMsg.includes(w))) {
        stateUpdate = { state: 'GREETING', pending_product_name: null, pending_product_price: null, pending_variant: null, order_name: null, order_address: null };
        reply = 'ঠিক আছে, অর্ডার বাতিল করা হয়েছে। অন্য কিছু দেখতে চাইলে বলুন।';
        break;
      }

      // If customer asks a question or product query while in collect state, reset and route to AI
      if (isProductQuery(messageText)) {
        stateUpdate = { state: 'GREETING', pending_product_name: null, pending_product_price: null, pending_variant: null, order_name: null, order_address: null };
        needsAI = true;
        break;
      }

      // Detect questions, orders, and criticisms during collection states — route to AI
      const questionWords = [
        'kobe', 'কবে', 'কখন', 'when', 'কেন', 'why', 'কিভাবে', 'how', 'ki hobe', 'কী হবে',
        'pabo', 'পাবো', 'delivery', 'ডেলিভারি', 'ki', 'কী', 'কি', 'order', 'অর্ডার',
        'cai', 'চাই', 'dam', 'price', 'দাম', 'koto', 'কত', 'কোথায়', 'kothay', 'পণ্য',
        'প্রোডাক্ট', 'product', 'পছন্দ'
      ];
      if (questionWords.some(w => lowerMsg.includes(w))) {
        console.log(`⚠️ [Order Flow Escape] User sent potential query/criticism during collect state: "${messageText}". Resetting to GREETING.`);
        stateUpdate = { state: 'GREETING', pending_product_name: null, pending_product_price: null, pending_variant: null, order_name: null, order_address: null };
        needsAI = true;
        break;
      }

      // Count recent failed attempts in this state from history
      const history = conversation.message_history ?? [];
      const recentFails = history.slice(-6).filter(h => h.role === 'assistant' && (
        h.content.includes('নামটা লিখুন') || h.content.includes('ঠিকানা লিখুন') || h.content.includes('মোবাইল নম্বর')
      )).length;

      if (recentFails >= 3) {
        stateUpdate = { state: 'GREETING', pending_product_name: null, pending_product_price: null, pending_variant: null, order_name: null, order_address: null };
        reply = 'মনে হচ্ছে সমস্যা হচ্ছে। অর্ডার বাতিল করা হলো — আবার যেকোনো সময় অর্ডার দিতে পারবেন।';
        break;
      }

      // ── State-specific validation ──────────────────────────────────────────
      if (conversation.state === 'COLLECT_NAME') {
        const name = messageText;
        // Name must be 2+ chars, contain at least one Bengali or Latin letter (not pure numbers/symbols)
        const hasLetters = /[a-zA-Z\u0980-\u09FF]/.test(name);
        if (!name || name.length < 2 || !hasLetters) {
          reply = 'আপনার পুরো নামটা বাংলায় বা ইংরেজিতে লিখুন। অর্ডার বাতিল করতে "cancel" লিখুন।';
          break;
        }
        stateUpdate = { state: 'COLLECT_ADDRESS', order_name: name };
        reply = `ধন্যবাদ ${name}! এবার ডেলিভারি ঠিকানা দিন (গ্রাম/মহল্লা, থানা, জেলা)।`;
        break;
      }

      if (conversation.state === 'COLLECT_ADDRESS') {
        if (!messageText || messageText.length < 5) {
          reply = 'সম্পূর্ণ ঠিকানা লিখুন (গ্রাম, থানা, জেলা)। অর্ডার বাতিল করতে "cancel" লিখুন।';
          break;
        }
        stateUpdate = { state: 'COLLECT_PHONE', order_address: messageText };
        reply = 'ধন্যবাদ! এবার সচল মোবাইল নম্বর দিন (যেমন: ০১৭XXXXXXXX)।';
        break;
      }

      // COLLECT_PHONE
      const phone = extractOrderField('phone', messageText);
      if (!phone) {
        // Check if there are ANY digits at all — if not, it's clearly not a phone attempt
        const hasAnyDigit = /[\d০-৯]/.test(messageText);
        if (!hasAnyDigit) {
          reply = 'মোবাইল নম্বর দিন (যেমন: ০১৭XXXXXXXX)। অন্য কিছু জানতে চাইলে বা অর্ডার বাতিল করতে "cancel" লিখুন।';
        } else {
          reply = 'নম্বরটি সম্পূর্ণ নয়। ১১ ডিজিটের সঠিক নম্বর দিন (যেমন: ০১৭XXXXXXXX)।';
        }
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
        `অর্ডার কনফার্ম!\n\n` +
        `নাম: ${conversation.order_name}\n` +
        `পণ্য: ${conversation.pending_product_name}${conversation.pending_variant ? ` (${conversation.pending_variant})` : ''}\n` +
        `ঠিকানা: ${conversation.order_address}\n` +
        `মোবাইল: ${phone}\n` +
        `মোট মূল্য: পণ্য ${conversation.pending_product_price} টাকা + ডেলিভারি ৮০ টাকা = মোট ${total} টাকা\n\n` +
        `বিকাশ (পার্সোনাল): *${process.env.BKASH_NUMBER}*\n` +
        `পেমেন্ট করে "paid" লিখে জানান। ২-৩ কর্মদিবসে ডেলিভারি করা হবে।`;

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
        reply = 'ধন্যবাদ! পেমেন্ট কনফার্ম হলেই শিপমেন্ট শুরু হবে।';
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
      products = await searchProducts(messageText, imageUrl, conversation.pending_product_name);
    }

    // Fetch previous orders to customize returning customer vibe
    const pastOrders = await getOrdersBySenderId(senderId, 3);
    let customerProfile = { isReturning: false };
    if (pastOrders && pastOrders.length > 0) {
      const lastOrder = pastOrders[0];
      customerProfile = {
        isReturning: true,
        name: lastOrder.customer_name,
        lastProduct: lastOrder.product_name + (lastOrder.variant ? ` (${lastOrder.variant})` : ''),
        lastAddress: lastOrder.customer_address,
        lastPhone: lastOrder.customer_phone,
      };
    } else if (conversation.order_name) {
      customerProfile = {
        isReturning: false,
        name: conversation.order_name
      };
    }

    // Fetch training examples (moderator corrections) for relevant context
    let trainingExamples = [];
    try {
      trainingExamples = await getRelevantTrainingExamples(messageText, 3);
    } catch (e) {
      console.warn('Training examples fetch failed (table may not exist yet):', e.message);
    }

    const historySlice = (conversation.message_history ?? []).slice(-6);

    const context = {
      state: conversation.state,
      history: historySlice,
      products,
      imageUrl,
      pendingProduct: conversation.pending_product_name,
      customerProfile,
      trainingExamples,
    };

    const systemPrompt = buildSystemPrompt(context);
    const aiResult = await getAIReply(
      systemPrompt,
      messageText,
      imageUrl,
      historySlice
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
      if (conversation.pending_product_name || aiResult.productName) {
        stateUpdate = {
          state: 'COLLECT_NAME',
          // If the AI found a productName in this very turn, persist it
          pending_product_name: conversation.pending_product_name || aiResult.productName,
          pending_product_price: conversation.pending_product_price || aiResult.productPrice || null,
          pending_variant: conversation.pending_variant || aiResult.variant || null,
        };
      } else {
        stateUpdate = { state: 'GREETING' };
        reply = 'জি, আপনি কোন পণ্যটি অর্ডার করতে চান অনুগ্রহ করে বলবেন? আমাদের কালেকশনে চমৎকার শাড়ি, থ্রি-পিস ও কুর্তি রয়েছে।';
      }
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
  await sendMessage(senderId, stripEmojis(reply));
}

function stripEmojis(text) {
  if (!text) return text;
  // Strips standard emojis, symbols, and pictographs
  return text.replace(/[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F191}-\u{1F251}\u{1F680}-\u{1F6FF}\u{1F300}-\u{1F5FF}\u{1F900}-\u{1F9FF}\u{2702}-\u{27B0}\u{2190}-\u{21FF}]/gu, '').trim();
}

async function triggerHandoff(senderId, conversation, reason) {
  await updateConversation(senderId, {
    paused_by_ai: true,
    paused_reason: reason,
    state: 'HANDOFF',
  });

  await sendMessage(
    senderId,
    'একটু অপেক্ষা করুন। আমাদের টিম এখনই আপনার সাথে যোগাযোগ করবে।'
  );

  await notifyModerator({
    type: 'HANDOFF_NEEDED',
    reason,
    senderId,
    lastMessage: conversation.message_history?.slice(-1)?.[0]?.content ?? '',
  });
}
