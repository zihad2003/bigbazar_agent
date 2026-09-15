/**
 * Text embeddings + ranking helpers for RAG.
 * Falls back to lexical token overlap when Gemini embed is unavailable.
 */
import { tokenizeQuery, expandSynonyms, scoreAgainstTokens } from '../utils/searchNormalize.js';

const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'text-embedding-004';

export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

export function lexicalScore(query, document) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return 0;
  return scoreAgainstTokens(expandSynonyms(document || ''), tokens);
}

export async function embedText(text) {
  const key = process.env.GEMINI_API_KEY;
  const trimmed = (text || '').trim();
  if (!key || !trimmed) return null;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text: trimmed.slice(0, 8000) }] },
        }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.embedding?.values || null;
  } catch {
    return null;
  }
}

/**
 * Rank items by embedding cosine if vectors exist, else lexical overlap.
 * @param {string} query
 * @param {Array<{ _text: string, _vec?: number[]|null }>} items
 * @param {number} limit
 */
export async function rankByRelevance(query, items, limit) {
  if (!items.length) return [];
  const queryVec = await embedText(query);

  const scored = [];
  for (const item of items) {
    let score = lexicalScore(query, item._text);
    if (queryVec) {
      if (!item._vec) item._vec = await embedText(item._text);
      if (item._vec) {
        score = cosineSimilarity(queryVec, item._vec) * 10 + score * 0.05;
      }
    }
    scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const minScore = queryVec ? 0.05 : 1;
  return scored.filter(s => s.score >= minScore).slice(0, limit).map(s => s.item);
}
