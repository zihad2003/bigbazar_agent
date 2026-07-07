/**
 * AI Provider Wrapper Service
 *
 * Dynamically routes requests to either Groq or Gemini depending on env configuration.
 * Auto-detects and defaults to Gemini if GEMINI_API_KEY is present.
 */

import * as groqService from './groq.js';
import * as geminiService from './gemini.js';

const AI_PROVIDER = process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'groq');

console.log(`🤖 [AI Wrapper] Configured provider: ${AI_PROVIDER.toUpperCase()}`);

export async function getAIReply(systemPrompt, userText, imageUrl, history = []) {
  if (AI_PROVIDER === 'gemini') {
    return geminiService.getAIReply(systemPrompt, userText, imageUrl, history);
  }
  return groqService.getAIReply(systemPrompt, userText, imageUrl, history);
}

export async function describeImage(imageUrl) {
  if (AI_PROVIDER === 'gemini') {
    return geminiService.describeImage(imageUrl);
  }
  return groqService.describeImage(imageUrl);
}
