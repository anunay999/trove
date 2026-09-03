import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTemporalScope, temporalAffinity, type TemporalScope } from "../src/temporalScope.js";

// A fixed clock, so "in January" and "last week" mean the same thing in this
// suite forever. 2026-09-03 is a Thursday.
const NOW = new Date("2026-09-03T12:00:00.000Z");

type Expected = Pick<TemporalScope, "kind" | "from" | "until" | "label">;

const day = (iso: string): string => new Date(iso).toISOString();
const before = (days: number): string => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
const RECENCY: Expected = { kind: "recency", from: null, until: null, label: "now" };

describe("parseTemporalScope grammar", () => {
  const parses: [string, Expected][] = [
    // Explicit points and windows.
    ["what did the deploy process look like in January", {
      kind: "interval", from: day("2026-01-01"), until: day("2026-02-01"), label: "January 2026",
    }],
    ["what did we ship in January 2025?", {
      kind: "interval", from: day("2025-01-01"), until: day("2025-02-01"), label: "January 2025",
    }],
    // A bare month resolves to the most recent one that has already begun.
    ["what broke in October", {
      kind: "interval", from: day("2025-10-01"), until: day("2025-11-01"), label: "October 2025",
    }],
    ["who owned billing during Dec 2024", {
      kind: "interval", from: day("2024-12-01"), until: day("2025-01-01"), label: "December 2024",
    }],
    ["September 2024 postmortem findings", {
      kind: "interval", from: day("2024-09-01"), until: day("2024-10-01"), label: "September 2024",
    }],
    ["what did we decide in 2026", {
      kind: "interval", from: day("2026-01-01"), until: day("2027-01-01"), label: "2026",
    }],
    // Open-ended.
    ["what has changed since March", {
      kind: "interval", from: day("2026-03-01"), until: null, label: "since March 2026",
    }],
    ["how did billing work before January 2026", {
      kind: "interval", from: null, until: day("2026-01-01"), label: "before January 2026",
    }],
    // Relative, against the injected clock.
    ["what did I work on last week", { kind: "interval", from: before(7), until: NOW.toISOString(), label: "the last 7 days" }],
    ["decisions in the last 3 months", { kind: "interval", from: before(90), until: NOW.toISOString(), label: "the last 90 days" }],
    ["what did I do yesterday", {
      kind: "interval", from: day("2026-09-02"), until: day("2026-09-03"), label: "yesterday",
    }],
    // Recency cues.
    ["which database do we use currently", RECENCY],
    ["how do we deploy these days", RECENCY],
    ["what is the latest runbook for the job queue", RECENCY],
    ["what port does the app use right now", RECENCY],
  ];

  for (const [query, expected] of parses) {
    it(`parses ${JSON.stringify(query)}`, () => {
      const parsed = parseTemporalScope(query, { now: NOW });
      assert.ok(parsed.scope, `expected a scope for ${query}`);
      const { kind, from, until, label } = parsed.scope;
      assert.deepEqual({ kind, from, until, label }, expected);
      assert.ok(parsed.scope.phrase.length > 0, "a parsed scope must name the phrase it consumed");
      assert.ok(
        !parsed.query.toLowerCase().includes(parsed.scope.phrase.toLowerCase()),
        `the temporal phrase must be stripped from the query, got ${JSON.stringify(parsed.query)}`,
      );
    });
  }

  // Everything here is a shape we refuse on purpose. A refusal is not a gap:
  // it means recall behaves exactly as it does today.
  const refuses: [string, string][] = [
    ["how did deploys work before the migration", "event-relative anchors are not dates"],
    ["what changed after the outage", "same, for after"],
    ["what shipped from January to March", "ranges are not parsed"],
    ["what happened between 2024 and 2025", "ranges are not parsed"],
    ["what are we shipping next week", "future intent has nothing stored"],
    ["what is on the roadmap for tomorrow", "future intent has nothing stored"],
    ["what did we do in January and again in March", "a second date the match did not consume"],
    ["what did we decide in Q1", "quarters are fiscal-vs-calendar ambiguous"],
    ["what did we plant in the spring", "seasons are hemispheric"],
    ["what shipped on 3/4/2026", "numeric dates are locale-ambiguous"],
    ["how do we handle refunds for annual plans", "no temporal intent at all"],
    ["we may deploy the queue worker to staging", "a bare month word with no preposition is just a word"],
    ["what did we use in January and what do we use now", "an interval and a recency cue disagree"],
  ];

  for (const [query, why] of refuses) {
    it(`refuses ${JSON.stringify(query)} — ${why}`, () => {
      const parsed = parseTemporalScope(query, { now: NOW });
      assert.equal(parsed.scope, null, `expected no scope for ${query}`);
      assert.equal(parsed.query, query, "a refusal must return the query untouched");
    });
  }

  it("strips only the temporal phrase and leaves the question searchable", () => {
    const parsed = parseTemporalScope("what did the deploy process look like in January?", { now: NOW });
    assert.equal(parsed.query, "what did the deploy process look like?");
  });

  it("resolves relative expressions against the injected clock, not the wall clock", () => {
    const early = parseTemporalScope("what shipped in October", { now: new Date("2026-11-01T00:00:00.000Z") });
    const late = parseTemporalScope("what shipped in October", { now: new Date("2026-09-03T00:00:00.000Z") });
    assert.equal(early.scope?.from, day("2026-10-01"));
    assert.equal(late.scope?.from, day("2025-10-01"));
  });
});

describe("temporalAffinity", () => {
  const january: TemporalScope = {
    kind: "interval", from: day("2026-01-01"), until: day("2026-02-01"), label: "January 2026", phrase: "in January",
  };

  it("scores an edge that was true in the window over one that began after it", () => {
    const inWindow = temporalAffinity(january, {
      updatedAt: NOW.toISOString(),
      edges: [{ validFrom: day("2026-01-15"), validUntil: null }],
    }, NOW);
    const after = temporalAffinity(january, {
      updatedAt: NOW.toISOString(),
      edges: [{ validFrom: day("2026-03-15"), validUntil: null }],
    }, NOW);
    assert.equal(inWindow, 1);
    assert.equal(after, 0);
  });

  it("counts an older open edge as true during the window", () => {
    const affinity = temporalAffinity(january, {
      updatedAt: NOW.toISOString(),
      edges: [{ validFrom: day("2024-06-01"), validUntil: null }],
    }, NOW);
    assert.equal(affinity, 1, "a relationship that began in 2024 and never ended was true in January");
  });

  it("lets recorded time add a match but never subtract one", () => {
    const written = temporalAffinity(january, { updatedAt: day("2026-01-20"), edges: [] }, NOW);
    assert.equal(written, 1, "a fact written in January is evidence about January");
    const silent = temporalAffinity(january, { updatedAt: NOW.toISOString(), edges: [] }, NOW);
    assert.equal(silent, null, "a fact with no dated evidence is neutral, not a miss");
  });

  it("treats a relationship that has ended as not current", () => {
    const ended = temporalAffinity({ ...january, kind: "recency", from: null, until: null, label: "now" }, {
      updatedAt: NOW.toISOString(),
      edges: [{ validFrom: day("2024-01-01"), validUntil: day("2025-01-01") }],
    }, NOW);
    assert.equal(ended, 0);
  });

  it("decays recency by how long ago the fact was last written", () => {
    const recency: TemporalScope = { kind: "recency", from: null, until: null, label: "now", phrase: "currently" };
    const fresh = temporalAffinity(recency, { updatedAt: NOW.toISOString(), edges: [] }, NOW);
    const stale = temporalAffinity(recency, { updatedAt: day("2022-01-01"), edges: [] }, NOW);
    assert.ok(fresh !== null && stale !== null);
    assert.ok(fresh > stale, "a fresher fact must score higher for a 'currently' question");
    assert.ok(fresh <= 1 && stale >= 0);
  });
});
