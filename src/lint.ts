import { evidenceSupportScore, WEAK_EVIDENCE_FLOOR } from "./evidence.js";
import type { GraphLintFinding, GraphLintReport, ReconcileFlagCode } from "./graphCore.js";

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

/** At most this many findings per pass, so one bulk mistake cannot flood the report. */
export const LINT_FINDING_LIMIT = 50;

/** The text weak-evidence scoring reads for a note: its title, summary and the head of its body. */
export function lintNodeText(node: { title: string; summary: string | null; content: string | null }): string {
  return `${node.title}\n${node.summary ?? ""}\n${(node.content ?? "").slice(0, 2000)}`;
}

/** What each driver gathers; buildLintReport turns it into findings. */
export type LintData = {
  nodes: number;
  edges: number;
  orphans: Array<{ id: string; title: string }>;
  missingEvidence: Array<{ id: string; title: string }>;
  duplicateTitles: Array<{ title: string; count: number }>;
  danglingEdgeIds: string[];
  /** Notes with text-unit citations, and the text of every cited unit. */
  cited: Array<{ id: string; title: string; nodeText: string; units: string[] }>;
  revivedSupersessions: Array<{ edgeId: string; fromTitle: string; toTitle: string }>;
  reconcileFlags: Array<{ code: ReconcileFlagCode; node: { id: string; title: string; slug: string }; other: { id: string; title: string; slug: string }; detail: string }>;
};

export function buildLintReport(data: LintData): GraphLintReport {
  const cap = <T>(rows: T[]) => rows.slice(0, LINT_FINDING_LIMIT);
  const findings: GraphLintFinding[] = [
    ...cap(data.orphans).map((node): GraphLintFinding => ({
      severity: "warning", code: "orphan_node", entityTable: "node", entityId: node.id, message: `Node has no graph edges: ${node.title}`,
    })),
    ...cap(data.missingEvidence).map((node): GraphLintFinding => ({
      severity: "warning", code: "missing_evidence", entityTable: "node", entityId: node.id, message: `Node has no evidence annotation: ${node.title}`,
    })),
    ...cap(data.duplicateTitles).map((row): GraphLintFinding => ({
      severity: "warning", code: "duplicate_title", count: row.count, message: `Multiple nodes share title: ${row.title}`,
    })),
    ...cap(data.danglingEdgeIds).map((id): GraphLintFinding => ({
      severity: "error", code: "dangling_edge", entityTable: "edge", entityId: id, message: "Edge points at a missing or deleted node.",
    })),
    // weak_evidence: a citation that is present but probably wrong.
    ...cap(data.cited.flatMap((node): GraphLintFinding[] => {
      const score = evidenceSupportScore(node.nodeText, node.units);
      return score < WEAK_EVIDENCE_FLOOR
        ? [{
          severity: "warning",
          code: "weak_evidence",
          entityTable: "node",
          entityId: node.id,
          message: `Cited evidence supports ${(score * 100).toFixed(0)}% of the node's content terms (floor ${WEAK_EVIDENCE_FLOOR * 100}%): ${node.title}`,
        }]
        : [];
    })),
    ...cap(data.revivedSupersessions).map(revisedAfterSupersededFinding),
    ...cap(data.reconcileFlags).map(reconcileLintFinding),
  ];
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      nodes: data.nodes,
      edges: data.edges,
      findings: findings.length,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
    },
    findings,
  };
}
