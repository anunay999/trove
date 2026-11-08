import { contentTerms } from "./queryNormalize.js";

/**
 * Provenance quality (backlog #17): does the cited span actually support the
 * atom? Scored as containment — the share of the node's content terms that
 * appear in its best-matching cited unit. An atom is a distillation of its
 * evidence, so most of its terms should come from the source text; a best
 * score below WEAK_EVIDENCE_FLOOR means the citation is present but probably
 * wrong. Heuristic, not entailment: paraphrases can score low honestly, which
 * is why the lint finding is a warning for review, never an error.
 */
export const WEAK_EVIDENCE_FLOOR = 0.15;

/**
 * A `supersedes` edge judges the belief its target held when the edge was
 * recorded. When the target later gets a new fact revision (remember revised
 * its title/summary/content), that revision re-asserts the note, so the old
 * edge must stop marking it SUPERSEDED: otherwise recall labels the freshest
 * value outdated and points readers at the stale successor. Strictly-after,
 * so a revision and a link written in the same transaction still count.
 */
export function supersessionRevivedBy(targetRevisionCreatedAt: string | null | undefined, edgeRecordedAt: string): boolean {
  if (!targetRevisionCreatedAt) return false;
  return Date.parse(targetRevisionCreatedAt) > Date.parse(edgeRecordedAt);
}

/**
 * Minimum containment for a fuzzy quote match to be returned by the drivers
 * at all (backlog #9a). Below this the "closest" span shares less than half
 * the quote's terms — reporting it as a candidate would invite a wrong
 * citation. The higher ACCEPT floor/margin lives in agentOps.remember, which
 * decides whether a candidate may be cited automatically.
 */
export const FUZZY_QUOTE_CANDIDATE_FLOOR = 0.5;

export function evidenceSupportScore(nodeText: string, unitTexts: string[]): number {
  const nodeTerms = new Set(contentTerms(nodeText));
  if (nodeTerms.size === 0) return 1; // nothing to support — don't flag
  let best = 0;
  for (const text of unitTexts) {
    const unitTerms = new Set(contentTerms(text));
    let shared = 0;
    for (const term of nodeTerms) if (unitTerms.has(term)) shared += 1;
    best = Math.max(best, shared / nodeTerms.size);
  }
  return best;
}

/**
 * Does a citation attached for an earlier revision contradict the revised
 * note? Evidence attaches to the node, not the revision, so changing
 * "port is 8787" to "port is 9090" keeps the 8787 quote underneath the new
 * value. Term containment cannot see this (the quote still shares most
 * terms), so compare what the revision changed: the unit contradicts when it
 * states a term the revision removed and none of the terms it added. Pure
 * additions or deletions are not value changes and never flag.
 * Returns the removed terms the unit still states, or null.
 */
export function citationContradictsRevision(previousText: string, revisedText: string, unitText: string): string[] | null {
  const before = new Set(contentTerms(previousText));
  const after = new Set(contentTerms(revisedText));
  const removed = [...before].filter((term) => !after.has(term));
  const added = [...after].filter((term) => !before.has(term));
  if (removed.length === 0 || added.length === 0) return null;
  const unit = new Set(contentTerms(unitText));
  if (added.some((term) => unit.has(term))) return null;
  const stated = removed.filter((term) => unit.has(term));
  return stated.length > 0 ? stated : null;
}
