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

// NOTE: this is NOT a superset of Postgres's english dictionary — pg also
// strips `after, because, all, each, before, during, while, until, just, some,
// most, any, both` and more, none of which are listed here. On the pg path that
// is harmless (to_tsvector filters again downstream), but the in-memory driver
// uses these terms as raw substring probes, so a missing entry like "all"
// becomes a live probe matching "call"/"small". Keep that asymmetry in mind
// before treating this list as authoritative for both drivers.
const QUESTION_STOP_WORDS = new Set([
  // English stop words (negators "no"/"not"/"nor" deliberately kept OUT —
  // stripping them flips meaning)
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
/**
 * Content terms with NO fallback: an all-stop-word input yields `[]`.
 *
 * This is the honest "does this text carry lexical signal?" question. Callers
 * that must not silently resurrect a stop-word-only query — the empty-tsquery
 * gate (F6/R7) and document-side token extraction — use this, not
 * `retrievalQueryTerms`, which deliberately falls back to the original text.
 */
export function contentTerms(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [
    ...new Set(
      tokens.filter((token) => token.length > 1 && (/^\d+$/.test(token) || !QUESTION_STOP_WORDS.has(token))),
    ),
  ];
}

export function normalizeRetrievalQuery(query: string): string {
  const normalized = contentTerms(query).join(" ").trim();
  return normalized.length >= 2 ? normalized : query.trim();
}

/** Content terms of the normalized query, for token-level scoring. */
export function retrievalQueryTerms(query: string): string[] {
  const normalized = normalizeRetrievalQuery(query);
  return normalized.split(/\s+/).filter((term) => term.length > 0);
}
