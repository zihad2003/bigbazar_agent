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

import { getOrCreateConversation, updateConversation, getSettingCached, getOrdersBySenderId, getRelevantTrainingExamples, getActiveKnowledgeBase } from './d1.js';
import { getAIReply } from './groq.js';
import { searchProducts } from './productSearch.js';
import { saveOrder } from './orderService.js';
import { sendMessage, sendImageMessage, sendTypingIndicator } from './messenger.js';
import { notifyModerator } from './notifier.js';
import { detectHandoffIntent, extractOrderField, isProductQuery } from '../utils/nlp.js';
import { buildSystemPrompt } from '../utils/prompts.js';

const userLocks = new Map();

export async function handleMessage(event) {
  // Ignore delivery/read receipts and echo messages
  if (!event.message) return;
  if (event.message.is_echo) return;

  const senderId = event.sender.id;

  // ── Concurrency Lock ─────────────────────────────────────────────────────────
  while (userLocks.has(senderId)) {
    await userLocks.get(senderId);
  }
  let resolveLock;
  const lockPromise = new Promise(resolve => { resolveLock = resolve; });
  userLocks.set(senderId, lockPromise);

  try {
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
      case 'ORDER_CONFIRM': {
        // Customer said "paid" / "পেইড" / last digits / transaction ID
        const lowerText = messageText.toLowerCase();
        const paidKeywords = ['paid', 'পেইড', 'pay', 'পেমেন্ট', 'bkash', 'বিকাশ', 'send', 'পাঠিয়েছি'];
        const isPaid = paidKeywords.some(kw => lowerText.includes(kw)) || /[\d০-৯]{4}/.test(messageText);

        if (isPaid) {
          stateUpdate = {
            state: 'GREETING',
            pending_product_name: null,
            pending_product_price: null,
            pending_variant: null,
            order_name: null,
            order_address: null,
          };
          reply = 'ধন্যবাদ! পেমেন্ট কনফার্ম হলেই শিপমেন্ট শুরু হবে। খুব শীঘ্রই আপনার সাথে যোগাযোগ করা হবে। 😊';
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
        await sendTypingIndicator(senderId, false);
        return;
      }

      default: {
        // GREETING, AWAITING_CONFIRMATION, or any other state
        needsAI = true;
        break;
      }
    }

    // ── 7. AI path — only runs when needsAI = true ───────────────────────────────
    if (needsAI) {
      let products = [];
      if (imageUrl || isProductQuery(messageText)) {
        products = await searchProducts(messageText, imageUrl, conversation.pending_product_name);
      }

      // Fetch previous orders to customize returning customer vibe
      const pastOrders = await getOrdersBySenderId(senderId, 3);
      let customerProfile = null;
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

      // Fetch dynamic knowledge base rules
      let knowledgeBase = [];
      try {
        knowledgeBase = await getActiveKnowledgeBase();
      } catch (e) {
        console.warn('Knowledge base fetch failed:', e.message);
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
        knowledgeBase,
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
          pending_product_name: aiResult.productName,
          pending_product_price: aiResult.productPrice ?? null,
          pending_variant: aiResult.variant ?? null,
        };

        if (aiResult.imageUrl) {
          try {
            await sendImageMessage(senderId, aiResult.imageUrl);
          } catch (e) {
            console.error('Failed to send product image:', e.message);
          }
        }
      } else if (aiResult.intent === 'START_ORDER') {
        stateUpdate = {
          pending_product_name: aiResult.productName || conversation.pending_product_name || null,
          pending_product_price: aiResult.productPrice || conversation.pending_product_price || null,
          pending_variant: aiResult.variant || conversation.pending_variant || null,
        };

        reply =
          `Thank you for contacting Big Bazar! \n` +
          `✨ Assalamu Alaikum!\n\n` +
          `অর্ডার করতে \n` +
          `নাম:\n` +
          `নাম্বার :\n` +
          `ঠিকানা :\n` +
          `ডেলিভারি চার্জ সমূহ :\n` +
          `• মিরসরাই : ফ্রি \n` +
          `• চট্টগ্রাম : ১০০ টাকা \n` +
          `• সারা বাংলাদেশের: ১৫০ টাকা \n` +
          `(send money) \n\n` +
          `এবং 01877765535 এই নাম্বারে ডেলিভারি চার্জ এডবান্স করে লাস্ট ডিজিট বলুন সাথে পন্যের স্ক্রিনশট দিন।`;
      } else if (aiResult.intent === 'CONFIRM_ORDER') {
        const customerName = (aiResult.customerName || conversation.order_name || '').trim();
        const customerAddress = (aiResult.customerAddress || conversation.order_address || '').trim();
        const customerPhone = (aiResult.customerPhone || conversation.order_phone || '').trim();

        const finalProductName = conversation.pending_product_name || aiResult.productName || 'সুতি শাড়ি';
        const finalProductPrice = Number(conversation.pending_product_price || aiResult.productPrice || 1200);
        const finalVariant = conversation.pending_variant || aiResult.variant || null;

        if (!customerName || !customerAddress || !customerPhone) {
          // Fallback if AI marked CONFIRM_ORDER but missed any extraction details
          reply =
            `অর্ডারটি কনফার্ম করতে অনুগ্রহ করে নাম, মোবাইল নম্বর এবং সম্পূর্ণ ঠিকানা একসাথে দিন।\n\n` +
            `যেমন:\n` +
            `• নাম: [আপনার নাম]\n` +
            `• নাম্বার: [আপনার মোবাইল নম্বর]\n` +
            `• ঠিকানা: [আপনার সম্পূর্ণ ঠিকানা]\n\n` +
            `ধন্যবাদ!`;
        } else {
          // Calculate delivery charge based on address
          const addr = customerAddress.toLowerCase();
          let deliveryCharge = 150;
          let deliveryZone = 'সারা বাংলাদেশ';

          if (addr.includes('মিরসরাই') || addr.includes('মীরসরাই') || addr.includes('mirsharai') || addr.includes('mirsarai') || addr.includes('baraiyarhat') || addr.includes('বারইয়ারহাট')) {
            deliveryCharge = 0;
            deliveryZone = 'মীরসরাই (ফ্রি)';
          } else if (addr.includes('চট্টগ্রাম') || addr.includes('chittagong') || addr.includes('ctg')) {
            deliveryCharge = 100;
            deliveryZone = 'চট্টগ্রাম জেলা';
          }

          const total = finalProductPrice + deliveryCharge;

          // Calculate advance payment required
          let advanceAmount = deliveryCharge;
          let advanceNote = '';
          if (finalProductPrice >= 5000) {
            advanceAmount = 1000;
            advanceNote = '৫ হাজার টাকার বেশি অর্ডারে ১০০০ টাকা অগ্রিম পরিশোধ করতে হবে।';
          } else if (finalProductPrice >= 3000) {
            advanceAmount = 500;
            advanceNote = '৩ হাজার টাকার বেশি অর্ডারে ৫০০ টাকা অগ্রিম পরিশোধ করতে হবে।';
          } else {
            if (deliveryCharge > 0) {
              advanceNote = `ডেলিভারি চার্জ (${deliveryCharge} টাকা) অর্ডার কনফার্ম করার সময় অগ্রিম পরিশোধ করতে হবে।`;
            } else {
              advanceNote = 'মীরসরাইয়ের মধ্যে ডেলিভারি চার্জ ফ্রি, তাই কোনো অগ্রিম পেমেন্ট লাগবে না।';
            }
          }

          const order = await saveOrder({
            sender_id: senderId,
            name: customerName,
            address: customerAddress,
            phone: customerPhone,
            product_name: finalProductName,
            product_price: finalProductPrice,
            variant: finalVariant,
          });

          stateUpdate = {
            state: 'ORDER_CONFIRM',
            order_name: customerName,
            order_address: customerAddress,
            order_phone: customerPhone,
            pending_product_name: finalProductName,
            pending_product_price: finalProductPrice,
            pending_variant: finalVariant,
            last_order_id: order.id,
          };

          reply =
            `✨ আপনার অর্ডার কনফার্মড!\n` +
            `খুব শিগগিরই ডেলিভারির জন্য পাঠানো হবে। অনুগ্রহ করে ফোন চালু রাখুন 📞\n\n` +
            `অর্ডার বিবরণ:\n` +
            `• নাম: ${customerName}\n` +
            `• পণ্য: ${finalProductName}${finalVariant ? ` (${finalVariant})` : ''}\n` +
            `• ঠিকানা: ${customerAddress}\n` +
            `• mobile: ${customerPhone}\n` +
            `• মোট মূল্য: পণ্য ${finalProductPrice} টাকা + ডেলিভারি (${deliveryZone}) ${deliveryCharge} টাকা = মোট ${total} টাকা\n\n` +
            `📝 পেমেন্ট নির্দেশাবলী:\n` +
            `• বিকাশ (পার্সোনাল) নাম্বারে: 01877765535 (Send Money)\n` +
            `• অগ্রিম পরিশোধের পরিমাণ: *${advanceAmount}* টাকা।\n` +
            `• (${advanceNote})\n\n` +
            `টাকা পাঠিয়ে অনুগ্রহ করে লাস্ট ৪ ডিজিট বলুন সাথে পন্যের স্ক্রিনশট দিন। প্রডাক্ট হাতে পেয়ে আমাদের কোয়ালিটি রিভিউ বা ছবি দিতে ভুলবেন না 😊\n` +
            `ধন্যবাদ, Big Bazar 🌸`;

          await notifyModerator({
            type: 'NEW_ORDER',
            order: {
              id: order.id,
              name: customerName,
              product: finalProductName,
              total,
            },
            senderId,
          });
        }
      } else if (aiResult.intent === 'HANDOFF') {
        await triggerHandoff(senderId, conversation, 'AI could not resolve query');
        return;
      }
    }

    // ── 8. Persist state + history ───────────────────────────────────────────────
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
  } finally {
    // Release concurrency lock
    userLocks.delete(senderId);
    if (resolveLock) resolveLock();
  }
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
    'একটু অপেক্ষা করুন আমি দেখে জানাচ্ছি'
  );

  await notifyModerator({
    type: 'HANDOFF_NEEDED',
    reason,
    senderId,
    lastMessage: conversation.message_history?.slice(-1)?.[0]?.content ?? '',
  });
}
