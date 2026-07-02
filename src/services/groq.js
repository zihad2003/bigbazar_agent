/**
 * Groq API Integration
 *
 * Sends the conversation + product context to Groq (Llama 3/Mixtral), asks for a
 * structured JSON response so the state machine can act on intent
 * (not just display text).
 */

import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = 'llama-3.3-70b-versatile'; // or 'mixtral-8x7b-32768'

/**
 * @param {string} systemPrompt - built by utils/prompts.js with live product context
 * @param {string} userText
 * @param {string|undefined} imageUrl - Facebook CDN URL of an attached image, if any
 * @returns {{ text: string, intent: string, productName?: string, productPrice?: number, variant?: string }}
 */
export async function getAIReply(systemPrompt, userText, imageUrl) {
  const content = [];

  if (imageUrl) {
    // Groq supports vision with certain models
    const imageBlock = await fetchImageAsBase64(imageUrl);
    if (imageBlock) content.push(imageBlock);
  }

  content.push({
    type: 'text',
    text: userText || '[Customer sent an image with no caption]',
  });

  const response = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 600,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content }
    ],
    temperature: 0.7,
  });

  const rawText = response.choices[0]?.message?.content || '';

  return parseAIResponse(rawText);
}

/**
 * The system prompt instructs the AI to end its reply with a hidden
 * JSON control block so we can extract structured intent. See
 * utils/prompts.js for the exact instruction. Format:
 *
 *   <reply text the customer sees>
 *   ---CONTROL---
 *   {"intent": "PRODUCT_FOUND", "productName": "...", "productPrice": 1850, "variant": "Red, M"}
 */
function parseAIResponse(rawText) {
  const splitToken = '---CONTROL---';
  const idx = rawText.indexOf(splitToken);

  if (idx === -1) {
    // No control block — treat as plain chat, no state transition
    return { text: rawText.trim(), intent: 'NONE' };
  }

  const text = rawText.slice(0, idx).trim();
  const jsonPart = rawText.slice(idx + splitToken.length).trim();

  try {
    const control = JSON.parse(jsonPart);
    return { text, ...control };
  } catch {
    console.warn('⚠️  Failed to parse AI control block:', jsonPart);
    return { text, intent: 'NONE' };
  }
}

async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const mediaType = res.headers.get('content-type') || 'image/jpeg';

    return {
      type: 'image_url',
      image_url: {
        url: `data:${mediaType};base64,${buf.toString('base64')}`
      }
    };
  } catch (err) {
    console.error('Failed to fetch customer image:', err);
    return null;
  }
}
