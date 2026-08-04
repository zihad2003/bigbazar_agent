/**
 * Gemini API Integration (Native REST Implementation)
 *
 * Provides a drop-in replacement for Groq using Gemini 2.5 Flash.
 * Supports native vision search (describeImage) and structured JSON output
 * via responseSchema/responseMimeType (no more ---CONTROL--- parsing).
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const DEFAULT_PRIMARY = 'gemini-2.0-flash';
const DEFAULT_FALLBACK = 'gemini-flash-lite-latest';

/** Models that are deprecated, quota-blocked, or unavailable — auto-upgrade at startup */
const BLOCKED_MODELS = new Set([
  'gemini-3.5-flash-lite',
]);

function resolveModel(envValue, defaultModel) {
  const model = (envValue || defaultModel).trim();
  if (BLOCKED_MODELS.has(model)) {
    console.warn(`⚠️ [Gemini API] Model "${model}" is deprecated or quota-blocked. Using "${defaultModel}" instead.`);
    return defaultModel;
  }
  return model;
}

const PRIMARY_MODEL = resolveModel(process.env.GEMINI_MODEL, DEFAULT_PRIMARY);
const FALLBACK_MODEL = resolveModel(process.env.GEMINI_FALLBACK_MODEL, DEFAULT_FALLBACK);

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

/**
 * Fetch helper for Gemini REST API with automatic model fallback
 */
async function callGemini(payload, modelName = PRIMARY_MODEL) {
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
 * Fetch helper for media (image or audio) and return as inline base64 object for Gemini
 */
async function fetchMediaAsInlineData(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = res.headers.get('content-type') || 'application/octet-stream';
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
    console.error('⚠️ [Gemini Vision] Failed to identify product:', err.message);
    return '';
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
      currentUserParts.push({ text: `[কাস্টমার একটি ছবি পাঠিয়েছেন: ${imageUrl}]` });
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

  const response = await callGemini(payload);
  const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

  if (!rawText.trim()) {
    const finishReason = response.candidates?.[0]?.finishReason || 'UNKNOWN';
    console.warn(`⚠️ [Gemini API] Returned empty response. finishReason: ${finishReason}`);
    return {
      reply: 'দুঃখিত, একটু কারিগরি সমস্যা হচ্ছে। দয়া করে আবার মেসেজ দিন।',
      intent: 'NONE',
    };
  }

  return parseAIResponse(rawText);
}

/**
 * Parses the structured JSON response from Gemini.
 * With responseSchema, the output is guaranteed to be valid JSON,
 * but we still wrap in try/catch for safety.
 */
function parseAIResponse(rawText) {
  let cleanedText = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleanedText);
    return sanitizeParsedReply(parsed);
  } catch (err) {
    console.error(`🚨 [PARSE_FAILURE] [Gemini] Failed to parse AI response as JSON. Error: ${err.message}`);
    console.error(`🚨 [PARSE_FAILURE] [Gemini] Raw response (first 500 chars): ${cleanedText.slice(0, 500)}`);

    // Regex fallback for truncated/malformed JSON (same approach as groq.js)
    const intentMatch = cleanedText.match(/"intent"\s*:\s*"([^"]+)"/);
    const replyMatch = cleanedText.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const productNameMatch = cleanedText.match(/"productName"\s*:\s*"([^"]*)"/);
    const productPriceMatch = cleanedText.match(/"productPrice"\s*:\s*(\d+)/);

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

/** Strip overly long values the model sometimes puts in optional fields */
function sanitizeParsedReply(parsed) {
  const trim = (v, max = 120) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v);
  const result = {
    reply: parsed.reply || '',
    intent: parsed.intent || 'NONE',
    productName: trim(parsed.productName) || undefined,
    productPrice: parsed.productPrice || undefined,
    variant: trim(parsed.variant, 60) || undefined,
    imageUrl: parsed.imageUrl || undefined,
    customerName: trim(parsed.customerName) || undefined,
    customerAddress: trim(parsed.customerAddress) || undefined,
    customerPhone: trim(parsed.customerPhone) || undefined,
  };

  // Pass through paymentInfo if present and has at least one populated field
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
