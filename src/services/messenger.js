/**
 * Facebook Messenger Send API
 */

const FB_API_VERSION = 'v21.0';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

export async function sendMessage(recipientId, text) {
  // Facebook caps message length at 2000 chars
  const chunks = splitMessage(text, 1900);

  for (const chunk of chunks) {
    await callSendAPI({
      recipient: { id: recipientId },
      message: { text: chunk },
      messaging_type: 'RESPONSE',
    });
  }
}

/**
 * Send an image via URL to a Messenger user.
 * Used to share product photos when customer asks "ছবি দেখান".
 */
export async function sendImageMessage(recipientId, imageUrl) {
  if (!imageUrl) return;
  await callSendAPI({
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: 'image',
        payload: { url: imageUrl, is_reusable: true },
      },
    },
    messaging_type: 'RESPONSE',
  });
}

export async function sendTypingIndicator(recipientId, on) {
  await callSendAPI({
    recipient: { id: recipientId },
    sender_action: on ? 'typing_on' : 'typing_off',
  }).catch(() => {}); // non-critical, don't let it break the flow
}

async function callSendAPI(payload) {
  const url = `https://graph.facebook.com/${FB_API_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('FB Send API error:', res.status, errBody);
    throw new Error(`FB Send API failed: ${res.status}`);
  }

  return res.json();
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut === -1) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
