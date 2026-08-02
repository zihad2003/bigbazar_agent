/**
 * Groq API Integration
 *
 * Sends the conversation + product context to Groq (Llama 3/Mixtral), using
 * JSON mode (response_format: {type: "json_object"}) for reliable structured output.
 *
 * ⚠️  Groq has NO vision capability — describeImage() always returns empty.
 *     Use Gemini (AI_PROVIDER=gemini) for image understanding.
 */

import Groq from 'groq-sdk';

let groqClient;
function getGroq() {
  if (!groqClient) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

const PRIMARY_MODEL = process.env.GROQ_PRIMARY_MODEL || 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant';

/**
 * Helper to call Groq completions with Llama 3.3 -> 3.1 fallback.
 * @param {boolean} jsonMode - If true, enables response_format: {type: "json_object"}
 */
async function callGroqWithFallback(messages, maxTokens = 2048, temperature = 0.5, jsonMode = false) {
  const groq = getGroq();
  const options = {
    model: PRIMARY_MODEL,
    max_tokens: maxTokens,
    messages,
    temperature,
  };

  if (jsonMode) {
    options.response_format = { type: 'json_object' };
  }

  try {
    console.log(`🤖 [Groq API] Calling primary model: ${PRIMARY_MODEL}${jsonMode ? ' (JSON mode)' : ''}`);
    return await groq.chat.completions.create(options);
  } catch (err) {
    console.warn(`⚠️ [Groq API] Primary model ${PRIMARY_MODEL} failed, falling back to ${FALLBACK_MODEL}. Error:`, err.message);
    options.model = FALLBACK_MODEL;
    return await groq.chat.completions.create(options);
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
 * @returns {{ reply: string, intent: string, productName?: string, productPrice?: number, variant?: string }}
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
      text: `[কাস্টমার একটি ছবি পাঠিয়েছেন: ${imageUrl}]`
    });
  }

  content.push({
    type: 'text',
    text: userText || '[Customer sent an image with no caption]',
  });

  messages.push({ role: 'user', content });

  // Enable JSON mode for structured output
  const response = await callGroqWithFallback(messages, 600, 0.5, true);
  const rawText = response.choices[0]?.message?.content || '';

  return parseAIResponse(rawText);
}

/**
 * Parses the JSON response from Groq (JSON mode guarantees valid JSON output).
 * Extracts the `reply` field for customer-facing text and intent fields for state machine.
 */
function parseAIResponse(rawText) {
  // Strip <think>...</think> tag blocks to prevent internal reasoning leaking
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

  // Strip markdown code fences if present (```json ... ```)
  cleanedText = cleanedText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleanedText);
    return {
      reply: parsed.reply || '',
      intent: parsed.intent || 'NONE',
      productName: parsed.productName || undefined,
      productPrice: parsed.productPrice || undefined,
      variant: parsed.variant || undefined,
      imageUrl: parsed.imageUrl || undefined,
      customerName: parsed.customerName || undefined,
      customerAddress: parsed.customerAddress || undefined,
      customerPhone: parsed.customerPhone || undefined,
    };
  } catch (err) {
    console.error(`🚨 [PARSE_FAILURE] [Groq] Failed to parse AI response as JSON. Error: ${err.message}`);
    console.error(`🚨 [PARSE_FAILURE] [Groq] Raw response (first 500 chars): ${cleanedText.slice(0, 500)}`);

    // Regex fallback for truncated JSON
    const intentMatch = cleanedText.match(/"intent"\s*:\s*"([^"]+)"/);
    const replyMatch = cleanedText.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const productNameMatch = cleanedText.match(/"productName"\s*:\s*"([^"]+)"/);
    const productPriceMatch = cleanedText.match(/"productPrice"\s*:\s*(\d+)/);

    const fallback = {
      reply: replyMatch ? replyMatch[1] : 'দুঃখিত, একটু সমস্যা হচ্ছে। আবার চেষ্টা করুন।',
      intent: intentMatch ? intentMatch[1] : 'NONE',
    };
    if (productNameMatch) fallback.productName = productNameMatch[1];
    if (productPriceMatch) fallback.productPrice = Number(productPriceMatch[1]);

    console.warn('🚨 [PARSE_FAILURE] [Groq] Using regex fallback:', fallback);
    return fallback;
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
