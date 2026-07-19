/* eslint-disable */
// bench/providers/trove/prompts.ts
//
// MemoryBench lets a provider override two prompts: `answerPrompt` (how its own
// search results are rendered for the answering model) and `judgePrompt` (how
// answers are graded).
//
// We override answerPrompt ONLY. Overriding the judge lets a provider be graded
// against a rubric of its own writing while its competitors are graded against
// the built-in one, which makes the comparison meaningless. Upstream, `zep` is
// the only provider that does this (src/providers/zep/prompts.ts:130) — see
// bench/README.md for how we neutralize that when running the comparison.
//
// Do not add a judgePrompt export here. If Trove ever needs one to score fairly,
// that is evidence the shared judge is wrong for everyone and belongs upstream.

type TroveResult = {
  title?: string;
  summary?: string;
  content?: string;
  hops?: number;
  evidence?: string[];
};

export function buildTroveAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string,
): string {
  const atoms = (context as TroveResult[]) ?? [];

  const rendered = atoms.length
    ? atoms
        .map((atom, index) => {
          const lines = [`[${index + 1}] ${atom.title ?? "(untitled)"}`];
          if (atom.summary) lines.push(atom.summary);
          if (atom.content && atom.content !== atom.summary) lines.push(atom.content);
          // Evidence is what separates Trove from a flat vector store: each atom
          // carries the source text that justifies it. Show it so the answering
          // model can prefer a cited claim over an uncited one.
          if (atom.evidence?.length) {
            lines.push(`Source text: ${atom.evidence.join(" … ")}`);
          }
          return lines.join("\n");
        })
        .join("\n\n")
    : "(no memories retrieved)";

  const asOf = questionDate ? `The current date is ${questionDate}.\n` : "";

  return `${asOf}Answer the question using only the memories below. Each memory was recorded on a specific date.

If several memories conflict, the most recently recorded one is the current truth — answer with that value and ignore the superseded ones. If the memories do not contain the answer, say you don't know rather than guessing.

Memories:
${rendered}

Question: ${question}

Answer concisely and directly.`;
}

export const trovePrompts = {
  answerPrompt: buildTroveAnswerPrompt,
  // judgePrompt intentionally omitted — see the note at the top of this file.
};

export default trovePrompts;
