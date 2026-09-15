/**
 * Deterministic order rules — server is the source of truth for money and contact fields.
 */
import { extractOrderField } from './nlp.js';

export const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

export function getBkashNumber() {
  const n = (process.env.BKASH_NUMBER || '01877765535').replace(/\s/g, '');
  return n || '01877765535';
}

export function resolvePhone(aiPhone, conversationPhone, messageText) {
  return (
    extractOrderField('phone', aiPhone || '') ||
    extractOrderField('phone', messageText || '') ||
    extractOrderField('phone', conversationPhone || '') ||
    null
  );
}

export function validateOrderFields({ name, address, phone, productName, productPrice }) {
  const errors = [];
  const trimmedName = (name || '').trim();
  const trimmedAddr = (address || '').trim();
  const resolvedPhone = extractOrderField('phone', phone || '');
  const price = Number(productPrice);

  if (!productName || String(productName).trim().length < 2) errors.push('product');
  if (!Number.isFinite(price) || price <= 0) errors.push('price');
  if (trimmedName.length < 2 || /^\d+$/.test(trimmedName)) errors.push('name');
  if (trimmedAddr.length < 8) errors.push('address');
  if (!resolvedPhone) errors.push('phone');

  return {
    ok: errors.length === 0,
    errors,
    name: trimmedName,
    address: trimmedAddr,
    phone: resolvedPhone,
    productPrice: price,
  };
}

export function calculateDelivery(address) {
  const addr = (address || '').toLowerCase();
  if (/(মিরসরাই|মীরসরাই|mirsharai|mirsarai|baraiyarhat|বারইয়ারহাট|বারইয়ারহাট)/i.test(addr)) {
    return { charge: 0, zone: 'মীরসরাই (ফ্রি)' };
  }
  if (/(sitakund|সীতাকুণ্ড|সিতাকুন্ড|সীতাকুন্ড|hathazari|হাটহাজারী|হাতহাজারী|রাউজান|raozan|পটিয়া|পটিয়া|pati[uy]a)/i.test(addr)) {
    return { charge: 100, zone: 'চট্টগ্রাম জেলা' };
  }
  if (/(চট্টগ্রাম|chittagong|chattogram|ctg)/i.test(addr)) {
    return { charge: 100, zone: 'চট্টগ্রাম জেলা' };
  }
  return { charge: 150, zone: 'সারা বাংলাদেশ' };
}

export function resolveQty(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 20) return Math.floor(n);
  }
  return 1;
}

export function lineTotal(unitPrice, qty) {
  return (Number(unitPrice) || 0) * resolveQty(qty);
}

export function quoteOrderTotal({ productName, unitPrice, qty, addressHint }) {
  const q = resolveQty(qty);
  const sub = lineTotal(unitPrice, q);
  const name = productName || 'পণ্য';
  if (addressHint) {
    const delivery = calculateDelivery(addressHint);
    const total = sub + delivery.charge;
    return `${q}টা ${name} ${sub} + ডেলিভারি (${delivery.zone}) ${delivery.charge} = ${total} টাকা।`;
  }
  return `${q}টা ${name} ${sub} টাকা। মীরসরাই ফ্রি, চট্টগ্রাম ১০০, দেশে ১৫০। ঠিকানা বললে মোট বলব।`;
}

export function calculateAdvance(productPrice, deliveryCharge) {
  const price = Number(productPrice) || 0;
  if (price >= 5000) {
    return { amount: 1000, note: '৫ হাজার টাকার বেশি অর্ডারে ১০০০ টাকা অগ্রিম পরিশোধ করতে হবে।' };
  }
  if (price >= 3000) {
    return { amount: 500, note: '৩ হাজার টাকার বেশি অর্ডারে ৫০০ টাকা অগ্রিম পরিশোধ করতে হবে।' };
  }
  if (deliveryCharge > 0) {
    return {
      amount: deliveryCharge,
      note: `ডেলিভারি চার্জ (${deliveryCharge} টাকা) অর্ডার কনফার্ম করার সময় অগ্রিম পরিশোধ করতে হবে।`,
    };
  }
  return { amount: 0, note: 'মীরসরাইয়ের মধ্যে ডেলিভারি চার্জ ফ্রি, তাই কোনো অগ্রিম পেমেন্ট লাগবে না।' };
}

export function orderFormReply() {
  return (
    `অর্ডার করতে নাম, মোবাইল আর ঠিকানা একসাথে পাঠায়েন:\n` +
    `নাম:\nমোবাইল:\nঠিকানা:\n\n` +
    `মীরসরাই ফ্রি, চট্টগ্রাম ১০০, দেশে ১৫০ টাকা।`
  );
}

export function missingFieldsReply(errors) {
  if (errors.includes('phone') && errors.length === 1) {
    return 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন। যেমন: 01XXXXXXXXX';
  }
  return (
    `অর্ডার করতে নাম, সঠিক মোবাইল (01X...) আর সম্পূর্ণ ঠিকানা লাগবে।\n\n` +
    `নাম:\nমোবাইল:\nঠিকানা:`
  );
}

export function orderConfirmReply({
  name, product, variant, address, phone, productPrice, delivery, advance, total,
}) {
  const bkash = getBkashNumber();
  const pay = advance.amount > 0
    ? `বিকাশ (পার্সোনাল) ${bkash}-এ Send Money করে ${advance.amount} টাকা অগ্রিম পাঠান। ${advance.note}\nটাকা পাঠিয়ে লাস্ট ৪ ডিজিট আর পণ্যের স্ক্রিনশট দিন। পেমেন্ট যাচাই হলে জানানো হবে।`
    : `${advance.note}\nপেমেন্ট যাচাইয়ের আগে কনফার্ম ধরবেন না।`;

  return (
    `আপনার অর্ডার কনফার্ম হয়েছে। ফোন চালু রাখুন।\n\n` +
    `নাম: ${name}\n` +
    `পণ্য: ${product}${variant ? ` (${variant})` : ''}\n` +
    `ঠিকানা: ${address}\n` +
    `মোবাইল: ${phone}\n` +
    `মোট: পণ্য ${productPrice} + ডেলিভারি (${delivery.zone}) ${delivery.charge} = ${total} টাকা\n\n` +
    `${pay}\nধন্যবাদ, বিগ বাজার।`
  );
}

export function duplicateOrderReply(orderId) {
  return `এই পণ্যের অর্ডার ইতিমধ্যে নেওয়া আছে (অর্ডার #${orderId})। নতুন করে আবার বুক হয়নি। পেমেন্ট করে লাস্ট ৪ ডিজিট পাঠাতে পারেন।`;
}

export function parseCreatedAt(value) {
  if (!value) return NaN;
  const s = String(value).trim();
  if (s.includes('T')) return Date.parse(s);
  return Date.parse(`${s.replace(' ', 'T')}Z`);
}

export function isDuplicateOrder(existing, { productName, now = Date.now() }) {
  if (!existing) return false;
  if (existing.product_name !== productName) return false;
  const pending = ['pending_payment', 'pending_verification'].includes(existing.status);
  if (!pending) return false;
  const created = parseCreatedAt(existing.created_at);
  if (!Number.isFinite(created)) return true;
  return now - created <= DUPLICATE_WINDOW_MS;
}
