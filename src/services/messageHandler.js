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
import { detectHandoffIntent, isGreetingOnly, greetingReply, isProductQuery, isPhotoRequest, isWantThisProduct, isPaymentProof, extractPaymentRef, extractOrderDetails, isShowMoreRequest, isSizeQuestion, isTotalQuestion, isDeliveryQuestion, isBargain, extractDeliveryHint, extractQuantity } from '../utils/nlp.js';
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
  resolveQty,
  lineTotal,
  quoteOrderTotal,
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

function looksLikeOrderDetails(text, parsed) {
  if (parsed?.phone && (parsed.name || parsed.address)) return true;
  if (!text) return false;
  return /নাম\s*[:\-=]\s*\S+/i.test(text) && /(?:মোবাইল|মো|phone)\s*[:\-=]?\s*\S+/i.test(text);
}

function formatSizes(sizes) {
  if (!sizes) return '';
  if (Array.isArray(sizes)) return sizes.filter(Boolean).join(', ');
  const raw = String(sizes).trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).join(', ');
  } catch (_) {}
  return raw.replace(/[\[\]"]/g, '').trim();
}

function salesFollowup(conversation, messageText) {
  const pending = conversation.pending_product_name;
  const unit = Number(conversation.pending_product_price) || 0;
  if (!pending || !messageText) return null;

  const qtyIn = extractQuantity(messageText);
  const hintIn = extractDeliveryHint(messageText);
  const qty = resolveQty(qtyIn, conversation.pending_qty);
  const hint = hintIn || conversation.pending_address_hint || conversation.order_address || null;
  const patch = {
    pending_product_name: pending,
    pending_product_price: unit || conversation.pending_product_price,
    pending_variant: conversation.pending_variant,
  };
  if (qtyIn) patch.pending_qty = qtyIn;
  if (hintIn) patch.pending_address_hint = hintIn;

  if (qtyIn && unit) {
    const sub = lineTotal(unit, qty);
    return {
      reply: `${qty}টা ${pending} রাখলাম, ${sub} টাকা। নাম, মোবাইল আর ঠিকানা একসাথে পাঠায়েন।`,
      stateUpdate: { ...patch, state: conversation.state === 'ORDER_CONFIRM' ? conversation.state : 'AWAITING_ORDER_DETAILS' },
    };
  }

  if (isBargain(messageText) && unit) {
    const quoted = quoteOrderTotal({ productName: pending, unitPrice: unit, qty, addressHint: hint });
    return {
      reply: `দাম কমানো যাবে না। ${quoted}`,
      stateUpdate: patch,
    };
  }

  if (isTotalQuestion(messageText) && unit) {
    return {
      reply: quoteOrderTotal({ productName: pending, unitPrice: unit, qty, addressHint: hint }),
      stateUpdate: patch,
    };
  }

  if (isDeliveryQuestion(messageText)) {
    if (hint) {
      const delivery = calculateDelivery(hint);
      return {
        reply: `${delivery.zone}-এ ডেলিভারি ${delivery.charge} টাকা।`,
        stateUpdate: patch,
      };
    }
    return {
      reply: 'মীরসরাই ফ্রি, চট্টগ্রাম ১০০, দেশে ১৫০ টাকা।',
      stateUpdate: patch,
    };
  }

  return null;
}

async function completeOrderIfPossible({
  senderId,
  conversation,
  messageText,
  parsed,
  aiResult,
  mid,
}) {
  const customerName = (parsed?.name || aiResult?.customerName || conversation.order_name || '').trim();
  const customerAddress = (parsed?.address || aiResult?.customerAddress || conversation.order_address || '').trim();
  const customerPhone = resolvePhone(
    parsed?.phone || aiResult?.customerPhone,
    conversation.order_phone,
    messageText
  );

  const unitName = conversation.pending_product_name || aiResult?.productName;
  const unitPrice = Number(conversation.pending_product_price || aiResult?.productPrice);
  const qty = resolveQty(conversation.pending_qty, extractQuantity(messageText));
  const finalProductName = qty > 1 ? `${unitName} × ${qty}` : unitName;
  const finalProductPrice = lineTotal(unitPrice, qty);
  const finalVariant = conversation.pending_variant || aiResult?.variant || null;

  const checked = validateOrderFields({
    name: customerName,
    address: customerAddress,
    phone: customerPhone,
    productName: finalProductName,
    productPrice: finalProductPrice,
  });

  if (checked.errors.includes('product') || checked.errors.includes('price')) {
    return {
      reply: 'আপনি কোন প্রোডাক্টটি অর্ডার করতে চাচ্ছেন একটু বলবেন? সঠিক দাম মিলিয়ে তারপর কনফার্ম করব।',
      stateUpdate: {
        state: 'AWAITING_ORDER_DETAILS',
        order_name: customerName || null,
        order_address: customerAddress || null,
        order_phone: customerPhone || null,
      },
      lastOrderId: null,
      completed: false,
    };
  }

  if (!checked.ok) {
    return {
      reply: missingFieldsReply(checked.errors),
      stateUpdate: {
        state: 'AWAITING_ORDER_DETAILS',
        order_name: checked.name || customerName || null,
        order_address: checked.address || customerAddress || null,
        order_phone: customerPhone || conversation.order_phone || null,
      },
      lastOrderId: null,
      completed: false,
    };
  }

  const dup = await findDuplicateOrder(senderId, finalProductName);
  if (dup) {
    return {
      reply: duplicateOrderReply(dup.id),
      stateUpdate: {
        state: 'ORDER_CONFIRM',
        last_order_id: dup.id,
        order_name: checked.name,
        order_address: checked.address,
        order_phone: checked.phone,
        pending_product_name: unitName,
        pending_qty: qty,
        pending_product_price: unitPrice,
        pending_variant: finalVariant,
      },
      lastOrderId: dup.id,
      completed: true,
    };
  }

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

  return {
    reply: orderConfirmReply({
      name: checked.name,
      product: finalProductName,
      variant: finalVariant,
      address: checked.address,
      phone: checked.phone,
      productPrice: checked.productPrice,
      delivery,
      advance,
      total,
    }),
    stateUpdate: {
      state: 'ORDER_CONFIRM',
      order_name: checked.name,
      order_address: checked.address,
      order_phone: checked.phone,
      pending_product_name: unitName,
      pending_product_price: unitPrice,
      pending_variant: finalVariant,
      pending_qty: qty,
      last_order_id: order.id,
    },
    lastOrderId: order.id,
    completed: true,
  };
}

async function capturePaymentClaim({ senderId, conversation, messageText, visualUrl, aiResult }) {
  const ref = extractPaymentRef(messageText) || aiResult?.paymentInfo?.transactionId || null;
  const orderId = conversation.last_order_id;
  if (!orderId) {
    return {
      reply: 'বিকাশে পাঠিয়ে লাস্ট ৪ ডিজিট বা ট্রানজেকশন আইডি দিন।',
      stateUpdate: {},
    };
  }
  if (!ref && !visualUrl && !aiResult?.paymentInfo) {
    return {
      reply: 'বিকাশে পাঠিয়ে লাস্ট ৪ ডিজিট বা ট্রানজেকশন আইডি দিন।',
      stateUpdate: {},
    };
  }

  await updateOrderPaymentClaim(orderId, {
    payment_method: aiResult?.paymentInfo?.paymentMethod || 'bkash',
    sender_number: aiResult?.paymentInfo?.senderNumber || null,
    transaction_id: ref,
    claimed_amount: aiResult?.paymentInfo?.claimedAmount || null,
    screenshot_url: visualUrl || null,
  });
  await notifyModerator({
    type: 'PAYMENT_CLAIMED',
    senderId,
    orderId,
    paymentInfo: aiResult?.paymentInfo || { transactionId: ref, paymentMethod: 'bkash' },
    screenshotUrl: visualUrl || null,
    lastMessage: messageText,
  });

  return {
    reply: 'ট্রানজেকশন তথ্য পেয়েছি। পেমেন্ট যাচাই হলে জানানো হবে।',
    stateUpdate: {
      state: 'GREETING',
      pending_product_name: null,
      pending_product_price: null,
      pending_variant: null,
      order_name: null,
      order_address: null,
      order_phone: null,
    },
  };
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
        if (conversation.pending_product_name) {
          reply = `এই ছবিটা মিলাতে পারিনি। ${conversation.pending_product_name} টাই নেবেন?`;
          skipAi = true;
        } else {
          await triggerHandoff(senderId, conversation, 'Screenshot did not match catalog', messageText, {
            screenshotUrl: visualUrl,
            screenshotMatch: 'NONE',
            retrievedIds: '',
            startedAt,
          });
          return;
        }
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
        if (!isPaymentStage) {
          reply = `${products[0].name}, ${products[0].price} টাকা।`;
          skipAi = true;
        }
      }

      if (!skipAi && !visualUrl && (isShowMoreRequest(messageText) || isPhotoRequest(messageText))) {
        const showMore = isShowMoreRequest(messageText);
        let photoProducts = productsWithPhotos(products);
        if (!photoProducts.length && conversation.pending_product_name && !showMore) {
          try {
            const pendingHit = await searchProducts(conversation.pending_product_name, null, null, null);
            photoProducts = productsWithPhotos(pendingHit.products);
          } catch (_) {}
        }
        if (!photoProducts.length || showMore) {
          const catalogPhotos = productsWithPhotos(getCachedCatalog());
          if (showMore && conversation.pending_product_name) {
            const pendingName = String(conversation.pending_product_name).toLowerCase();
            const others = catalogPhotos.filter((p) => String(p.name || '').toLowerCase() !== pendingName);
            photoProducts = others.length ? others : catalogPhotos;
          } else if (!photoProducts.length) {
            photoProducts = catalogPhotos;
          }
        }
        const sentCount = await sendProductPhotos(senderId, photoProducts, baseUrl, 4);
        sentProductImage = sentCount > 0;
        if (sentCount > 0) {
          if (!showMore && !conversation.pending_product_name) {
            const first = photoProducts[0];
            stateUpdate = {
              ...stateUpdate,
              pending_product_name: first.name,
              pending_product_price: Number(first.price) || null,
            };
          }
          reply = sentCount === 1
            ? `${photoProducts[0].name}, ${photoProducts[0].price} টাকা। আরও দেখতে চাইলে বলেন।`
            : 'কিছু কালেকশন দিলাম। কোনটা পছন্দ হলে নাম বা নম্বর বলে দিয়েন।';
        } else {
          reply = conversation.pending_product_name
            ? `এই মুহূর্তে আর ছবি নাই। ${conversation.pending_product_name} টাই নেবেন?`
            : 'এই মুহূর্তে কালেকশনের ছবি পাঠাতে পারছি না। রিল বা স্ক্রিনশট পাঠায়েন, মিলিয়ে দাম বলে দিব।';
        }
        skipAi = true;
      }

      if (!skipAi && isSizeQuestion(messageText) && (products[0] || conversation.pending_product_name)) {
        const p = products[0];
        const sizes = formatSizes(p?.sizes);
        reply = sizes
          ? `সাইজ আছে: ${sizes}।`
          : 'সাইজ ক্যাটালগে লেখা নাই। অর্ডারের সময় কোন সাইজ লাগবে বলে দিয়েন।';
        skipAi = true;
      }

      if (!skipAi && conversation.pending_product_name) {
        const follow = salesFollowup(conversation, messageText);
        if (follow) {
          reply = follow.reply;
          stateUpdate = { ...stateUpdate, ...follow.stateUpdate };
          skipAi = true;
        }
      }

      if (
        !skipAi
        && !visualUrl
        && conversation.pending_product_name
        && isWantThisProduct(messageText)
        && !extractOrderDetails(messageText).phone
      ) {
        const alreadyCollecting = conversation.state === 'AWAITING_ORDER_DETAILS';
        if (conversation.state === 'ORDER_CONFIRM') {
          reply = 'অর্ডারটা নেওয়া আছে। বিকাশে টাকা পাঠিয়ে ট্রানজেকশন আইডি দিন।';
        } else {
          stateUpdate = {
            state: 'AWAITING_ORDER_DETAILS',
            pending_product_name: conversation.pending_product_name,
            pending_product_price: conversation.pending_product_price,
            pending_variant: conversation.pending_variant,
          };
          reply = alreadyCollecting
            ? 'নাম, মোবাইল আর সম্পূর্ণ ঠিকানা একসাথে পাঠায়েন।'
            : orderFormReply();
        }
        skipAi = true;
      }

      if (
        !skipAi
        && visualUrl
        && conversation.pending_product_name
        && !visual?.kind
        && !isPaymentStage
      ) {
        reply = `${conversation.pending_product_name}, ${conversation.pending_product_price} টাকা। এইটাই নেবেন?`;
        skipAi = true;
      }

      const inPayment = conversation.state === 'ORDER_CONFIRM' || !!conversation.last_order_id;
      if (
        !skipAi
        && inPayment
        && (isPaymentProof(messageText) || extractPaymentRef(messageText) || (visualUrl && isPaymentStage))
      ) {
        try {
          const claimed = await capturePaymentClaim({
            senderId,
            conversation,
            messageText,
            visualUrl,
            aiResult: null,
          });
          reply = claimed.reply;
          stateUpdate = { ...stateUpdate, ...claimed.stateUpdate };
        } catch (err) {
          console.error('Failed to update payment claim:', err.message);
          reply = 'পেমেন্ট তথ্য নিতে সমস্যা হচ্ছে। আবার ট্রানজেকশন আইডি পাঠায়েন।';
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

      const parsed = extractOrderDetails(messageText);
      const collecting = conversation.state === 'AWAITING_ORDER_DETAILS' || conversation.state === 'ORDER_CONFIRM';
      const hasDetails = looksLikeOrderDetails(messageText, parsed);
      const paymentNow = conversation.state === 'ORDER_CONFIRM' || !!conversation.last_order_id;

      if (paymentNow && (aiResult.paymentInfo || isPaymentProof(messageText) || extractPaymentRef(messageText))) {
        try {
          const claimed = await capturePaymentClaim({
            senderId,
            conversation,
            messageText,
            visualUrl,
            aiResult,
          });
          reply = claimed.reply;
          stateUpdate = { ...stateUpdate, ...claimed.stateUpdate };
        } catch (err) {
          console.error('Failed to update payment claim:', err.message);
          reply = 'পেমেন্ট তথ্য নিতে সমস্যা হচ্ছে। আবার ট্রানজেকশন আইডি পাঠায়েন।';
        }
      } else if (
        (aiResult.intent === 'CONFIRM_ORDER' || hasDetails || (collecting && (parsed.name || parsed.phone || parsed.address)))
        && (conversation.pending_product_name || aiResult.productName)
        && !paymentNow
      ) {
        const result = await completeOrderIfPossible({
          senderId,
          conversation,
          messageText,
          parsed,
          aiResult,
          mid,
        });
        reply = result.reply;
        stateUpdate = { ...stateUpdate, ...result.stateUpdate };
        lastOrderId = result.lastOrderId;
      } else if (aiResult.intent === 'PRODUCT_FOUND' && aiResult.productName) {
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
        if (paymentNow) {
          reply = 'অর্ডারটা নেওয়া আছে। বিকাশে টাকা পাঠিয়ে ট্রানজেকশন আইডি দিন।';
        } else {
          const alreadyCollecting = conversation.state === 'AWAITING_ORDER_DETAILS';
          stateUpdate = {
            state: 'AWAITING_ORDER_DETAILS',
            pending_product_name: aiResult.productName || conversation.pending_product_name || null,
            pending_product_price: aiResult.productPrice || conversation.pending_product_price || null,
            pending_variant: aiResult.variant || conversation.pending_variant || null,
            order_name: parsed.name || conversation.order_name || null,
            order_address: parsed.address || conversation.order_address || null,
            order_phone: parsed.phone || conversation.order_phone || null,
          };

          if (alreadyCollecting || /নাম\s*:/i.test(aiResult.reply || '')) {
            const follow = salesFollowup(conversation, messageText);
            reply = follow
              ? follow.reply
              : (alreadyCollecting
                ? 'নাম, মোবাইল আর সম্পূর্ণ ঠিকানা একসাথে পাঠায়েন।'
                : aiResult.reply);
            if (follow) stateUpdate = { ...stateUpdate, ...follow.stateUpdate };
          } else {
            reply = `${aiResult.reply}\n\n${orderFormReply()}`;
          }
        }
      } else if (aiResult.intent === 'HANDOFF') {
        if (isPhotoRequest(messageText) && !visualUrl) {
          reply = aiResult.reply && !/অপেক্ষা/i.test(aiResult.reply)
            ? aiResult.reply
            : 'রিল বা স্ক্রিনশট পাঠায়েন, মিলিয়ে দাম বলে দিব।';
        } else if (conversation.pending_product_name && isWantThisProduct(messageText)) {
          reply = orderFormReply();
          stateUpdate = {
            state: 'AWAITING_ORDER_DETAILS',
            pending_product_name: conversation.pending_product_name,
            pending_product_price: conversation.pending_product_price,
            pending_variant: conversation.pending_variant,
          };
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

      if (/কারিগরি সমস্যা/.test(reply || '') && conversation.pending_product_name) {
        reply = isWantThisProduct(messageText)
          ? orderFormReply()
          : `${conversation.pending_product_name}, ${conversation.pending_product_price} টাকা। এইটাই নেবেন?`;
        if (isWantThisProduct(messageText)) {
          stateUpdate = {
            state: 'AWAITING_ORDER_DETAILS',
            pending_product_name: conversation.pending_product_name,
            pending_product_price: conversation.pending_product_price,
            pending_variant: conversation.pending_variant,
          };
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
