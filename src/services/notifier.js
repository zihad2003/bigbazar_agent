/**
 * Moderator Notifier — sends instant alerts via Telegram Bot API.
 *
 * Why Telegram: free, instant, works on mobile, no app install needed
 * beyond Telegram itself. Setup: message @BotFather, create a bot, get
 * the token, then message your bot once and fetch your chat_id from
 * https://api.telegram.org/bot<TOKEN>/getUpdates
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function notifyModerator(payload) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram not configured — skipping moderator alert');
    return;
  }

  const text = formatAlert(payload);
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    console.error('Failed to send Telegram alert:', err);
  }
}

function formatAlert(payload) {
  if (payload.type === 'HANDOFF_NEEDED') {
    const chatUrl = `https://business.facebook.com/latest/inbox/all?selected_item_id=${payload.senderId}`;
    return `\u{1F91D} <b>Handoff needed</b>\nReason: ${payload.reason}\nCustomer ID: <code>${payload.senderId}</code>\nLast message: "${payload.lastMessage}"\n\n\u2693 <a href="${chatUrl}">Open Meta Business Suite Chat</a>\nOr use the admin panel to resume bot when finished.`;
  }

  if (payload.type === 'NEW_ORDER') {
    const { order } = payload;
    return `\u{1F389} <b>New order!</b>\nName: ${order.name}\nProduct: ${order.product}\nTotal: ${order.total} taka\nCustomer ID: <code>${payload.senderId}</code>\n\nConfirm payment when received.`;
  }

  if (payload.type === 'PAYMENT_CLAIMED') {
    const pi = payload.paymentInfo || {};
    const chatUrl = `https://business.facebook.com/latest/inbox/all?selected_item_id=${payload.senderId}`;
    let msg = `\u{1F4B3} <b>Payment Claimed!</b>\nOrder ID: #${payload.orderId || 'N/A'}\nCustomer ID: <code>${payload.senderId}</code>`;

    if (pi.paymentMethod) msg += `\nMethod: ${pi.paymentMethod.toUpperCase()}`;
    if (pi.senderNumber) msg += `\nSender Number: <code>${pi.senderNumber}</code>`;
    if (pi.transactionId) msg += `\nTransaction ID: <code>${pi.transactionId}</code>`;
    if (pi.claimedAmount) msg += `\nClaimed Amount: ${pi.claimedAmount} taka`;
    if (payload.screenshotUrl) msg += `\n\n\u{1F4F8} <a href="${payload.screenshotUrl}">View Payment Screenshot</a>`;
    if (payload.lastMessage) msg += `\nMessage: "${payload.lastMessage}"`;

    msg += `\n\n\u{26A0}\u{FE0F} <b>Action Required:</b> Verify payment in your bKash/Nagad app, then mark as paid in the admin dashboard.`;
    msg += `\n\u2693 <a href="${chatUrl}">Open Chat</a>`;

    return msg;
  }

  return `\u2139\u{FE0F} ${JSON.stringify(payload)}`;
}
