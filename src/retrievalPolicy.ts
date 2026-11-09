import type { SearchInput } from "./contracts.js";
import type { SearchArm, SearchObserver, SearchResultNode } from "./graphCore.js";

/** Report one arm to an observer without ever letting it break the search. */
export function reportSearchArm(
  observer: SearchObserver | undefined,
  arm: SearchArm,
  nodes: SearchResultNode[],
): void {
  if (!observer?.onArm) return;
  try {
    observer.onArm(arm, nodes);
  } catch {
    // Instrumentation is not allowed to fail a read.
  }
}

/** Compile a grep pattern; invalid regex degrades to a literal substring match. */
export function compileGrepPattern(pattern: string, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? "" : "i";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
}

export function grepExcerpt(text: string, regex: RegExp, radius = 120): string | null {
  const match = regex.exec(text);
  if (!match) return null;
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Catalog/log-style pages are useful as pointers but starve the pack if dumped whole. */
export const GIANT_CONTENT_CHARS = 12_000;

/**
 * Reciprocal Rank Fusion over the per-mode ranked lists: each item scores
 * 1/(60 + rank) per list it appears in (1-based rank), ordered by fused score.
 * Ties break to the best single-list rank, then id for determinism.
 */
export function reciprocalRankFusion<T extends { id: string }>(...lists: T[][]): T[] {
  const fused = new Map<string, { item: T; score: number; bestRank: number }>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const rank = index + 1;
      const existing = fused.get(item.id);
      if (existing) {
        existing.score += 1 / (60 + rank);
        existing.bestRank = Math.min(existing.bestRank, rank);
        const incoming = (item as { distance?: number }).distance;
        if (incoming !== undefined) {
          const current = (existing.item as { distance?: number }).distance;
          if (current === undefined || incoming < current) {
            existing.item = { ...existing.item, distance: incoming };
          }
        }
      } else {
        fused.set(item.id, { item, score: 1 / (60 + rank), bestRank: rank });
      }
    });
  }
  return [...fused.values()]
    .sort((left, right) =>
      right.score - left.score ||
      left.bestRank - right.bestRank ||
      left.item.id.localeCompare(right.item.id))
    .map((entry) => entry.item);
}

export function maxSemanticDistanceFor(input: SearchInput): number {
  if (typeof input.maxSemanticDistance === "number" && Number.isFinite(input.maxSemanticDistance)) {
    return input.maxSemanticDistance;
  }
  const fromEnv = Number(process.env.TROVE_SEMANTIC_MAX_DISTANCE);
  if (process.env.TROVE_SEMANTIC_MAX_DISTANCE && Number.isFinite(fromEnv)) return fromEnv;
  return 0.55;
}
