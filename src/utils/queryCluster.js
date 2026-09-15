/**
 * SLA wait times + lexical clustering for unanswered inbox tickets.
 */
import { tokenizeQuery, expandSynonyms, scoreAgainstTokens, normalizeText } from './searchNormalize.js';
import { parseCreatedAt } from './orderRules.js';

function lexicalScore(query, document) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return 0;
  return scoreAgainstTokens(expandSynonyms(document || ''), tokens);
}

export const SLA_MS = 2 * 60 * 1000;

export function waitMs(createdAt, now = Date.now()) {
  const t = parseCreatedAt(createdAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, now - t);
}

export function isSlaBreach(createdAt, now = Date.now()) {
  return waitMs(createdAt, now) > SLA_MS;
}

export function decorateSla(row, now = Date.now()) {
  const wait = waitMs(row?.created_at, now);
  return {
    ...row,
    wait_ms: wait,
    sla_breached: wait > SLA_MS,
  };
}

function similarEnough(a, b, minScore) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return lexicalScore(a, b) >= minScore || lexicalScore(b, a) >= minScore;
}

/**
 * Greedy clusters of similar customer questions. Largest groups first.
 */
export function clusterQueries(items, { minScore = 2 } = {}) {
  const clusters = [];
  for (const item of items || []) {
    const text = item.customer_message || '';
    const match = clusters.find(c => similarEnough(text, c.sample, minScore));
    if (match) {
      match.ids.push(item.id);
      match.items.push(item);
    } else {
      clusters.push({
        id: `c-${item.id}`,
        sample: text,
        ids: [item.id],
        items: [item],
      });
    }
  }
  return clusters.sort((a, b) => b.items.length - a.items.length);
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
