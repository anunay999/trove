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
