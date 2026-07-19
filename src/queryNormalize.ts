/**
 * Query-side normalization for retrieval.
 *
 * Natural-language questions failed both retrieval arms (bench finding, LongMemEval
 * pilot): "How many weddings have I attended in this year?" matched nothing,
 * because websearch_to_tsquery ANDs every term and question scaffolding dilutes
 * the query embedding. Normalization strips interrogatives, stop words, pronouns,
 * and auxiliaries so the query arrives at tsquery/embedding as its content terms:
 * "weddings attended year".
 *
 * Applied to search/recall queries only. grep stays exact-string by design, and
 * slug/title ilike matching keeps the original query. When nothing survives
 * (e.g. a stop-word-only query) the original text is returned so the caller's
 * empty-tsquery guard keeps behaving as before (F6/R7).
 */

const QUESTION_STOP_WORDS = new Set([
  // English stop words (superset of the pg english dictionary list; negators
  // "no"/"not"/"nor" deliberately kept OUT — stripping them flips meaning)
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "if", "in", "into", "of", "off", "on", "or", "out",
  "over", "so", "such", "than", "that", "the", "their", "then", "there",
  "these", "this", "those", "through", "to", "too", "under", "up", "very",
  // pronouns / determiners
  "i", "me", "my", "mine", "we", "us", "our", "ours", "you", "your", "yours",
  "he", "him", "his", "she", "her", "hers", "it", "its", "they", "them",
  "theirs", "anyone", "someone", "everyone", "anything", "something",
  // auxiliaries / modals / copula
  "am", "is", "was", "were", "been", "being", "do", "does", "did", "doing",
  "have", "has", "had", "having", "can", "could", "will", "would", "shall",
  "should", "may", "might", "must",
  // interrogatives and question scaffolding
  "who", "whom", "whose", "what", "which", "when", "where", "why", "how",
  // meta words that index no content
  "many", "much", "count", "number", "amount", "list", "tell", "show",
  "give", "know", "think", "remember", "currently", "now", "today", "ago",
  "please", "thanks", "yes", "yeah",
]);

/**
 * Reduce a query to its content terms (lowercased, deduped, stop words and
 * single-letter fragments removed; numerals kept). Returns the trimmed original
 * query when no term survives.
 */
export function normalizeRetrievalQuery(query: string): string {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const kept = tokens.filter(
    (token) => token.length > 1 && (/^\d+$/.test(token) || !QUESTION_STOP_WORDS.has(token)),
  );
  const normalized = [...new Set(kept)].join(" ").trim();
  return normalized.length >= 2 ? normalized : query.trim();
}

/** Content terms of the normalized query, for token-level scoring. */
export function retrievalQueryTerms(query: string): string[] {
  const normalized = normalizeRetrievalQuery(query);
  return normalized.split(/\s+/).filter((term) => term.length > 0);
}
