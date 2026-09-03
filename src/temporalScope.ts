/**
 * Temporal intent, read out of the recall query itself.
 *
 * Trove stores both time axes — edges carry world time (`validFrom`/
 * `validUntil`), revisions carry recorded time — and until now recall read
 * neither from the question. "What did the deploy process look like in
 * January" went to the lexical arm as `deploy process january`, where the
 * month name is ANDed into the tsquery and matches nothing (or worse, matches
 * a note that happens to say "January"), and to the ranker as no signal at
 * all. The retrieval literature is consistent that time-aware expansion is
 * worth roughly a dozen points of recall on questions like this, and that
 * organising on event time beats organising on when the conversation happened.
 *
 * This module is the parsing half: pure, no LLM, no store, no clock of its
 * own (pass `now`). It answers two questions — "is there a time in this
 * question, and which?" and "what is the question without it?" — and refuses
 * loudly-shaped but unresolvable phrasings rather than guessing. `graphCore`
 * owns the other half: what a parsed scope is allowed to do to a pack (a soft
 * reweight; see performRecall).
 *
 * What it deliberately does NOT parse:
 *   - event-relative time ("before the migration", "since the outage") — the
 *     anchor is a fact in the graph, not a date, and resolving it would need a
 *     retrieval pass of its own;
 *   - ranges ("from January to March", "between 2024 and 2025") and any query
 *     carrying a second date the matched phrase did not consume;
 *   - future time ("next week", "tomorrow") — recall answers from what is
 *     stored, and a future window would silently score everything alike;
 *   - numeric dates ("3/4/2026") — locale-ambiguous;
 *   - quarters and seasons ("Q1", "in the spring") — fiscal vs calendar, and
 *     hemispheric.
 * Every refusal returns `{ scope: null, query: <original> }`, which leaves
 * recall byte-identical to what it does today.
 */

export type TemporalScopeKind = "interval" | "recency";

export type TemporalScope = {
  /**
   * "interval": the answer should be about what was true in a world-time
   * window. "recency": the caller asked for the current state ("currently",
   * "these days", "the latest ..."), which is a preference, not a window.
   */
  kind: TemporalScopeKind;
  /** Inclusive ISO start of the window; null = unbounded ("before March", recency). */
  from: string | null;
  /** Exclusive ISO end of the window; null = unbounded ("since March", recency). */
  until: string | null;
  /** Human label an agent can echo back: "January 2026", "since March 2026", "the last 7 days", "now". */
  label: string;
  /** The exact text that was matched and removed from the query. */
  phrase: string;
};

export type TemporalParse = {
  /** Null whenever the query has no temporal intent, or has one we refuse to guess at. */
  scope: TemporalScope | null;
  /** The query with `scope.phrase` removed, for the lexical and semantic arms. Unchanged when scope is null. */
  query: string;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_INDEX = new Map<string, number>([
  ["jan", 0], ["january", 0],
  ["feb", 1], ["february", 1],
  ["mar", 2], ["march", 2],
  ["apr", 3], ["april", 3],
  ["may", 4],
  ["jun", 5], ["june", 5],
  ["jul", 6], ["july", 6],
  ["aug", 7], ["august", 7],
  ["sep", 8], ["sept", 8], ["september", 8],
  ["oct", 9], ["october", 9],
  ["nov", 10], ["november", 10],
  ["dec", 11], ["december", 11],
]);

const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
// A bare four-digit year, never the year half of an ISO or slash date.
const YEAR = "(?:19|20)\\d{2}(?![-/\\d])";
const DATE = `(?:${MONTH})(?:\\s+(?:of\\s+)?${YEAR})?|${YEAR}`;

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Decay constant for the "currently"/"latest" preference. Half a year: long
 * enough that a stable runbook written last spring still counts as current,
 * short enough that a note from three years ago loses to a fresh one.
 */
const RECENCY_DECAY_MS = 180 * DAY_MS;

/** Future intent: recall has nothing stored about it, so refuse the whole query. */
const FUTURE_RE = /\b(?:next\s+(?:week|month|year|quarter)|tomorrow|upcoming|forthcoming)\b/i;

/**
 * Any month or year token still present after the matched phrase is removed
 * means a second date we did not consume — "from January to March",
 * "between 2024 and 2025", "in January and again in March". Refuse rather than
 * answer about half of a range. "may" is excluded: as a leftover it is far
 * more often the modal verb than the month.
 */
const LEFTOVER_DATE_RE = new RegExp(
  `\\b(?:jan(?:uary)?|feb(?:ruary)?|march|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|${YEAR})\\b`,
  "i",
);

type Span = { start: number; end: number };

function isoUtc(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString();
}

/** Month with no year means the most recent one that has already begun. */
function resolveMonthYear(monthIndex: number, explicitYear: number | null, now: Date): number {
  if (explicitYear !== null) return explicitYear;
  const year = now.getUTCFullYear();
  return monthIndex <= now.getUTCMonth() ? year : year - 1;
}

type Anchor = { from: string; until: string; label: string };

/** Resolve "January", "January 2026" or "2026" to the window it names. */
function resolveDate(text: string, now: Date): Anchor | null {
  const cleaned = text.trim().toLowerCase().replace(/\s+of\s+/, " ");
  const yearOnly = /^(?:19|20)\d{2}$/.exec(cleaned);
  if (yearOnly) {
    const year = Number(cleaned);
    return { from: isoUtc(year, 0, 1), until: isoUtc(year + 1, 0, 1), label: String(year) };
  }
  const monthMatch = /^([a-z]+)(?:\s+((?:19|20)\d{2}))?$/.exec(cleaned);
  if (!monthMatch) return null;
  const monthIndex = MONTH_INDEX.get(monthMatch[1] ?? "");
  if (monthIndex === undefined) return null;
  const year = resolveMonthYear(monthIndex, monthMatch[2] ? Number(monthMatch[2]) : null, now);
  return {
    from: isoUtc(year, monthIndex, 1),
    until: isoUtc(year, monthIndex + 1, 1),
    label: `${MONTH_NAMES[monthIndex]} ${year}`,
  };
}

/** "last week" / "yesterday" as an anchor, for `since`/`before` to lean on. */
function resolveRelativeAnchor(text: string, now: Date): Anchor | null {
  const cleaned = text.trim().toLowerCase();
  if (cleaned === "yesterday") {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return {
      from: new Date(midnight - DAY_MS).toISOString(),
      until: new Date(midnight).toISOString(),
      label: "yesterday",
    };
  }
  const relative = /^last\s+(week|month|year)$/.exec(cleaned);
  if (!relative) return null;
  const days = relative[1] === "week" ? 7 : relative[1] === "month" ? 30 : 365;
  return {
    from: new Date(now.getTime() - days * DAY_MS).toISOString(),
    until: now.toISOString(),
    label: `the last ${days} days`,
  };
}

function rollingWindow(days: number, now: Date): Anchor {
  return {
    from: new Date(now.getTime() - days * DAY_MS).toISOString(),
    until: now.toISOString(),
    label: `the last ${days} days`,
  };
}

type Rule = {
  re: RegExp;
  build: (match: RegExpExecArray, now: Date) => Omit<TemporalScope, "phrase"> | null;
};

/**
 * Order is load-bearing: an earlier rule consumes its span, and a later rule
 * whose match overlaps it is skipped. "since last week" must be read by the
 * `since` rule, not split into a bare "last week" window.
 */
const RULES: Rule[] = [
  {
    // "since March", "since 2025", "after January 2026", "since last week"
    re: new RegExp(`\\b(?:since|after)\\s+(?:the\\s+)?(${DATE}|last\\s+(?:week|month|year)|yesterday)\\b`, "gi"),
    build: (match, now) => {
      const anchor = resolveDate(match[1] ?? "", now) ?? resolveRelativeAnchor(match[1] ?? "", now);
      if (!anchor) return null;
      return { kind: "interval", from: anchor.from, until: null, label: `since ${anchor.label}` };
    },
  },
  {
    // "before March 2026", "until 2025", "prior to January". A non-date anchor
    // ("before the migration") never matches, which is the point.
    re: new RegExp(`\\b(?:before|prior\\s+to|up\\s+to|until)\\s+(?:the\\s+)?(${DATE})\\b`, "gi"),
    build: (match, now) => {
      const anchor = resolveDate(match[1] ?? "", now);
      if (!anchor) return null;
      return { kind: "interval", from: null, until: anchor.from, label: `before ${anchor.label}` };
    },
  },
  {
    // "in the last 3 months", "over the past 10 days"
    re: /\b(?:in|over|within|during)?\s*the\s+(?:last|past)\s+(\d{1,3})\s+(day|week|month|year)s?\b/gi,
    build: (match, now) => {
      const count = Number(match[1]);
      const unit = (match[2] ?? "").toLowerCase();
      const perUnit = unit === "day" ? 1 : unit === "week" ? 7 : unit === "month" ? 30 : 365;
      const days = count * perUnit;
      if (!Number.isFinite(days) || days <= 0 || days > 20 * 365) return null;
      const anchor = rollingWindow(days, now);
      return { kind: "interval", from: anchor.from, until: anchor.until, label: anchor.label };
    },
  },
  {
    // "last week", "the past month", "previous year". Read as a rolling window
    // ending now rather than the previous calendar period: the boost is soft
    // and coarse, and a rolling window cannot fall off a month boundary.
    re: /\b(?:the\s+)?(?:last|past|previous)\s+(week|month|year)\b/gi,
    build: (match, now) => {
      const unit = (match[1] ?? "").toLowerCase();
      const days = unit === "week" ? 7 : unit === "month" ? 30 : 365;
      const anchor = rollingWindow(days, now);
      return { kind: "interval", from: anchor.from, until: anchor.until, label: anchor.label };
    },
  },
  {
    // "this week/month/year" — the calendar period to date.
    re: /\bthis\s+(week|month|year)\b/gi,
    build: (match, now) => {
      const unit = (match[1] ?? "").toLowerCase();
      let from: string;
      if (unit === "year") {
        from = isoUtc(now.getUTCFullYear(), 0, 1);
      } else if (unit === "month") {
        from = isoUtc(now.getUTCFullYear(), now.getUTCMonth(), 1);
      } else {
        // Weeks start Monday (ISO-8601), so "this week" on a Sunday still
        // means the six days behind it.
        const weekday = (now.getUTCDay() + 6) % 7;
        from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - weekday)).toISOString();
      }
      return { kind: "interval", from, until: now.toISOString(), label: `this ${unit}` };
    },
  },
  {
    re: /\byesterday\b/gi,
    build: (_match, now) => {
      const anchor = resolveRelativeAnchor("yesterday", now);
      if (!anchor) return null;
      return { kind: "interval", from: anchor.from, until: anchor.until, label: anchor.label };
    },
  },
  {
    // "in January", "during March 2026", "back in 2024"
    re: new RegExp(`\\b(?:in|during|back\\s+in)\\s+(${DATE})\\b`, "gi"),
    build: (match, now) => {
      const anchor = resolveDate(match[1] ?? "", now);
      if (!anchor) return null;
      return { kind: "interval", from: anchor.from, until: anchor.until, label: anchor.label };
    },
  },
  {
    // "January 2026" standing on its own. A bare month with no year and no
    // preposition is NOT matched: "may", "march" and "august" are ordinary
    // English words too often to risk it.
    re: new RegExp(`\\b(${MONTH})\\s+(${YEAR})\\b`, "gi"),
    build: (match, now) => {
      const anchor = resolveDate(`${match[1]} ${match[2]}`, now);
      if (!anchor) return null;
      return { kind: "interval", from: anchor.from, until: anchor.until, label: anchor.label };
    },
  },
  {
    // "currently", "right now", "these days", "the latest ..."
    re: /\b(?:currently|current(?=\s)|right\s+now|these\s+days|nowadays|at\s+the\s+moment|at\s+present|as\s+of\s+now|latest|most\s+recent(?:ly)?|recently|now)\b/gi,
    build: () => ({ kind: "recency", from: null, until: null, label: "now" }),
  },
];

function overlaps(span: Span, taken: Span[]): boolean {
  return taken.some((other) => span.start < other.end && span.end > other.start);
}

function stripSpans(query: string, spans: Span[]): string {
  const ordered = [...spans].sort((left, right) => left.start - right.start);
  let out = "";
  let cursor = 0;
  for (const span of ordered) {
    out += query.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  out += query.slice(cursor);
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([?.!,;:])/g, "$1")
    .trim();
}

/**
 * Read the temporal intent out of a recall query.
 *
 * Conservative by construction: exactly one scope must come out of the query,
 * with no second date left over, or nothing does.
 */
export function parseTemporalScope(query: string, options: { now?: Date } = {}): TemporalParse {
  const original = query;
  const nothing: TemporalParse = { scope: null, query: original };
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return nothing;
  if (FUTURE_RE.test(query)) return nothing;

  const taken: Span[] = [];
  const found: { scope: Omit<TemporalScope, "phrase">; span: Span }[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.re.exec(query)) !== null) {
      const span = { start: match.index, end: match.index + match[0].length };
      if (span.end === span.start) break;
      if (overlaps(span, taken)) continue;
      const scope = rule.build(match, now);
      if (!scope) continue;
      taken.push(span);
      found.push({ scope, span });
    }
  }
  if (found.length === 0) return nothing;

  // Two different readings of the same question ("in January ... these days")
  // is not a scope we can honour; identical readings of overlapping phrasings
  // ("in January 2026" matching both the prepositional and the bare rule) are.
  const distinct = new Set(found.map((entry) => `${entry.scope.kind}|${entry.scope.from}|${entry.scope.until}`));
  if (distinct.size !== 1) return nothing;

  const stripped = stripSpans(query, taken);
  if (LEFTOVER_DATE_RE.test(stripped)) return nothing;

  const first = found.reduce((left, right) => (left.span.start <= right.span.start ? left : right));
  const scope: TemporalScope = {
    ...first.scope,
    phrase: query.slice(first.span.start, first.span.end).trim(),
  };
  return { scope, query: stripped };
}

/**
 * How well a candidate fits the parsed scope, in [0,1]; null when the
 * candidate carries no evidence either way and should be treated as neutral.
 *
 * World time is the primary axis and the only one that can count against a
 * candidate: an edge that only became true in March is genuinely not an answer
 * about January. Recorded time (`updatedAt`) is the weak axis — Trove stores
 * no event time on a node, so a node written in September may still be a fact
 * about January — and is therefore allowed to add a match, never to subtract
 * one. That asymmetry is what keeps a heuristic parse from burying the right
 * note.
 */
export type TemporalFact = {
  /** Recorded time: when Trove last wrote this fact. NOT when the fact was true. */
  updatedAt: string;
  /** World-time validity of the edges recall can see touching this fact. */
  edges: ReadonlyArray<{ validFrom: string | null; validUntil: string | null }>;
};

export function temporalAffinity(scope: TemporalScope, fact: TemporalFact, now: Date): number | null {
  const updatedMs = Date.parse(fact.updatedAt);
  const nowMs = now.getTime();

  if (scope.kind === "recency") {
    // A relationship the graph says stopped being true is the one thing that
    // definitively is not "current".
    const live = fact.edges.filter((edge) => {
      const end = edge.validUntil ? Date.parse(edge.validUntil) : Number.POSITIVE_INFINITY;
      return !Number.isFinite(end) || end > nowMs;
    });
    if (fact.edges.length > 0 && live.length === 0) return 0;
    if (!Number.isFinite(updatedMs)) return null;
    return Math.exp(-Math.max(0, nowMs - updatedMs) / RECENCY_DECAY_MS);
  }

  const from = scope.from ? Date.parse(scope.from) : Number.NEGATIVE_INFINITY;
  const until = scope.until ? Date.parse(scope.until) : Number.POSITIVE_INFINITY;

  let world: number | null = null;
  for (const edge of fact.edges) {
    if (!edge.validFrom) continue;
    const start = Date.parse(edge.validFrom);
    if (!Number.isFinite(start)) continue;
    const end = edge.validUntil ? Date.parse(edge.validUntil) : Number.POSITIVE_INFINITY;
    world = Math.max(world ?? 0, start < until && end > from ? 1 : 0);
  }

  const recorded = Number.isFinite(updatedMs) && updatedMs >= from && updatedMs < until ? 1 : null;
  if (world === null) return recorded;
  return Math.max(world, recorded ?? 0);
}
