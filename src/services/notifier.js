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
    return `🤝 <b>Handoff needed</b>\nReason: ${payload.reason}\nCustomer ID: ${payload.senderId}\nLast message: "${payload.lastMessage}"\n\nOpen Meta Business Suite to take over.`;
  }

  if (payload.type === 'NEW_ORDER') {
    const { order } = payload;
    return `🎉 <b>New order!</b>\nName: ${order.name}\nProduct: ${order.product}\nTotal: ${order.total} taka\nCustomer ID: ${payload.senderId}\n\nConfirm payment when received.`;
  }

  return `ℹ️ ${JSON.stringify(payload)}`;
}
