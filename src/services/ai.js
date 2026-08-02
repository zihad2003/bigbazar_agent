/**
 * AI Provider Wrapper Service
 *
 * Dynamically routes requests to either Groq or Gemini depending on env configuration.
 * Auto-detects and defaults to Gemini if GEMINI_API_KEY is present.
 *
 * ⚠️  Groq has ZERO vision capability — image analysis requires Gemini.
 */

import * as groqService from './groq.js';
import * as geminiService from './gemini.js';

const AI_PROVIDER = process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'groq');

console.log(`🤖 [AI Wrapper] Configured provider: ${AI_PROVIDER.toUpperCase()}`);

if (AI_PROVIDER === 'groq') {
  console.error('');
  console.error('🚨🚨🚨 [AI Wrapper] WARNING: AI_PROVIDER is "groq" — Groq has ZERO vision capability!');
  console.error('🚨 [AI Wrapper] Product photo identification will NOT work (describeImage always returns empty).');
  console.error('🚨 [AI Wrapper] To fix: set AI_PROVIDER=gemini and provide GEMINI_API_KEY in your .env file.');
  console.error('🚨 [AI Wrapper] Get a free Gemini API key at: https://aistudio.google.com/app/apikey');
  console.error('');
}

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
