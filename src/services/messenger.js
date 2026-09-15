/**
 * Facebook Messenger Send API
 */

const FB_API_VERSION = 'v21.0';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

export async function sendMessage(recipientId, text) {
  if (!text || !String(text).trim()) {
    console.warn(`⚠️ [Messenger API] Skipping empty send to ${recipientId}`);
    return;
  }

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
export async function sendImageMessage(recipientId, imageUrl, baseUrl = '') {
  if (!imageUrl) return;

  // Proxy the image through our app to bypass Meta's crawler blocking instagram/weserv URLs
  const targetUrl = baseUrl
    ? `${baseUrl}/proxy-image?url=${encodeURIComponent(imageUrl)}&f.jpg`
    : imageUrl;

  try {
    await callSendAPI({
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: 'image',
          payload: { url: targetUrl, is_reusable: true },
        },
      },
      messaging_type: 'RESPONSE',
    });
  } catch (err) {
    console.warn(`⚠️ [Messenger API] Failed to send image attachment, falling back to text link. Error:`, err.message);
    await sendMessage(recipientId, `পণ্যটির ছবি লিংক: ${imageUrl}`);
  }
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
  if (!text) return [];
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

const REEL_SHARE = /facebook\.com\/reel|fb\.watch|instagram\.com\/reels?|tiktok\.com|vt\.tiktok\.com/i;

/**
 * Pull image / reel-video / voice / share-link from a Messenger attachments array.
 * 90% of Big Bazar inbox traffic is a reel screenshot or a forwarded reel clip.
 */
export function extractMessengerMedia(attachments = []) {
  let imageUrl = null;
  let videoUrl = null;
  let audioUrl = null;
  let shareUrl = null;

  for (const a of attachments || []) {
    const type = String(a.type || '').toLowerCase();
    const payload = a.payload || {};
    const url = payload.url || payload.source || null;
    if (type === 'image' && url && !imageUrl) imageUrl = url;
    else if (type === 'video' && url && !videoUrl) videoUrl = url;
    else if (type === 'audio' && url && !audioUrl) audioUrl = url;
    else if (url && (type === 'share' || type === 'fallback' || type === 'template' || type === 'ig_reel' || type === 'story_mention')) {
      shareUrl = shareUrl || url;
    }
    const nested = payload.generic?.elements?.[0]?.url
      || payload.elements?.[0]?.url
      || payload.url;
    if (!url && nested && type !== 'image' && type !== 'video' && type !== 'audio') {
      shareUrl = shareUrl || nested;
    }
  }

  const visualUrl = imageUrl || videoUrl || null;
  const isReelShare = !visualUrl && !!(shareUrl && REEL_SHARE.test(shareUrl));
  return { imageUrl, videoUrl, audioUrl, shareUrl, visualUrl, isReelShare };
}

/**
 * Older Facebook inbox turns the bot never stored in D1.
 * Used so replies can see if this customer already talked to the page.
 */
export async function fetchConversationHistory(psid, limit = 15) {
  if (!PAGE_ACCESS_TOKEN || !psid) return [];
  try {
    const convUrl = `https://graph.facebook.com/${FB_API_VERSION}/me/conversations?user_id=${encodeURIComponent(psid)}&fields=id&limit=1&access_token=${PAGE_ACCESS_TOKEN}`;
    const convRes = await fetch(convUrl);
    const conv = await convRes.json();
    const convId = conv?.data?.[0]?.id;
    if (!convId) return [];

    const msgUrl = `https://graph.facebook.com/${FB_API_VERSION}/${convId}/messages?fields=message,from,created_time&limit=${limit}&access_token=${PAGE_ACCESS_TOKEN}`;
    const msgRes = await fetch(msgUrl);
    const msgs = await msgRes.json();
    const rows = msgs.data || [];
    // Graph returns newest first
    return rows.slice().reverse().map((m) => ({
      role: String(m.from?.id || '') === String(psid) ? 'user' : 'assistant',
      content: (m.message || '').trim() || '[মিডিয়া]',
      ts: Date.parse(m.created_time) || Date.now(),
    })).filter((m) => m.content);
  } catch (err) {
    console.warn('⚠️ [Messenger] Prior inbox history unavailable:', err.message);
    return [];
  }
}
