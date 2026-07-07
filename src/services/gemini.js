/**
 * Gemini API Integration (Native REST Implementation)
 *
 * Provides a drop-in replacement for Groq using Gemini 1.5/2.0 Flash.
 * Supports native vision search (describeImage) and chat completion with JSON parsing.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

/**
 * Fetch helper for Gemini REST API
 */
async function callGemini(payload) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY in environment variables.');
  }

  const res = await fetch(`${BASE_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini API Error: ${data.error?.message || res.statusText}`);
  }

  return data;
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
 * Chat Completion helper
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
      currentUserParts.push({ text: `[কাস্টমার একটি ছবি পাঠিয়েছেন: ${imageUrl}]` });
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
    },
  };

  const response = await callGemini(payload);
  const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

  return parseAIResponse(rawText);
}

/**
 * Parses structured JSON response from markdown blocks
 */
function parseAIResponse(rawText) {
  // Clean think blocks (if any)
  let cleanedText = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  cleanedText = cleanedText.replace(/<\/think>/g, '').trim();

  const splitToken = '---CONTROL---';
  const idx = cleanedText.indexOf(splitToken);

  if (idx === -1) {
    return { text: cleanedText, intent: 'NONE' };
  }

  const text = cleanedText.slice(0, idx).trim();
  const jsonPart = cleanedText.slice(idx + splitToken.length).trim();

  try {
    const control = JSON.parse(jsonPart);
    return { text, ...control };
  } catch (err) {
    const isTruncated = jsonPart.startsWith('{') && !jsonPart.endsWith('}');
    if (isTruncated) {
      console.warn('⚠️ [Gemini API] Truncated JSON detected! Raw jsonPart:', jsonPart);
      const intentMatch = jsonPart.match(/"intent"\s*:\s*"([^"]+)"/);
      const productNameMatch = jsonPart.match(/"productName"\s*:\s*"([^"]+)"/);
      const productPriceMatch = jsonPart.match(/"productPrice"\s*:\s*(\d+)/);
      
      const fallbackControl = { intent: 'NONE' };
      if (intentMatch) fallbackControl.intent = intentMatch[1];
      if (productNameMatch) fallbackControl.productName = productNameMatch[1];
      if (productPriceMatch) fallbackControl.productPrice = Number(productPriceMatch[1]);
      
      return { text, ...fallbackControl, _isTruncated: true };
    } else {
      console.warn('⚠️ [Gemini API] Malformed JSON detected! Raw jsonPart:', jsonPart);
      return { text, intent: 'NONE' };
    }
  }
}
