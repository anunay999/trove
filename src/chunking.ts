import { randomUUID } from "node:crypto";
import type { TextUnit } from "./contracts.js";
import { sha256 } from "./graphCore.js";

export function splitTextUnits(sourceId: string, contentText: string): TextUnit[] {
  const units: TextUnit[] = [];
  const sections: string[] = [];
  const blockPattern = /[^\n](?:.*[^\n])?/g;
  let match: RegExpExecArray | null;
  let ordinal = 0;

  while ((match = blockPattern.exec(contentText)) !== null) {
    const text = match[0] ?? "";
    const heading = /^(#{1,6})\s+(.+)$/.exec(text);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      sections.splice(level - 1);
      sections[level - 1] = heading[2] ?? text;
    }

    units.push({
      id: randomUUID(),
      sourceId,
      ordinal,
      sectionPath: sections.filter(Boolean),
      charStart: match.index,
      charEnd: match.index + text.length,
      text,
      contentSha256: sha256(text),
    });
    ordinal += 1;
  }

  return units;
}

/**
 * Target size of a text chunk, in characters of unit text. The context prefix
 * rides on top and is not counted.
 *
 * Text units are LINES (splitTextUnits above splits on newlines), averaging 187
 * bytes in production, and one vector per line is what filled the disk on
 * 3 September: 70,479 of the 71,929 vectors were per-line, 98% of the vector
 * bytes. A line is also the wrong grain to embed — "…and that is why we moved
 * off Railway." carries almost no retrievable meaning on its own.
 *
 * 1200 characters is ~300 tokens, the size range Anthropic's contextual-
 * retrieval work uses, and at the production average it gathers ~6 lines into
 * one vector. Changing it changes nothing about citations: the chunk is only
 * what gets EMBEDDED. See buildTextChunks.
 */
export const CHUNK_TARGET_CHARS = 1200;

/**
 * A contiguous run of text units within one source, and the grain the vector
 * index is built on. `firstOrdinal`..`lastOrdinal` is the run it covers, which
 * is how a semantic hit resolves back to the text units it must cite.
 */
export type TextChunk = {
  id: string;
  sourceId: string;
  /** Dense index of the chunk within its source. */
  ordinal: number;
  /** First and last text_unit.ordinal covered, inclusive. */
  firstOrdinal: number;
  lastOrdinal: number;
  /** Section the whole run belongs to; a chunk never straddles two. */
  sectionPath: string[];
  /** The written context the chunk is embedded WITH (never cited). */
  contextPrefix: string;
  /** The units' own text, joined by newlines. */
  text: string;
  /** sha256 of the exact embedding input, so a changed prefix re-embeds. */
  contentSha256: string;
};

/**
 * The context prefix Anthropic's contextual retrieval calls for, built from
 * what we already know for free and can state truthfully: the source's title
 * and the section the run sits in. No LLM call, so it costs nothing per chunk
 * and cannot hallucinate — the reported win there came from situating the
 * chunk in its document, which a title and a section path already do.
 */
export function chunkContextPrefix(sourceTitle: string, sectionPath: string[]): string {
  const section = sectionPath.filter(Boolean).join(" › ");
  return section ? `Source: ${sourceTitle} — Section: ${section}` : `Source: ${sourceTitle}`;
}

/** The exact text handed to the embedding provider for a chunk. */
export function chunkEmbeddingInput(chunk: { contextPrefix: string; text: string }): string {
  return `${chunk.contextPrefix}\n\n${chunk.text}`;
}

/**
 * Whether a text unit is worth counting toward a chunk's substance.
 *
 * Must stay in step with EMBEDDABLE_TEXT_UNIT in pgStore, which is the same
 * predicate in SQL: horizontal rules, markdown table separators and
 * sub-12-character fragments carry no meaning. They still ride INSIDE a chunk
 * (dropping them would break the contiguous ordinal range a chunk resolves
 * through); what this decides is whether a chunk made of nothing else is worth
 * a vector at all.
 */
export function isEmbeddableUnitText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12) return false;
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) return false;
  if (/^\|?(\s*:?-+:?\s*\|)+\s*$/.test(trimmed)) return false;
  return true;
}

/**
 * Group a source's text units into the chunks the vector index is built on.
 *
 * Two boundaries, in this order: a chunk never straddles a `section_path`
 * change (a heading is a real topic break, and splitTextUnits already opens
 * the new section with its heading line, so a chunk starts with its own
 * heading), and a chunk closes before it would pass CHUNK_TARGET_CHARS. A
 * single unit longer than the target becomes its own chunk rather than being
 * split — the unit is the citation grain and must stay whole.
 *
 * Both drivers call this so the memory driver chunks exactly as Postgres does,
 * and the refresh job calls it to chunk sources ingested before chunking
 * existed — one implementation, so a backfilled chunk is byte-identical to a
 * freshly ingested one.
 */
export function buildTextChunks(sourceId: string, sourceTitle: string, units: TextUnit[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  const ordered = [...units].sort((left, right) => left.ordinal - right.ordinal);
  const sectionKey = (path: string[]): string => path.join("\u0000");
  let run: TextUnit[] = [];
  let runChars = 0;

  // Nothing embeddable in the whole run (a stretch of rules or separators) is
  // not worth a vector; skipping it leaves those units unembedded, as before.
  const emit = (grouped: TextUnit[]): void => {
    const first = grouped[0];
    const last = grouped[grouped.length - 1];
    if (!first || !last) return;
    if (!grouped.some((unit) => isEmbeddableUnitText(unit.text))) return;
    const text = grouped.map((unit) => unit.text).join("\n");
    const contextPrefix = chunkContextPrefix(sourceTitle, first.sectionPath);
    chunks.push({
      id: randomUUID(),
      sourceId,
      ordinal: chunks.length,
      firstOrdinal: first.ordinal,
      lastOrdinal: last.ordinal,
      sectionPath: first.sectionPath,
      contextPrefix,
      text,
      contentSha256: sha256(chunkEmbeddingInput({ contextPrefix, text })),
    });
  };

  for (const unit of ordered) {
    const head = run[0];
    const sectionChanged = head !== undefined && sectionKey(head.sectionPath) !== sectionKey(unit.sectionPath);
    const wouldOverflow = run.length > 0 && runChars + 1 + unit.text.length > CHUNK_TARGET_CHARS;
    if (sectionChanged || wouldOverflow) {
      emit(run);
      run = [];
      runChars = 0;
    }
    runChars += (run.length === 0 ? 0 : 1) + unit.text.length;
    run.push(unit);
  }
  emit(run);

  return chunks;
}
