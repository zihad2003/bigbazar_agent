/**
 * Groq API Integration
 *
 * Sends the conversation + product context to Groq (Llama 3/Mixtral), asks for a
 * structured JSON response so the state machine can act on intent
 * (not just display text).
 */

import Groq from 'groq-sdk';

let groqClient;
function getGroq() {
  if (!groqClient) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

const PRIMARY_MODEL = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';

/**
 * Helper to call Groq completions with Llama 3.3 -> 3.1 fallback.
 */
async function callGroqWithFallback(messages, maxTokens = 2048, temperature = 0.5) {
  const groq = getGroq();
  try {
    console.log(`🤖 [Groq API] Calling primary model: ${PRIMARY_MODEL}`);
    return await groq.chat.completions.create({
      model: PRIMARY_MODEL,
      max_tokens: maxTokens,
      messages,
      temperature,
    });
  } catch (err) {
    console.warn(`⚠️ [Groq API] Primary model ${PRIMARY_MODEL} failed, falling back to ${FALLBACK_MODEL}. Error:`, err.message);
    return await groq.chat.completions.create({
      model: FALLBACK_MODEL,
      max_tokens: maxTokens,
      messages,
      temperature,
    });
  }
}

/**
 * Vision helper to describe an image and get text keywords for product search.
 * Since Groq has decommissioned Llama 3.2 Vision models, this currently returns empty to prevent API errors.
 *
 * @param {string} imageUrl
 * @returns {Promise<string>} search keywords (e.g. "blue kurti", "red katan saree")
 */
export async function describeImage(imageUrl) {
  // Graceful fallback: return empty to bypass vision description since Groq lacks vision support.
  console.log(`📸 [Vision Image Search] Groq vision models decommissioned. Skipping image analysis for URL: ${imageUrl}`);
  return '';
}

/**
 * @param {string} systemPrompt - built by utils/prompts.js with live product context
 * @param {string} userText
 * @param {string|undefined} imageUrl - Facebook CDN URL of an attached image, if any
 * @param {Array} history - Array of previous conversation messages
 * @returns {{ text: string, intent: string, productName?: string, productPrice?: number, variant?: string }}
 */
export async function getAIReply(systemPrompt, userText, imageUrl, history = []) {
  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  // Load chat history turns into Groq messages array
  for (const turn of history) {
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: turn.content
    });
  }

  // Construct current user content block (text-only to prevent API failures on text-only models)
  const content = [];

  if (imageUrl) {
    content.push({
      type: 'text',
      text: `[কাস্টমার একটি ছবি পাঠিয়েছেন: ${imageUrl}]`
    });
  }

  content.push({
    type: 'text',
    text: userText || '[Customer sent an image with no caption]',
  });

  messages.push({ role: 'user', content });

  const response = await callGroqWithFallback(messages, 1024, 0.5);
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
  // Strip <think>...</think> tag blocks to prevent internal reasoning leaking to customers (even if unclosed due to truncation)
  let cleanedText = rawText;
  if (cleanedText.includes('<think>')) {
    const parts = cleanedText.split('<think>');
    const beforeThink = parts[0];
    const afterThink = parts.slice(1).join('<think>');
    
    const endIdx = afterThink.indexOf('</think>');
    if (endIdx !== -1) {
      cleanedText = (beforeThink + afterThink.slice(endIdx + 8)).trim();
    } else {
      // If unclosed, strip everything after <think>
      cleanedText = beforeThink.trim();
    }
  }

  // Also clean up any loose </think> tags
  cleanedText = cleanedText.replace(/<\/think>/g, '').trim();

  const splitToken = '---CONTROL---';
  const idx = cleanedText.indexOf(splitToken);

  if (idx === -1) {
    // No control block — treat as plain chat, no state transition
    return { text: cleanedText, intent: 'NONE' };
  }

  const text = cleanedText.slice(0, idx).trim();
  const jsonPart = cleanedText.slice(idx + splitToken.length).trim();

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
