/**
 * Message Handler — Conversation State Machine
 *
 * Key changes from v1:
 *  - DB (TiDB product search) is only called when message is product-related
 *  - All states explicitly handled — no unintentional fallthrough to AI
 *  - ORDER_CONFIRM / PAID state added
 *  - GREETING state handled without any DB call
 *  - Response length enforced via prompt (see utils/prompts.js)
 *
 * v2 changes:
 *  - AWAITING_ORDER_DETAILS state added for explicit order tracking
 *  - History window increased from 6→16 messages for better context retention
 *  - AI reply field changed from .text to .reply (structured JSON output)
 */

import { getOrCreateConversation, updateConversation, getSettingCached, getOrdersBySenderId, saveUnansweredQuery, updateOrderPaymentClaim, logAgentEvent, claimMessageId } from './d1.js';
import { retrieveKnowledge, retrieveTraining } from './ragRetrieve.js';
import { getAIReply } from './ai.js';
import { searchProducts } from './productSearch.js';
import { getCachedCatalog } from './catalogCache.js';
import { saveOrder, findDuplicateOrder } from './orderService.js';
import { sendMessage, sendImageMessage, sendTypingIndicator, extractMessengerMedia, fetchConversationHistory } from './messenger.js';
import { notifyModerator } from './notifier.js';
import { detectHandoffIntent, isGreetingOnly, greetingReply, isProductQuery, isPhotoRequest } from '../utils/nlp.js';
import { getProductImageUrls } from '../utils/searchNormalize.js';
import {
  resolvePhone,
  validateOrderFields,
  calculateDelivery,
  calculateAdvance,
  orderFormReply,
  missingFieldsReply,
  orderConfirmReply,
  duplicateOrderReply,
} from '../utils/orderRules.js';
import { buildSystemPrompt } from '../utils/prompts.js';

const userLocks = new Map();
const processedMids = new Map();
const processedBursts = new Map();
const MID_TTL_MS = 10 * 60 * 1000;
const BURST_TTL_MS = 12 * 1000;

function pruneProcessedMids() {
  if (processedMids.size < 500) return;
  const cutoff = Date.now() - MID_TTL_MS;
  for (const [id, ts] of processedMids) {
    if (ts < cutoff) processedMids.delete(id);
  }
  const burstCutoff = Date.now() - BURST_TTL_MS;
  for (const [id, ts] of processedBursts) {
    if (ts < burstCutoff) processedBursts.delete(id);
  }
}

function rememberMid(mid) {
  if (!mid) return;
  pruneProcessedMids();
  processedMids.set(mid, Date.now());
}

function burstKey(senderId, text, visualUrl, audioUrl) {
  return `${senderId}|${(text || '').toLowerCase()}|${visualUrl || ''}|${audioUrl || ''}`;
}

function rememberBurst(key) {
  if (!key) return;
  pruneProcessedMids();
  processedBursts.set(key, Date.now());
}

function isBurstDuplicate(key) {
  if (!key) return false;
  const ts = processedBursts.get(key);
  return !!ts && Date.now() - ts < BURST_TTL_MS;
}

function recentlyRepliedSame(history, userContent) {
  if (!userContent) return false;
  const h = history || [];
  for (let i = h.length - 1; i >= 1; i--) {
    if (h[i].role !== 'assistant' || h[i - 1].role !== 'user') continue;
    if (h[i - 1].content !== userContent) continue;
    const age = Date.now() - (h[i].ts || 0);
    return Number.isFinite(age) && age >= 0 && age < BURST_TTL_MS;
  }
  return false;
}

function productsWithPhotos(list) {
  return (list || []).filter((p) => getProductImageUrls(p)[0]);
}

async function sendProductPhotos(senderId, list, baseUrl, max = 4) {
  let sent = 0;
  for (const p of list.slice(0, max)) {
    const url = getProductImageUrls(p)[0];
    if (!url) continue;
    try {
      await sendImageMessage(senderId, url, baseUrl);
      sent += 1;
    } catch (e) {
      console.error('Failed to send catalog photo:', e.message);
    }
  }
  return sent;
}

export async function handleMessage(event, baseUrl = '') {
  // Ignore delivery/read receipts and echo messages
  if (!event.message) return;
  if (event.message.is_echo) return;

  const senderId = event.sender.id;
  const mid = event.message.mid;

  const prevLock = userLocks.get(senderId) || Promise.resolve();
  let resolveLock;
  const myLock = new Promise(resolve => { resolveLock = resolve; });
  userLocks.set(senderId, myLock);
  await prevLock;

  if (mid && processedMids.has(mid)) {
    console.log(`⏭ [Idempotency] Skipping duplicate mid ${mid}`);
    resolveLock();
    if (userLocks.get(senderId) === myLock) userLocks.delete(senderId);
    return;
  }

  let failed = false;
  try {
    rememberMid(mid);

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
    const media = extractMessengerMedia(attachments);
    const imageUrl = media.imageUrl;
    const videoUrl = media.videoUrl;
    const audioUrl = media.audioUrl;
    const visualUrl = media.visualUrl;
    const isReelShare = media.isReelShare;

    if (audioUrl) {
      console.log(`🎤 [Gemini Audio] Analyzing voice message: ${audioUrl}`);
    }

    const burst = burstKey(senderId, messageText, visualUrl, audioUrl);
    if (isBurstDuplicate(burst)) {
      console.log(`⏭ [Idempotency] Skipping burst duplicate for ${senderId}`);
      return;
    }
    rememberBurst(burst);

    if (mid && !(await claimMessageId(mid, senderId))) {
      console.log(`⏭ [Idempotency] D1 already claimed mid ${mid}`);
      return;
    }
    if (!(await claimMessageId(`burst:${burst}`, senderId, BURST_TTL_MS))) {
      console.log(`⏭ [Idempotency] D1 burst skip for ${senderId}`);
      return;
    }

    // ── 3. Load conversation state ───────────────────────────────────────────────
    const conversation = await getOrCreateConversation(senderId);
    if ((conversation.message_history || []).length < 2) {
      const prior = await fetchConversationHistory(senderId, 15);
      if (prior.length) {
        const have = new Set((conversation.message_history || []).map(m => `${m.role}:${m.content}`));
        const current = (messageText || '').trim();
        let extra = prior.filter((m) => {
          if (current && m.role === 'user' && m.content === current) return false;
          return !have.has(`${m.role}:${m.content}`);
        });
        if ((visualUrl || isReelShare) && extra.length) {
          const last = extra[extra.length - 1];
          if (last.role === 'user' && last.content === '[মিডিয়া]') extra = extra.slice(0, -1);
        }
        if (extra.length) {
          conversation.message_history = [...extra, ...(conversation.message_history || [])].slice(-20);
          console.log(`📜 [History] Hydrated ${extra.length} prior inbox turns for ${senderId}`);
        }
      }
    }
    const userContent = messageText
      || (imageUrl ? '[ছবি পাঠিয়েছে]' : videoUrl ? '[রিল/ভিডিও পাঠিয়েছে]' : isReelShare ? '[রিল শেয়ার করেছে]' : audioUrl ? '[ভয়েস মেসেজ পাঠিয়েছে]' : '');
    if (recentlyRepliedSame(conversation.message_history, userContent)) {
      console.log(`⏭ [Idempotency] Already replied to this turn for ${senderId}`);
      return;
    }
    const startedAt = Date.now();
    let products = [];
    let visual = null;
    let lastOrderId = null;

    // ── 4. Human moderator active — do nothing ───────────────────────────────────
    if (conversation.paused_by_ai) return;

    // ── 5. Handoff detection (fast, no AI needed) ────────────────────────────────
    if (detectHandoffIntent(messageText)) {
      await triggerHandoff(senderId, conversation, 'Customer requested human agent', messageText, {
        screenshotUrl: visualUrl,
        startedAt,
      });
      return;
    }

    // ── 6. State machine ─────────────────────────────────────────────────────────
    await sendTypingIndicator(senderId, true);

    let reply;
    let stateUpdate = {};
    let needsAI = false;

    switch (conversation.state) {
      case 'ORDER_CONFIRM': {
        // Customer is in payment stage — always run AI to extract payment proof
        needsAI = true;
        break;
      }

      case 'HANDOFF': {
        await sendTypingIndicator(senderId, false);
        return;
      }

      case 'AWAITING_ORDER_DETAILS': {
        // Customer is mid-order — always run AI to collect name/address/phone
        needsAI = true;
        break;
      }

      default: {
        // GREETING, AWAITING_CONFIRMATION, or any other state
        needsAI = true;
        break;
      }
    }

    // "hlw" / সালাম should not hit Gemini — it writes a shop-welcome speech.
    if (
      needsAI &&
      !visualUrl &&
      !audioUrl &&
      !isReelShare &&
      isGreetingOnly(messageText) &&
      conversation.state !== 'ORDER_CONFIRM' &&
      conversation.state !== 'AWAITING_ORDER_DETAILS'
    ) {
      reply = greetingReply(messageText, conversation.message_history);
      stateUpdate = { state: 'GREETING' };
      needsAI = false;
    }

    // ── 7. AI path — only runs when needsAI = true ───────────────────────────────
    if (needsAI) {
      const isPaymentStage = conversation.state === 'ORDER_CONFIRM';

      if (visualUrl || audioUrl || isProductQuery(messageText) || isReelShare || isPhotoRequest(messageText)) {
        try {
          if (isPaymentStage && visualUrl) {
            console.log('💳 [Search] Skipping product visual match — conversation is in payment stage');
          } else if (isReelShare && !visualUrl) {
            console.log('🎬 [Search] Reel share has no downloadable clip — ask for screenshot');
          } else {
            const searchResult = await searchProducts(messageText, visualUrl, audioUrl, conversation.pending_product_name);
            products = searchResult.products || [];
            visual = searchResult.visual || null;
          }
        } catch (dbErr) {
          console.error('⚠️ [Catalog Error] Failed to search products:', dbErr.message);
        }
      }

      let skipAi = false;
      let sentProductImage = false;

      if (isReelShare && !visualUrl) {
        reply = 'রিলটা এখান থেকে খুলতে পারছি না। একটা স্ক্রিনশট পাঠায়েন, দাম বলে দিব।';
        skipAi = true;
      } else if (videoUrl && !imageUrl && !visual?.parse) {
        reply = 'রিলটা পরিষ্কার দেখতে পাইনি। একটা স্ক্রিনশট পাঠায়েন, দাম বলে দিব।';
        skipAi = true;
      }

      if (!skipAi && visual?.kind === 'NONE' && visual.parse?.imageKind === 'product') {
        await triggerHandoff(senderId, conversation, 'Screenshot did not match catalog', messageText, {
          screenshotUrl: visualUrl,
          screenshotMatch: 'NONE',
          retrievedIds: '',
          startedAt,
        });
        return;
      }

      if (visual?.kind === 'AMBIGUOUS' && products.length >= 2) {
        for (const p of products.slice(0, 2)) {
          const url = getProductImageUrls(p)[0];
          if (!url) continue;
          try {
            await sendImageMessage(senderId, url, baseUrl);
            sentProductImage = true;
          } catch (e) {
            console.error('Failed to send clarify image:', e.message);
          }
        }
        reply = 'এই দুইটার মধ্যে কোনটা আপনার ছবির মতো? উপরেরটা নাকি নিচেরটা?';
        skipAi = true;
      }

      if (visual?.kind === 'HIGH' && products[0]) {
        stateUpdate = {
          pending_product_name: products[0].name,
          pending_product_price: Number(products[0].price) || null,
        };
        const url = getProductImageUrls(products[0])[0];
        if (url) {
          try {
            await sendImageMessage(senderId, url, baseUrl);
            sentProductImage = true;
          } catch (e) {
            console.error('Failed to send matched product image:', e.message);
          }
        }
      }

      if (!skipAi && !visualUrl && isPhotoRequest(messageText)) {
        let photoProducts = productsWithPhotos(products);
        if (!photoProducts.length && conversation.pending_product_name) {
          try {
            const pendingHit = await searchProducts(conversation.pending_product_name, null, null, null);
            photoProducts = productsWithPhotos(pendingHit.products);
          } catch (_) {}
        }
        if (!photoProducts.length) {
          photoProducts = productsWithPhotos(getCachedCatalog());
        }
        const sentCount = await sendProductPhotos(senderId, photoProducts, baseUrl, 4);
        sentProductImage = sentCount > 0;
        if (sentCount > 0) {
          const first = photoProducts[0];
          stateUpdate = {
            ...stateUpdate,
            pending_product_name: first.name,
            pending_product_price: Number(first.price) || null,
          };
          reply = sentCount === 1
            ? `${first.name}, ${first.price} টাকা। আরও দেখতে চাইলে বলেন।`
            : 'কিছু কালেকশন দিলাম। কোনটা পছন্দ হলে নাম বা নম্বর বলে দিয়েন।';
        } else {
          reply = 'এই মুহূর্তে কালেকশনের ছবি পাঠাতে পারছি না। রিল বা স্ক্রিনশট পাঠায়েন, মিলিয়ে দাম বলে দিব।';
        }
        skipAi = true;
      }

      if (!skipAi) {

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
        trainingExamples = await retrieveTraining(messageText, 3);
      } catch (e) {
        console.warn('Training retrieve failed:', e.message);
      }

      let knowledgeBase = [];
      try {
        knowledgeBase = await retrieveKnowledge(messageText, 5);
      } catch (e) {
        console.warn('Knowledge retrieve failed:', e.message);
      }

      const historySlice = (conversation.message_history ?? []).slice(-16);

      const context = {
        state: conversation.state,
        history: historySlice,
        products,
        imageUrl: visualUrl,
        audioUrl,
        pendingProduct: conversation.pending_product_name,
        customerProfile,
        trainingExamples,
        knowledgeBase,
        visualMatch: visual,
      };

      const systemPrompt = buildSystemPrompt(context);
      const aiResult = await getAIReply(
        systemPrompt,
        messageText,
        visualUrl,
        historySlice,
        audioUrl
      );

      reply = aiResult.reply;

      // Act on AI intent flags
      if (aiResult.intent === 'PRODUCT_FOUND' && aiResult.productName) {
        const grounded = visual?.kind === 'HIGH' && products[0] ? products[0] : null;
        stateUpdate = {
          pending_product_name: grounded?.name || aiResult.productName,
          pending_product_price: grounded ? Number(grounded.price) : (aiResult.productPrice ?? null),
          pending_variant: aiResult.variant ?? null,
        };

        if (!sentProductImage && aiResult.imageUrl && typeof aiResult.imageUrl === 'string' && aiResult.imageUrl.trim().toLowerCase().startsWith('http')) {
          try {
            await sendImageMessage(senderId, aiResult.imageUrl.trim(), baseUrl);
          } catch (e) {
            console.error('Failed to send product image:', e.message);
          }
        }
      } else if (aiResult.intent === 'START_ORDER') {
        const alreadyCollecting = conversation.state === 'AWAITING_ORDER_DETAILS';
        stateUpdate = {
          state: 'AWAITING_ORDER_DETAILS',
          pending_product_name: aiResult.productName || conversation.pending_product_name || null,
          pending_product_price: aiResult.productPrice || conversation.pending_product_price || null,
          pending_variant: aiResult.variant || conversation.pending_variant || null,
        };

        // Only send the order form the first time — repeating it on every
        // follow-up question (fabric, price, other page) sounds robotic.
        if (!alreadyCollecting && !aiResult.reply.includes('নাম:')) {
          reply = `${aiResult.reply}\n\n${orderFormReply()}`;
        } else {
          reply = aiResult.reply;
        }
      } else if (aiResult.intent === 'CONFIRM_ORDER') {
        const customerName = (aiResult.customerName || conversation.order_name || '').trim();
        const customerAddress = (aiResult.customerAddress || conversation.order_address || '').trim();
        const customerPhone = resolvePhone(aiResult.customerPhone, conversation.order_phone, messageText);

        const finalProductName = conversation.pending_product_name || aiResult.productName;
        const finalProductPrice = Number(conversation.pending_product_price || aiResult.productPrice);
        const finalVariant = conversation.pending_variant || aiResult.variant || null;

        const checked = validateOrderFields({
          name: customerName,
          address: customerAddress,
          phone: customerPhone,
          productName: finalProductName,
          productPrice: finalProductPrice,
        });

        if (checked.errors.includes('product') || checked.errors.includes('price')) {
          reply = 'আপনি কোন প্রোডাক্টটি অর্ডার করতে চাচ্ছেন একটু বলবেন? সঠিক দাম মিলিয়ে তারপর কনফার্ম করব।';
          stateUpdate = {
            state: 'AWAITING_ORDER_DETAILS',
            order_name: customerName || null,
            order_address: customerAddress || null,
            order_phone: customerPhone || null,
          };
        } else if (!checked.ok) {
          reply = missingFieldsReply(checked.errors);
          stateUpdate = {
            state: 'AWAITING_ORDER_DETAILS',
            order_name: checked.name || customerName || null,
            order_address: checked.address || customerAddress || null,
            order_phone: customerPhone || conversation.order_phone || null,
          };
        } else {
          const dup = await findDuplicateOrder(senderId, finalProductName);
          if (dup) {
            reply = duplicateOrderReply(dup.id);
            stateUpdate = {
              state: 'ORDER_CONFIRM',
              last_order_id: dup.id,
              order_name: checked.name,
              order_address: checked.address,
              order_phone: checked.phone,
              pending_product_name: finalProductName,
              pending_product_price: checked.productPrice,
              pending_variant: finalVariant,
            };
          } else {
            const delivery = calculateDelivery(checked.address);
            const advance = calculateAdvance(checked.productPrice, delivery.charge);
            const total = checked.productPrice + delivery.charge;

            const order = await saveOrder({
              sender_id: senderId,
              name: checked.name,
              address: checked.address,
              phone: checked.phone,
              product_name: finalProductName,
              product_price: checked.productPrice,
              variant: finalVariant,
              delivery_charge: delivery.charge,
              delivery_zone: delivery.zone,
              advance_amount: advance.amount,
              total_amount: total,
              webhook_mid: mid || null,
            });
            lastOrderId = order.id;

            stateUpdate = {
              state: 'ORDER_CONFIRM',
              order_name: checked.name,
              order_address: checked.address,
              order_phone: checked.phone,
              pending_product_name: finalProductName,
              pending_product_price: checked.productPrice,
              pending_variant: finalVariant,
              last_order_id: order.id,
            };

            reply = orderConfirmReply({
              name: checked.name,
              product: finalProductName,
              variant: finalVariant,
              address: checked.address,
              phone: checked.phone,
              productPrice: checked.productPrice,
              delivery,
              advance,
              total,
            });

            await notifyModerator({
              type: 'NEW_ORDER',
              order: {
                id: order.id,
                name: checked.name,
                product: finalProductName,
                total,
              },
              senderId,
            });
          }
        }
      } else if (aiResult.intent === 'HANDOFF') {
        if (isPhotoRequest(messageText) && !visualUrl) {
          reply = aiResult.reply && !/অপেক্ষা/i.test(aiResult.reply)
            ? aiResult.reply
            : 'রিল বা স্ক্রিনশট পাঠায়েন, মিলিয়ে দাম বলে দিব।';
        } else {
          await triggerHandoff(senderId, conversation, 'AI could not resolve query', messageText, {
            screenshotUrl: visualUrl,
            botDraft: aiResult.reply,
            screenshotMatch: visual?.kind || null,
            retrievedIds: (products || []).map(p => p.id).filter(Boolean).join(',') || null,
            startedAt,
          });
          return;
        }
      }

      // ── Payment Claim Extraction ─────────────────────────────────────────
      // If AI extracted paymentInfo and there's an existing order, update it
      if (aiResult.paymentInfo && conversation.last_order_id) {
        try {
          await updateOrderPaymentClaim(conversation.last_order_id, {
            payment_method: aiResult.paymentInfo.paymentMethod,
            sender_number: aiResult.paymentInfo.senderNumber,
            transaction_id: aiResult.paymentInfo.transactionId,
            claimed_amount: aiResult.paymentInfo.claimedAmount,
            screenshot_url: visualUrl || null,
          });
          console.log(`💳 [Payment Claim] Order #${conversation.last_order_id} updated with payment claim. Status → pending_verification`);

          // Notify moderator about the payment claim
          await notifyModerator({
            type: 'PAYMENT_CLAIMED',
            senderId,
            orderId: conversation.last_order_id,
            paymentInfo: aiResult.paymentInfo,
            screenshotUrl: visualUrl || null,
            lastMessage: messageText,
          });

          // Reset conversation state after payment claim is captured
          stateUpdate = {
            state: 'GREETING',
            pending_product_name: null,
            pending_product_price: null,
            pending_variant: null,
            order_name: null,
            order_address: null,
            order_phone: null,
          };
        } catch (err) {
          console.error('Failed to update payment claim:', err.message);
        }
      }
      } // skipAi
    }

    // ── 8. Send first, then persist (failed send is not logged as a reply)
    await sendTypingIndicator(senderId, false);
    const outgoing = stripEmojis(reply);
    if (outgoing) {
      await sendMessage(senderId, outgoing);
    } else {
      console.warn(`⚠️ Empty reply skipped for PSID ${senderId}`);
    }

    const userEntry = messageText
      || (imageUrl ? '[ছবি পাঠিয়েছে]' : videoUrl ? '[রিল/ভিডিও পাঠিয়েছে]' : isReelShare ? '[রিল শেয়ার করেছে]' : audioUrl ? '[ভয়েস মেসেজ পাঠিয়েছে]' : null);

    const newHistory = [
      ...(conversation.message_history ?? []).slice(-18),
      ...(userEntry ? [{ role: 'user', content: userEntry, ts: Date.now() }] : []),
      ...(outgoing ? [{ role: 'assistant', content: outgoing, ts: Date.now() }] : []),
    ];

    await updateConversation(senderId, {
      ...stateUpdate,
      message_history: newHistory,
      updated_at: new Date().toISOString(),
    });

    await logAgentEvent({
      sender_id: senderId,
      reply_ms: Date.now() - startedAt,
      screenshot_match: visual?.kind || null,
      retrieved_ids: (products || []).map(p => p.id).filter(Boolean).join(',') || null,
      handoff: 0,
      order_id: lastOrderId,
    });
  } catch (err) {
    failed = true;
    await sendTypingIndicator(senderId, false).catch(() => {});
    throw err;
  } finally {
    if (!failed) rememberMid(mid);
    resolveLock();
    if (userLocks.get(senderId) === myLock) userLocks.delete(senderId);
  }
}

function stripEmojis(text) {
  if (!text) return text;
  // Strips standard emojis, symbols, and pictographs
  return text.replace(/[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F191}-\u{1F251}\u{1F680}-\u{1F6FF}\u{1F300}-\u{1F5FF}\u{1F900}-\u{1F9FF}\u{2702}-\u{27B0}\u{2190}-\u{21FF}]/gu, '').trim();
}

async function triggerHandoff(senderId, conversation, reason, currentMessage = '', extras = {}) {
  const lastMessage = currentMessage || conversation.message_history?.slice(-1)?.[0]?.content || '';
  const lastAssistant = [...(conversation.message_history || [])].reverse().find(m => m.role === 'assistant');
  const botDraft = extras.botDraft || lastAssistant?.content || null;
  const screenshotUrl = extras.screenshotUrl || null;
  const retrievedIds = extras.retrievedIds || null;
  const screenshotMatch = extras.screenshotMatch || null;

  await sendTypingIndicator(senderId, false);

  try {
    await sendMessage(senderId, 'একটু অপেক্ষা করুন আমি দেখে জানাচ্ছি');
  } catch (e) {
    console.error('Handoff send failed:', e.message);
  }

  await updateConversation(senderId, {
    paused_by_ai: true,
    paused_reason: reason,
    state: 'HANDOFF',
  });

  try {
    await saveUnansweredQuery({
      senderId,
      customerMessage: lastMessage || 'Missing product info / handoff requested',
      botDraft,
      screenshotUrl,
      reason,
      retrievedIds,
      screenshotMatch,
    });
  } catch (e) {
    console.warn('Failed to log unanswered query:', e.message);
  }

  await logAgentEvent({
    sender_id: senderId,
    reply_ms: extras.startedAt ? Date.now() - extras.startedAt : null,
    screenshot_match: screenshotMatch,
    retrieved_ids: retrievedIds,
    handoff: 1,
    order_id: null,
  });

  await notifyModerator({
    type: 'HANDOFF_NEEDED',
    reason,
    senderId,
    lastMessage,
    screenshotUrl,
    botDraft,
  });
}
