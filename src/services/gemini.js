/**
 * Gemini API Integration (Native REST Implementation)
 *
 * Provides a drop-in replacement for Groq using Gemini 2.5 Flash.
 * Supports native vision search (describeImage) and structured JSON output
 * via responseSchema/responseMimeType (no more ---CONTROL--- parsing).
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const DEFAULT_PRIMARY = 'gemini-2.5-flash';
const DEFAULT_FALLBACK = 'gemini-flash-lite-latest';

/** Models that are deprecated, quota-blocked, or unavailable — auto-upgrade at startup */
const BLOCKED_MODELS = new Set([
  'gemini-3.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
]);

function resolveModel(envValue, defaultModel) {
  const model = (envValue || defaultModel).trim();
  if (BLOCKED_MODELS.has(model)) {
    console.warn(`⚠️ [Gemini API] Model "${model}" is unavailable. Using "${defaultModel}" instead.`);
    return defaultModel;
  }
  return model;
}

const PRIMARY_MODEL = resolveModel(process.env.GEMINI_MODEL, DEFAULT_PRIMARY);
const FALLBACK_MODEL = resolveModel(process.env.GEMINI_FALLBACK_MODEL, DEFAULT_FALLBACK);
let activePrimary = PRIMARY_MODEL;

/** Classify Gemini API errors for correct fallback behavior */
function classifyGeminiError(msg) {
  const lower = (msg || '').toLowerCase();
  if (lower.includes('not found') || lower.includes('no longer available') || lower.includes('is not supported')) {
    return 'model_not_found';
  }
  if (lower.includes('quota') || lower.includes('rate limit') || lower.includes('rate-limit') || lower.includes('resource exhausted')) {
    return 'quota_exceeded';
  }
  return 'other';
}

/** Whether to retry with the configured Gemini fallback model */
function shouldTryGeminiFallback(errorType, modelName) {
  if (modelName === FALLBACK_MODEL) return false;
  return errorType === 'model_not_found' || errorType === 'quota_exceeded';
}

/**
 * JSON schema for structured AI reply output.
 * Gemini's responseSchema constrains the model to emit valid JSON matching this shape.
 */
const AI_REPLY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply:           { type: 'STRING', description: 'Short Bengali reply to customer (max 2-3 sentences)' },
    intent:          { type: 'STRING', description: 'One of: PRODUCT_FOUND, START_ORDER, CONFIRM_ORDER, HANDOFF, NONE', enum: ['PRODUCT_FOUND', 'START_ORDER', 'CONFIRM_ORDER', 'HANDOFF', 'NONE'] },
    productName:     { type: 'STRING', description: 'Exact product name from context only, else empty string ""' },
    productPrice:    { type: 'NUMBER', description: 'Price in BDT from context, else 0' },
    variant:         { type: 'STRING', description: 'Color/size only, else empty string "". Never put explanations.' },
    imageUrl:        { type: 'STRING', description: 'Image URL from PRODUCT CONTEXT only, else empty string ""' },
    customerName:    { type: 'STRING', description: 'Customer name if provided, else empty string ""' },
    customerAddress: { type: 'STRING', description: 'Customer address if provided, else empty string ""' },
    customerPhone:   { type: 'STRING', description: 'Customer phone if provided, else empty string ""' },
    paymentInfo:     {
      type: 'OBJECT',
      description: 'Payment proof details extracted from customer message/screenshot. Only populate when customer is clearly providing payment proof.',
      nullable: true,
      properties: {
        paymentMethod:  { type: 'STRING', description: 'bkash, nagad, or cod' },
        senderNumber:   { type: 'STRING', description: 'Phone number customer paid from' },
        transactionId:  { type: 'STRING', description: 'Transaction ID from payment' },
        claimedAmount:  { type: 'NUMBER', description: 'Amount claimed to have been paid' },
      },
    },
  },
  required: ['reply', 'intent'],
};

const SCREENSHOT_PARSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    imageKind: {
      type: 'STRING',
      enum: ['product', 'payment', 'other'],
      description: 'product = apparel/ad/reel screenshot; payment = bKash/Nagad receipt; other = unrelated',
    },
    ocrText: { type: 'STRING', description: 'Visible product name, code, or price text. Empty if none.' },
    apparelType: { type: 'STRING', description: 'saree, 3piece, 2piece, kurti, gown, lehenga, panjabi, or empty' },
    colors: { type: 'STRING', description: 'Dominant colors in English, comma-separated' },
    pattern: { type: 'STRING', description: 'Short pattern notes e.g. floral, katan, embroidery' },
    searchKeywords: { type: 'STRING', description: '4-8 English catalog search keywords. No sentences.' },
    paymentMethod: { type: 'STRING', description: 'bkash, nagad, or empty' },
    senderNumber: { type: 'STRING' },
    transactionId: { type: 'STRING' },
    claimedAmount: { type: 'NUMBER' },
  },
  required: ['imageKind', 'searchKeywords'],
};

const VISUAL_RERANK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['HIGH', 'AMBIGUOUS', 'NONE'] },
    bestIndex: { type: 'NUMBER', description: '0-based catalog candidate index, or -1' },
    secondIndex: { type: 'NUMBER', description: 'Second match if AMBIGUOUS, else -1' },
  },
  required: ['verdict', 'bestIndex'],
};

/**
 * Fetch helper for Gemini REST API with automatic model fallback
 */
async function callGemini(payload, modelName = activePrimary) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY in environment variables.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      const msg = data.error?.message || res.statusText;
      const errorType = classifyGeminiError(msg);

      if (shouldTryGeminiFallback(errorType, modelName)) {
        if (errorType === 'model_not_found' && modelName === activePrimary && activePrimary !== FALLBACK_MODEL) {
          console.warn(`⚠️ [Gemini API] Demoting "${modelName}" → "${FALLBACK_MODEL}" for this process`);
          activePrimary = FALLBACK_MODEL;
        }
        console.warn(`⚠️ [Gemini API] Model "${modelName}" failed (${errorType}). Retrying with "${FALLBACK_MODEL}"...`);
        try {
          return await callGemini(payload, FALLBACK_MODEL);
        } catch (nestedErr) {
          nestedErr.alreadyRetried = true;
          throw nestedErr;
        }
      }
      throw new Error(`Gemini API Error: ${msg}`);
    }

    return data;
  } catch (err) {
    if (err.alreadyRetried) throw err;

    const errorType = classifyGeminiError(err.message);
    if (shouldTryGeminiFallback(errorType, modelName)) {
      if (errorType === 'model_not_found' && modelName === activePrimary && activePrimary !== FALLBACK_MODEL) {
        console.warn(`⚠️ [Gemini API] Demoting "${modelName}" → "${FALLBACK_MODEL}" for this process`);
        activePrimary = FALLBACK_MODEL;
      }
      console.warn(`⚠️ [Gemini API] Model "${modelName}" failed (${errorType}): ${err.message}. Retrying with "${FALLBACK_MODEL}"...`);
      try {
        return await callGemini(payload, FALLBACK_MODEL);
      } catch (nestedErr) {
        nestedErr.alreadyRetried = true;
        throw nestedErr;
      }
    }
    throw err;
  }
}

/**
 * Fetch helper for media (image, audio, or short reel/video) as Gemini inline data.
 */
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

function guessMime(contentType, url, hint) {
  if (hint && /^(image|audio|video)\//.test(hint)) return hint.split(';')[0].trim();
  let mime = (contentType || '').split(';')[0].trim().toLowerCase();
  if (/^(image|audio|video)\//.test(mime)) return mime;
  const u = (url || '').toLowerCase();
  if (/\.mp4(\?|$)/.test(u) || u.includes('/video')) return 'video/mp4';
  if (/\.(m4a|aac)(\?|$)/.test(u)) return 'audio/mp4';
  if (/\.(png)(\?|$)/.test(u)) return 'image/png';
  if (/\.(webp)(\?|$)/.test(u)) return 'image/webp';
  return 'image/jpeg';
}

export async function fetchMediaAsInlineData(url, mimeHint) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_INLINE_BYTES) {
      console.warn(`⚠️ [Gemini] Media too large (${arrayBuffer.byteLength} bytes), skip inline`);
      return null;
    }
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = guessMime(res.headers.get('content-type'), url, mimeHint);
    return {
      inlineData: {
        mimeType,
        data: buffer.toString('base64'),
      },
    };
  } catch (err) {
    console.error('Failed to fetch media for Gemini:', err.message);
    return null;
  }
}

/**
 * Vision helper to describe an image and get text keywords for product search
 */
export async function describeImage(imageUrl) {
  if (!GEMINI_API_KEY) {
    console.log('📸 [Gemini Vision] No GEMINI_API_KEY provided. Skipping.');
    return '';
  }

  console.log(`📸 [Gemini Vision] Analyzing image attachment: ${imageUrl}`);
  const imageData = await fetchMediaAsInlineData(imageUrl);
  if (!imageData) return '';

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          imageData,
          {
            text: 'Identify the apparel/product in the image. Return only 2 to 3 simple search keywords in English representing the type of dress, color, and pattern (e.g. "red gown", "blue kurti", "floral saree"). Do not write sentences or punctuation.',
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 20,
    },
  };

  try {
    const response = await callGemini(payload);
    const resultText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`🎯 [Gemini Vision] Identified search keywords: "${resultText.trim()}"`);
    return resultText.trim();
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    const noImageSupport = msg.includes('image') && (msg.includes('not support') || msg.includes('does not support'));
    if (noImageSupport) {
      console.warn('⚠️ [Gemini API] Model does not support image input. Returning empty keywords.');
      return '';
    }
    console.error('⚠️ [Gemini Vision] Failed to identify product:', err.message);
    return '';
  }
}

function parseJsonObject(rawText, fallback = {}) {
  if (!rawText || !String(rawText).trim()) return fallback;
  let cleaned = String(rawText).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return { ...fallback, ...JSON.parse(cleaned) };
  } catch {
    return fallback;
  }
}

/**
 * Parse a customer photo/screenshot (TikTok/IG/FB/Reel UI chrome possible).
 */
export async function parseScreenshot(imageUrl) {
  if (!GEMINI_API_KEY || !imageUrl) return null;

  const imageData = await fetchMediaAsInlineData(imageUrl);
  if (!imageData) return null;

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        imageData,
        {
          text: `This is a customer Messenger photo or short reel/video. It may be a TikTok, Instagram, Facebook Reels screenshot or clip with UI chrome, captions, watermarks, or a model wearing clothes — or a bKash/Nagad payment receipt, or unrelated.

Ignore like-bars, captions, profile UI, play buttons. Focus on the garment if present.
If it is a payment receipt/screenshot, set imageKind=payment and extract method/number/trx/amount.
Return JSON only.`,
        },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 400,
      responseMimeType: 'application/json',
      responseSchema: SCREENSHOT_PARSE_SCHEMA,
    },
  };

  try {
    const response = await callGemini(payload);
    const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = parseJsonObject(rawText, { imageKind: 'other', searchKeywords: '' });
    console.log(`🎯 [Screenshot Parse] kind=${parsed.imageKind} keywords="${parsed.searchKeywords}" ocr="${(parsed.ocrText || '').slice(0, 80)}"`);
    return parsed;
  } catch (err) {
    console.error('⚠️ [Screenshot Parse] failed:', err.message);
    return null;
  }
}

/**
 * Compare customer screenshot to labeled catalog candidate images.
 * @param {string} customerImageUrl
 * @param {Array<{ product: object, imageUrl: string }>} slots
 */
export async function rerankVisualMatch(customerImageUrl, slots) {
  if (!GEMINI_API_KEY || !customerImageUrl || !slots?.length) {
    return { verdict: 'NONE', bestIndex: -1, secondIndex: -1 };
  }

  const customerImage = await fetchMediaAsInlineData(customerImageUrl);
  if (!customerImage) {
    return { verdict: 'AMBIGUOUS', bestIndex: 0, secondIndex: slots.length > 1 ? 1 : -1 };
  }

  const parts = [
    customerImage,
    { text: 'IMAGE A is the customer screenshot (social-media chrome possible). The following images are catalog candidates.' },
  ];

  const fetched = [];
  for (let i = 0; i < slots.length; i++) {
    const img = await fetchMediaAsInlineData(slots[i].imageUrl);
    if (!img) continue;
    fetched.push({ catalogIndex: i, product: slots[i].product });
    parts.push(img);
    parts.push({ text: `CANDIDATE ${fetched.length - 1}: ${slots[i].product.name}` });
  }

  if (fetched.length === 0) {
    return { verdict: 'AMBIGUOUS', bestIndex: 0, secondIndex: slots.length > 1 ? 1 : -1 };
  }

  parts.push({
    text: `Which CANDIDATE is the same garment as IMAGE A? Same design/color/work counts even if one is a reel of a model and the other is a packshot. If two are equally plausible, verdict=AMBIGUOUS. If none match, verdict=NONE. bestIndex/secondIndex are CANDIDATE numbers (0..${fetched.length - 1}).`,
  });

  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 120,
      responseMimeType: 'application/json',
      responseSchema: VISUAL_RERANK_SCHEMA,
    },
  };

  try {
    const response = await callGemini(payload);
    const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = parseJsonObject(rawText, { verdict: 'NONE', bestIndex: -1, secondIndex: -1 });
    const mapIdx = (n) => {
      const i = Number(n);
      if (!Number.isInteger(i) || i < 0 || i >= fetched.length) return -1;
      return fetched[i].catalogIndex;
    };
    const result = {
      verdict: ['HIGH', 'AMBIGUOUS', 'NONE'].includes(parsed.verdict) ? parsed.verdict : 'NONE',
      bestIndex: mapIdx(parsed.bestIndex),
      secondIndex: mapIdx(parsed.secondIndex),
    };
    console.log(`🎯 [Visual Rerank] ${JSON.stringify(result)}`);
    return result;
  } catch (err) {
    console.error('⚠️ [Visual Rerank] failed:', err.message);
    return { verdict: 'AMBIGUOUS', bestIndex: 0, secondIndex: slots.length > 1 ? 1 : -1 };
  }
}

/**
 * Audio helper to describe a voice message and get text keywords for product search
 */
export async function describeAudio(audioUrl) {
  if (!GEMINI_API_KEY) {
    console.log('🎤 [Gemini Audio] No GEMINI_API_KEY provided. Skipping.');
    return '';
  }

  console.log(`🎤 [Gemini Audio] Analyzing voice message: ${audioUrl}`);
  const audioData = await fetchMediaAsInlineData(audioUrl);
  if (!audioData) return '';

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          audioData,
          {
            text: 'Listen to this voice message from a customer. If they are asking about a product, return 2-3 simple search keywords in English representing the item, color, and type (e.g. "red saree", "gold necklace"). If not product-related, return an empty string. Do not write sentences.',
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 20,
    },
  };

  try {
    const response = await callGemini(payload);
    const resultText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`🎯 [Gemini Audio] Identified search keywords: "${resultText.trim()}"`);
    return resultText.trim();
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    const noAudioSupport = msg.includes('audio') && (msg.includes('not support') || msg.includes('does not support'));
    if (noAudioSupport) {
      console.warn('⚠️ [Gemini API] Model does not support audio input. Returning empty keywords.');
      return '';
    }
    console.error('⚠️ [Gemini Audio] Failed to identify product:', err.message);
    return '';
  }
}

/**
 * Chat Completion helper — uses Gemini structured output (responseSchema)
 * to guarantee valid JSON responses instead of the old ---CONTROL--- parsing.
 */
export async function getAIReply(systemPrompt, userText, imageUrl, history = [], audioUrl) {
  const contents = [];

  // Load chat history turns into Gemini contents format
  for (const turn of history) {
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    });
  }

  const currentUserParts = [];

  // Inject image inline data if any
  if (imageUrl) {
    const imageData = await fetchMediaAsInlineData(imageUrl);
    if (imageData) {
      currentUserParts.push(imageData);
      currentUserParts.push({ text: `[কাস্টমার একটি ছবি বা রিল পাঠিয়েছেন]` });
    }
  }

  // Inject audio inline data if any
  if (audioUrl) {
    const audioData = await fetchMediaAsInlineData(audioUrl);
    if (audioData) {
      currentUserParts.push(audioData);
      currentUserParts.push({ text: '[কাস্টমার একটি ভয়েস মেসেজ পাঠিয়েছেন]' });
    }
  }

  currentUserParts.push({
    text: userText || '[Customer sent media with no caption]',
  });

  contents.push({
    role: 'user',
    parts: currentUserParts,
  });

  const payload = {
    contents,
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: AI_REPLY_SCHEMA,
    },
  };

  let response;
  try {
    response = await callGemini(payload);
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    const noImageSupport = msg.includes('image') && (msg.includes('not support') || msg.includes('does not support'));
    if (noImageSupport && (imageUrl || audioUrl)) {
      console.warn('⚠️ [Gemini API] Model does not support image/audio input. Retrying with text-only.');
      return getAIReplyTextOnly(systemPrompt, userText, history);
    }
    throw err;
  }

  const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

  if (!rawText.trim()) {
    const finishReason = response.candidates?.[0]?.finishReason || 'UNKNOWN';
    console.warn(`⚠️ [Gemini API] Returned empty response. finishReason: ${finishReason}`);
    return {
      reply: 'দুঃখিত, একটু কারিগরি সমস্যা হচ্ছে। দয়া করে আবার মেসেজ দিন।',
      intent: 'NONE',
    };
  }

  return parseAIResponse(rawText);
}

/** Text-only retry when the model rejects image/audio parts. */
async function getAIReplyTextOnly(systemPrompt, userText, history = []) {
  return getAIReply(systemPrompt, userText, undefined, history, undefined);
}

/**
 * Parses the structured JSON response from Gemini.
 * Handles truncated JSON (from oversized variant field) by repairing
 * unclosed strings and trimming trailing garbage before parsing.
 */
function parseAIResponse(rawText) {
  let cleanedText = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const repaired = repairTruncatedJson(cleanedText);

  try {
    const parsed = JSON.parse(repaired);
    return sanitizeParsedReply(parsed);
  } catch (err) {
    console.error(`🚨 [PARSE_FAILURE] [Gemini] Failed to parse AI response as JSON. Error: ${err.message}`);
    console.error(`🚨 [PARSE_FAILURE] [Gemini] Raw response (first 500 chars): ${cleanedText.slice(0, 500)}`);

    const intentMatch = repaired.match(/"intent"\s*:\s*"([^"]+)"/);
    const replyMatch = repaired.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const productNameMatch = repaired.match(/"productName"\s*:\s*"([^"]*)"/);
    const productPriceMatch = repaired.match(/"productPrice"\s*:\s*(\d+)/);

    if (replyMatch) {
      const fallback = {
        reply: replyMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
        intent: intentMatch?.[1] || 'NONE',
      };
      if (productNameMatch?.[1]) fallback.productName = productNameMatch[1];
      if (productPriceMatch) fallback.productPrice = Number(productPriceMatch[1]);
      console.warn('🚨 [PARSE_FAILURE] [Gemini] Using regex fallback:', fallback);
      return fallback;
    }

    return { reply: 'দুঃখিত, একটু সমস্যা হচ্ছে। আবার চেষ্টা করুন।', intent: 'NONE' };
  }
}

/**
 * Repairs truncated JSON by closing unclosed strings and trimming trailing garbage.
 * This handles the case where Gemini's variant field overflows maxOutputTokens
 * and the response gets cut mid-string.
 */
function repairTruncatedJson(text) {
  if (!text || typeof text !== 'string') return text;

  // Quick check: count unclosed quotes
  const quoteCount = (text.match(/"/g) || []).length;
  if (quoteCount % 2 === 0) return text;

  // Find the last complete key-value pair by scanning backwards
  // Look for the last occurrence of a complete field pattern: "key": value,
  const lastCompleteField = text.search(/"(\w+)"\s*:\s*(?:"[^"]*"|\d+|true|false|null|\{[^}]*\}|\[[^\]]*\])[,}]?\s*$/) ;

  // Alternative: find last closing brace of a complete value
  const lastValidClose = Math.max(
    text.lastIndexOf('",'),
    text.lastIndexOf('"}'),
    text.lastIndexOf('"]'),
    text.lastIndexOf('",\n'),
    text.lastIndexOf('"}'),
    text.lastIndexOf('"]')
  );

  if (lastValidClose > 0) {
    const trimmed = text.slice(0, lastValidClose + 1);
    // Close any open objects/arrays and fix trailing comma
    const openBraces = (trimmed.match(/\{/g) || []).length - (trimmed.match(/\}/g) || []).length;
    const openBrackets = (trimmed.match(/\[/g) || []).length - (trimmed.match(/\]/g) || []).length;

    let repaired = trimmed;
    if (openBrackets > 0) repaired += ']'.repeat(openBrackets);
    if (openBraces > 0) repaired += '}'.repeat(openBraces);

    // Remove trailing comma before closing
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

    return repaired;
  }

  return text;
}

/** Strip overly long values the model sometimes puts in optional fields */
function sanitizeParsedReply(parsed) {
  const trim = (v, max = 120) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v);
  const result = {
    reply: parsed.reply || '',
    intent: parsed.intent || 'NONE',
    productName: trim(parsed.productName) || undefined,
    productPrice: parsed.productPrice || undefined,
    variant: (() => {
      const v = parsed.variant;
      if (!v || typeof v !== 'string') return undefined;
      if (v.length <= 60) return v || undefined;
      const words = v.split(/\s+/).slice(0, 6);
      return words.join(' ') || undefined;
    })(),
    imageUrl: parsed.imageUrl || undefined,
    customerName: trim(parsed.customerName) || undefined,
    customerAddress: trim(parsed.customerAddress) || undefined,
    customerPhone: trim(parsed.customerPhone) || undefined,
  };

  if (parsed.paymentInfo && typeof parsed.paymentInfo === 'object') {
    const pi = parsed.paymentInfo;
    if (pi.paymentMethod || pi.senderNumber || pi.transactionId || pi.claimedAmount) {
      result.paymentInfo = {
        paymentMethod: trim(pi.paymentMethod, 20) || undefined,
        senderNumber: trim(pi.senderNumber, 20) || undefined,
        transactionId: trim(pi.transactionId, 30) || undefined,
        claimedAmount: pi.claimedAmount || undefined,
      };
    }
  }

  return result;
}
