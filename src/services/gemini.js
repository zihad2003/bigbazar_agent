/**
 * Gemini API Integration (Native REST Implementation)
 *
 * Provides a drop-in replacement for Groq using Gemini 2.5 Flash.
 * Supports native vision search (describeImage) and structured JSON output
 * via responseSchema/responseMimeType (no more ---CONTROL--- parsing).
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const FALLBACK_MODEL = 'gemini-1.5-flash';

/**
 * JSON schema for structured AI reply output.
 * Gemini's responseSchema constrains the model to emit valid JSON matching this shape.
 */
const AI_REPLY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply:           { type: 'STRING', description: 'Customer-facing reply text in Bengali' },
    intent:          { type: 'STRING', description: 'One of: PRODUCT_FOUND, START_ORDER, CONFIRM_ORDER, HANDOFF, NONE', enum: ['PRODUCT_FOUND', 'START_ORDER', 'CONFIRM_ORDER', 'HANDOFF', 'NONE'] },
    productName:     { type: 'STRING', description: 'Product name if applicable, empty string otherwise' },
    productPrice:    { type: 'NUMBER', description: 'Product price in BDT if applicable, 0 otherwise' },
    variant:         { type: 'STRING', description: 'Product variant (color, size) if applicable, empty string otherwise' },
    imageUrl:        { type: 'STRING', description: 'Product image URL from PRODUCT CONTEXT, empty string otherwise' },
    customerName:    { type: 'STRING', description: 'Customer name if provided, empty string otherwise' },
    customerAddress: { type: 'STRING', description: 'Customer address if provided, empty string otherwise' },
    customerPhone:   { type: 'STRING', description: 'Customer phone if provided, empty string otherwise' },
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
      if (modelName !== FALLBACK_MODEL && (msg.includes('model') || msg.includes('unexpected model name format'))) {
        console.warn(`⚠️ [Gemini API] Primary model "${modelName}" failed (${msg}). Retrying with fallback model "${FALLBACK_MODEL}"...`);
        return await callGemini(payload, FALLBACK_MODEL);
      }
      throw new Error(`Gemini API Error: ${msg}`);
    }

    return data;
  } catch (err) {
    if (modelName !== FALLBACK_MODEL) {
      console.warn(`⚠️ [Gemini API] Error on model "${modelName}": ${err.message}. Retrying with "${FALLBACK_MODEL}"...`);
      return await callGemini(payload, FALLBACK_MODEL);
    }
    throw err;
  }
}

/**
 * Fetch image and return as inline base64 object for Gemini vision
 */
async function fetchImageAsInlineData(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    return {
      inlineData: {
        mimeType,
        data: buffer.toString('base64'),
      },
    };
  } catch (err) {
    console.error('Failed to fetch image for Gemini vision:', err.message);
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
  const imageData = await fetchImageAsInlineData(imageUrl);
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
 * Chat Completion helper — uses Gemini structured output (responseSchema)
 * to guarantee valid JSON responses instead of the old ---CONTROL--- parsing.
 */
export async function getAIReply(systemPrompt, userText, imageUrl, history = []) {
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
    const imageData = await fetchImageAsInlineData(imageUrl);
    if (imageData) {
      currentUserParts.push(imageData);
      currentUserParts.push({ text: `[কাস্টমার একটি ছবি পাঠিয়েছেন: ${imageUrl}]` });
    }
  }

  currentUserParts.push({
    text: userText || '[Customer sent an image with no caption]',
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
      temperature: 0.5,
      maxOutputTokens: 600,
      responseMimeType: 'application/json',
      responseSchema: AI_REPLY_SCHEMA,
    },
  };

  const response = await callGemini(payload);
  const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

  return parseAIResponse(rawText);
}

/**
 * Parses the structured JSON response from Gemini.
 * With responseSchema, the output is guaranteed to be valid JSON,
 * but we still wrap in try/catch for safety.
 */
function parseAIResponse(rawText) {
  try {
    const parsed = JSON.parse(rawText);
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
    console.error(`🚨 [PARSE_FAILURE] [Gemini] Failed to parse AI response as JSON. Error: ${err.message}`);
    console.error(`🚨 [PARSE_FAILURE] [Gemini] Raw response (first 500 chars): ${rawText.slice(0, 500)}`);

    // Last-resort fallback: try to extract reply text from the raw output
    const cleaned = rawText
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/think>/g, '')
      .trim();

    return { reply: cleaned || 'দুঃখিত, একটু সমস্যা হচ্ছে। আবার চেষ্টা করুন।', intent: 'NONE' };
  }
}
