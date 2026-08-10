# Task-shaped evaluation (backlog #29) — design v1

## The question
Is Trove a better **working memory** for an agent doing multi-session work than a
plain scratchpad? Measures the four real jobs of agent memory — three of which are
**not** accuracy metrics:

1. **Context pickup** — retrieve a prior fact instead of re-asking/guessing.
2. **No re-derivation** — don't redo work already established.
3. **No stale-belief actions** — respect supersession when a belief changes.
4. **Auditability** — trace a claim to its source.

## Arms (the baseline must be a real contender, not a strawman)
- **trove** — agent uses a memory tool backed by a **local** Trove store (docker pg,
  fresh test owner; NEVER the hosted prod MCP). Tools: `recall(query)`,
  `remember(title, summary)`, `supersede(slug, newSummary)`, `read(slug)`.
- **scratchpad** — agent reads/writes a single `notes.md` (the "files are all you
  need" competitor). Tools: `read_notes()`, `write_notes(text)` (append/replace).
- **nomem** (control) — no persistence; fresh each session. Establishes whether
  memory matters for a given scenario at all.

## Agent
A bounded LLM loop per session (model via the key already in `.env`; deterministic
temp=0). Given: the session task + the arm's memory tools. It may call tools, then
emits a final answer. The **transcript + final answer** are what we score. Same
system prompt and tool budget across arms — only the memory backend differs.

## Scenario schema
```
{
  id, title,
  sessions: [
    { n, task,                 // the prompt the agent sees this session
      seeds: [ "fact to plant" ],     // facts the agent is TOLD this session (goes into memory if it chooses to save)
      supersedes?: { fact, old, new },// a belief change event
      score: {                        // deterministic checks on the final answer/transcript
        kind: "recall|no-rederive|fresh-belief|cite|control",
        expect: "...", must_not: "..." } } ]
}
```

## Metrics (per arm, averaged over scenarios × 3 seeds)
| Metric | Definition | Dir |
|---|---|---|
| context_pickup | fraction of `recall` sessions whose answer contains the planted fact | ↑ |
| rederivation | fraction of sessions where the agent redid established work (transcript re-computes a known fact instead of retrieving) | ↓ |
| stale_belief | fraction of `fresh-belief` sessions where the answer uses the OLD superseded value | ↓ |
| citation | fraction of `cite` sessions where the answer names the source/decision | ↑ |
| tokens / latency | mean context tokens + wall-time per session | ↓ |

## Worked scenario (one of ~4): "Billing policy over 6 sessions"
1. **task**: "Record our refund rule." **seed**: "Annual plans are non-refundable after 14 days." → good agent saves it.
2. **task**: "Who owns churn emails? Record it." **seed**: "Customer Success owns churn emails."
3. **task**: "A customer on an annual plan asks for a refund on day 10. What's our policy?" **score**: recall → answer must contain "14 days" / "non-refundable after 14". (context pickup; scratchpad can also pass if it grepped notes)
4. **task**: "Policy change: annual plans are now refundable within 30 days." **supersedes**: {old:"14 days non-refundable", new:"refundable within 30 days"} → good agent supersedes, not append-duplicate.
5. **task**: "Customer on annual plan wants a refund on day 20. Policy?" **score**: fresh-belief → answer must use **30 days / refundable**, must_not use "14 days / non-refundable". (THE supersession test — where Trove should beat a scratchpad that kept both lines.)
6. **task**: "Where did our current refund policy come from?" **score**: cite → answer must reference the session-4 decision / its source.

Controls: 1-2 sessions where the answer is derivable from the task alone (no memory
needed) — **both arms must tie**; if trove "wins" a control, the harness is rigged.

## Anti-rigging safeguards (this repo's recurring failure mode)
- Scratchpad is a *fair* contender: same tool budget, can read/write freely; a
  well-kept notes.md legitimately passes context-pickup.
- Include controls (memory-irrelevant tasks) — a spurious trove win there = red flag.
- Report the **cost triple** next to every accuracy-ish number (tokens/latency).
- 3 seeds/scenario; report variance. State scenario count next to every number.
- Deterministic scoring (string/section checks), not an LLM judge, for v1.

## v1 scope
4 scenarios × 5-6 sessions × 3 arms × 3 seeds. Local Trove (fresh owner), no prod
writes. Output: the metric table + cost triple + per-session miss list.

## Explicitly NOT claimed by v1
Synthetic scenarios = authored world → a *design* prior, not field truth. v1 shows
directional behavior under controlled scenarios; a real-session replay (deferred)
is what would make it field-defensible.
