/**
 * Shared helpers for turning Scribe/Obsidian vault pages into graph atoms.
 * Used by the vault importer and the content backfill so both write full-page
 * bodies (not stub pointers) and attach useful evidence text units.
 */
import type { CaptureInput, TextUnit } from "./contracts.js";
import { slugify } from "./slug.js";

export const STUB_CONTENT_MARKER = "The source document remains the evidence layer.";

export function isStubContent(content: string | null | undefined): boolean {
  if (!content) return true;
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.includes(STUB_CONTENT_MARKER)) return true;
  if (/^Imported from .+\. The source document remains the evidence layer\.$/.test(trimmed)) return true;
  return false;
}

export function parseFrontmatter(markdown: string): { frontmatter: Record<string, string>; body: string } {
  if (!markdown.startsWith("---\n")) {
    return { frontmatter: {}, body: markdown };
  }
  const close = markdown.indexOf("\n---", 4);
  if (close === -1) {
    return { frontmatter: {}, body: markdown };
  }
  const raw = markdown.slice(4, close).trim();
  const frontmatter: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    frontmatter[match[1] ?? ""] = (match[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: markdown.slice(close + 4).trim() };
}

export function titleFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const withoutExt = base.replace(/\.md$/i, "");
  return withoutExt
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Prefer a TL;DR block, then the first real prose paragraph (not a heading/table). */
export function pageSummary(body: string, fallbackTitle: string): string {
  const tldrHeading = /(?:^|\n)##?\s*TL;?DR[^\n]*\n+([\s\S]*?)(?=\n##|\s*$)/i.exec(body);
  if (tldrHeading?.[1]) {
    const text = collapseWs(tldrHeading[1]);
    if (text.length > 20) return text.slice(0, 500);
  }

  const blockquote = /(?:^|\n)>\s*\*?\*?TL;?DR\*?\*?[.:]?\s*([\s\S]*?)(?=\n[^>]|\n*$)/i.exec(body);
  if (blockquote?.[1]) {
    const text = collapseWs(blockquote[1].replace(/^>\s?/gm, ""));
    if (text.length > 20) return text.slice(0, 500);
  }

  const paragraphs = body.split(/\n\s*\n/);
  for (const raw of paragraphs) {
    const line = collapseWs(raw);
    if (line.length < 20) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("|")) continue;
    if (line.startsWith("```")) continue;
    if (/^[-*]\s/.test(line) && line.length < 40) continue;
    return line.slice(0, 500);
  }

  const first = firstUsefulLine(body);
  return first ?? `${fallbackTitle} (imported from Scribe vault).`;
}

export function firstUsefulLine(body: string): string | null {
  const line = body
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && !candidate.startsWith("#") && !candidate.startsWith("|"));
  return line ? collapseWs(line).slice(0, 300) : null;
}

export function isUsefulEvidenceUnit(unit: Pick<TextUnit, "text">): boolean {
  const text = unit.text.trim();
  if (text.length === 0) return false;
  if (text === "---") return false;
  if (/^[A-Za-z0-9_-]+:\s/.test(text) && text.length < 80) return false; // bare frontmatter line
  if (/^```/.test(text) && text.length < 10) return false;
  return true;
}

/**
 * Pick a useful subset of text units for evidence annotations:
 * headings + the first substantial paragraph under each H2, capped.
 */
export function selectEvidenceUnits(textUnits: TextUnit[], limit = 24): TextUnit[] {
  const useful = textUnits.filter(isUsefulEvidenceUnit);
  if (useful.length <= limit) return useful;

  const selected: TextUnit[] = [];
  const seen = new Set<string>();
  const push = (unit: TextUnit): void => {
    if (seen.has(unit.id) || selected.length >= limit) return;
    seen.add(unit.id);
    selected.push(unit);
  };

  for (const unit of useful) {
    if (/^#{1,3}\s+/.test(unit.text.trim())) push(unit);
  }

  let lastWasHeading = false;
  for (const unit of useful) {
    const text = unit.text.trim();
    if (/^#{1,3}\s+/.test(text)) {
      lastWasHeading = true;
      continue;
    }
    if (lastWasHeading && text.length >= 40) {
      push(unit);
      lastWasHeading = false;
    }
  }

  for (const unit of useful) {
    if (selected.length >= limit) break;
    if (unit.text.trim().length >= 80) push(unit);
  }

  for (const unit of useful) {
    if (selected.length >= limit) break;
    push(unit);
  }

  return selected;
}

export function evidenceRefsFromUnits(textUnits: TextUnit[], sourceId?: string): Array<{
  sourceId?: string;
  textUnitId?: string;
  selector: Record<string, unknown>;
}> {
  const selected = selectEvidenceUnits(textUnits);
  if (selected.length === 0 && sourceId) {
    return [{ sourceId, selector: {} }];
  }
  return selected.map((unit) => ({ textUnitId: unit.id, selector: {} }));
}

export function nodeTypeFromPath(path: string): CaptureInput["type"] {
  const [folder] = path.replace(/\\/g, "/").split("/");
  switch (folder) {
    case "projects":
      return "project";
    case "patterns":
      return "pattern";
    case "domains":
      return "domain";
    case "people":
      return "person";
    case "infrastructure":
      return "infrastructure";
    case "sources":
      return "entity";
    case "decisions":
      return "decision";
    case "concepts":
      return "entity";
    case "references":
      return "entity";
    case "prs":
      return "entity";
    default:
      return slugify(path).includes("decision") ? "decision" : "entity";
  }
}

export function extractWikilinkSlugs(markdown: string): string[] {
  const slugs = new Set<string>();
  const regex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget) continue;
    const basenameTarget = rawTarget.split("/").filter(Boolean).at(-1) ?? rawTarget;
    slugs.add(slugify(basenameTarget));
  }

  return [...slugs];
}

function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
