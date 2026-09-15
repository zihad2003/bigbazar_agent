/**
 * Retrieve top knowledge + gold replies for the current customer message.
 * Does not dump the full KB into the prompt.
 */
import { getActiveKnowledgeBase, getTrainingExamples } from './d1.js';
import { rankByRelevance } from './embeddings.js';

const TTL_MS = 5 * 60 * 1000;
let kbCache = { at: 0, rows: [] };
let trainingCache = { at: 0, rows: [] };

export function invalidateRagCache() {
  kbCache = { at: 0, rows: [] };
  trainingCache = { at: 0, rows: [] };
}

async function loadKnowledge() {
  if (Date.now() - kbCache.at < TTL_MS && kbCache.rows.length) return kbCache.rows;
  const rows = await getActiveKnowledgeBase();
  kbCache = {
    at: Date.now(),
    rows: (rows || []).map(r => ({
      ...r,
      _text: `${r.category || ''} ${r.title || ''} ${r.content || ''}`,
    })),
  };
  return kbCache.rows;
}

async function loadTraining() {
  if (Date.now() - trainingCache.at < TTL_MS && trainingCache.rows.length) return trainingCache.rows;
  const rows = await getTrainingExamples(40);
  trainingCache = {
    at: Date.now(),
    rows: (rows || []).map(r => ({
      customer_message: r.customer_message,
      correct_reply: r.correct_reply,
      _text: r.customer_message || '',
    })),
  };
  return trainingCache.rows;
}

export async function retrieveKnowledge(query, limit = 5) {
  try {
    const rows = await loadKnowledge();
    if (!rows.length) return [];
    if (!query?.trim()) return rows.slice(0, limit);
    const ranked = await rankByRelevance(query, rows, limit);
    return ranked;
  } catch (err) {
    console.warn('retrieveKnowledge failed:', err.message);
    return [];
  }
}

export async function retrieveTraining(query, limit = 3) {
  try {
    const rows = await loadTraining();
    if (!rows.length) return [];
    if (!query?.trim()) return rows.slice(0, limit);
    const ranked = await rankByRelevance(query, rows, limit);
    return ranked.map(({ customer_message, correct_reply }) => ({ customer_message, correct_reply }));
  } catch (err) {
    console.warn('retrieveTraining failed:', err.message);
    return [];
  }
}
