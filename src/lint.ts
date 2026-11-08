import type { GraphLintFinding, ReconcileFlagCode } from "./graphCore.js";

/** Lint finding for an edge that supersessionRevivedBy has stopped honouring. */
export function revisedAfterSupersededFinding(input: { edgeId: string; fromTitle: string; toTitle: string }): GraphLintFinding {
  return {
    severity: "warning",
    code: "revised_after_superseded",
    entityTable: "edge",
    entityId: input.edgeId,
    message:
      `"${input.toTitle}" was revised after "${input.fromTitle}" superseded it, so recall shows both as current. ` +
      "Decide which is true: connect the current one with predicate supersedes, or forget the edge or the stale note.",
  };
}

/** Lint code per reconcile flag — what the dashboard and the curate prompt see. */
export const RECONCILE_LINT_CODE: Record<ReconcileFlagCode, string> = {
  possible_duplicate: "reconcile_duplicate",
  contradiction_candidate: "reconcile_contradiction",
};

/** At most this many reconcile findings per lint run, matching its sibling passes. */
export const RECONCILE_FINDING_LIMIT = 50;

/**
 * Render one reconcile flag as a lint finding. Shared by both drivers so they
 * produce identical messages, and so the ids an agent needs in order to act on
 * it (`read` both, `connect` the pair, `forget` one) survive inside the
 * existing finding shape: `entityId` is the flagged node, and the other node's
 * slug and id ride in the message.
 *
 * Both severities are `warning`, not `error`: lint reserves `error` for a
 * structurally broken graph (an edge pointing at nothing). A judged
 * contradiction is a fact-level conflict for a person to resolve — the same
 * class as `duplicate_title`, however much it deserves attention.
 */
export function reconcileLintFinding(flag: {
  code: ReconcileFlagCode;
  node: { id: string; title: string; slug: string };
  other: { id: string; title: string; slug: string };
  detail: string;
}): GraphLintFinding {
  const duplicate = flag.code === "possible_duplicate";
  const detail = flag.detail.trim().slice(0, 200);
  return {
    severity: "warning",
    code: RECONCILE_LINT_CODE[flag.code],
    entityTable: "node",
    entityId: flag.node.id,
    message:
      `Reconciliation judged "${flag.node.title}" (${flag.node.slug}, ${flag.node.id}) ` +
      `${duplicate ? "a duplicate of" : "in contradiction with"} ` +
      `"${flag.other.title}" (${flag.other.slug}, ${flag.other.id})` +
      (detail ? `: ${detail}` : "."),
  };
}
