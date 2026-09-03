# How agents should use Trove

> Trove is a **working memory graph**, not an end-of-day diary.
> The failure mode is one `remember` at wrap-up. The success mode is: load context before work, write as beliefs form, link them, correct with supersession, leave evidence.

This guide is for **any LLM** with Trove MCP (Claude Code, Cursor, Codex, claude.ai connectors, custom hosts). Claude-specific skills (`npx skills add anunay999/trove -g`) are optional sugar; the same doctrine ships over MCP itself.

Related: [MCP tools](mcp.md) · [Agent API](agent-api.md) · [Quickstart](quickstart.md)

---

## Mental model (30 seconds)

| Layer | What it is | Tool | Everyday example |
|---|---|---|---|
| **Source** | Raw long-form material | `ingest` | Meeting transcript, design doc, email paste |
| **Atom (note)** | Distilled fact / decision / how-to | `remember` | “Refunds within 14 days”, “CS owns churn email” |
| **Edge** | Link between notes | `connect` / `forget` | That decision is for the billing project |
| **Pack** | Short brief for one question | `recall` | Answer to “how do we handle refunds?” |
| **Full note** | Complete body of one note | `read` | Open `billing-pricing-rules` end to end |
| **Exact hit** | Known string in the graph | `grep` | Ticket `INV-1042`, error `ECONNRESET` |

**Beliefs are small and linked. Evidence is large and citable. The pack is a brief, not a dump.**

---

## Where the doctrine lives (MCP-only clients)

You do **not** need skills for this model to reach the agent:

| Surface | What it carries |
|---|---|
| **Server `instructions`** | Full operating doctrine on MCP initialize |
| **Resource `trove://doctrine`** | Same text; `resources/read` at session start if instructions are ignored |
| **Tool descriptions** | Per-tool routing (shared by MCP and `GET /v1/tools`) |
| **Prompts** | `trove-recall`, `trove-remember`, `trove-session` |

If your host strips instructions, pin `trove://doctrine` or paste the [system-prompt blurb](#optional-system-prompt-blurb).

---

## The session loop

```
┌─────────────────────────────────────────────────────────┐
│  1. BOOT      load what you already know                │
│  2. WORK      do the task                               │
│  3. CAPTURE   save truths as they land (not only later) │
│  4. LINK      hang new notes on a project/topic hub     │
│  5. CORRECT   supersede outdated beliefs                │
│  6. CLOSE     a handful of solid notes, not one blob    │
└─────────────────────────────────────────────────────────┘
```

---

## 1. Read path — load memory before thinking

### Routing table

| Query shape | Call | Example |
|---|---|---|
| Exact string | **`grep`** → optional **`read`** | `INV-1042`, `ECONNRESET`, `FEATURE_DARK_MODE` |
| Known note name | **`read`** | `billing-pricing-rules`, `onboarding-checklist` |
| Open question | **`recall`** (~8000 tokens) → **`read`** if thin | “How do we handle refunds for annual plans?” |
| History of a fact / relationship | **`read`** / **`neighborhood`** | Fact snapshot or edge graph at `asOf` |

### Rules of thumb

- **Don’t use `recall` for a ticket id or error string** — `grep` first.
- **`recall` has no `asOf`** — it answers from present belief and rejects the parameter. History lives on `read` and `neighborhood`.
- **Don’t answer from a thin brief** if you know the note name — `read` it.
- Ask `recall` in plain language:  
  `"How do we handle refunds for annual plans?"`  
  not `"refund annual plan keywords"`.

### When to load memory

Call Trove **before** you reinvent:

- Pricing, policies, or process you’ve defined before  
- Who owns what  
- How a product area is supposed to work  
- “What were we working on last week?”

---

## 2. Write path — continuous capture, not one dump

### Two write verbs

| Tool | Writes | Findable by `recall`? | Use for |
|---|---|---|---|
| **`ingest`** | Raw document → text spans | No (evidence only) | Call notes, long docs, pastes |
| **`remember`** | Short distilled note | **Yes** | Decisions, facts, how-tos |

**Long material:**

```
ingest(meeting notes)
  → remember 3–7 short facts citing those spans
  → connect each to billing / onboarding / …
```

**One fact mid-session:**

```
remember({ title: "Deploy freezes start Friday noon", type: "decision", links: [...] })
```

### What to save

| Type | Everyday examples |
|---|---|
| `decision` | “Annual plans are not refundable after 14 days” |
| `claim` / fact | “Customer success owns churn emails” |
| `pattern` | “Always confirm the target environment before deploy” |
| `project` | Status and open questions for a launch |
| `task` | Only if it must survive across sessions |

**Skip:** chatter, pure code that’s already in the repo, speculation, one mega “notes from today”.

**Prefer five sharp notes** over one giant blob.

### When to write *now* (not only at wrap-up)

1. Someone **decided** something  
2. You **learned a durable rule**  
3. A **fact changed** (policy, owner, date)  
4. You found a **gotcha** others will hit  

### `remember` hygiene

1. Stable, clear titles  
2. Always check **`similar`** — re-call with `slug` if the right note almost matched  
3. Cite evidence, or say “agent inference from session YYYY-MM-DD”  
4. **Link** every note to a hub (project, topic, person)  
5. Use real types — not everything is a vague claim  

---

## 3. Belief change — supersede, never delete

| Situation | Action |
|---|---|
| Note text is wrong | `remember` same slug (new revision) |
| Link is wrong | `connect` with `supersedesEdgeId` |
| No longer true | `forget` (preview with query first) |
| “What did this fact say then?” | `read` with `asOf` |
| “Which relationships did we believe then?” | `neighborhood` with `asOf` |

---

## 4. Session shapes

### A. Looking up a policy

```
1. grep "refund" or read billing-pricing-rules
2. answer with the note name cited
3. if the policy changed today → remember the update (same slug)
```

### B. After a planning meeting

```
1. ingest the transcript / notes
2. remember 3–7 decisions and owners, with evidence
3. connect each to the project hub
```

### C. Open product question

```
1. recall "what's the plan for mobile onboarding?"
2. read top notes if the brief is thin
3. answer with citations
4. if you synthesized something durable → remember it
```

### D. End of a solid session

```
1. List decisions, facts, gotchas (not everything said)
2. remember each (or revise by slug)
3. connect hubs
4. optional: ingest a short session note as evidence
```

Still not one node titled “Session notes …” with everything inside.

---

## 5. Graph quality

| Practice | Why |
|---|---|
| Link every new note | Neighbors only expand if edges exist |
| Short summary + optional long body | Briefs use summaries; `read` gets depth |
| Fix stale notes when you see them | Bad beliefs poison every future brief |

Using `recall`/`read` also strengthens activation — good notes get easier to find.

---

## 6. Healthy cadence

| Cadence | Volume |
|---|---|
| Session start | 1–3 loads (`recall` / `grep` / `read`) |
| During work | Save when something becomes true |
| Long docs | 1 `ingest` + several small `remember`s |
| Session end | A handful of linked notes; zero mega-dumps |

**Weak pattern:** no loads during the day; one “stuff from today” note at night.

---

## 7. Invariants

1. Load before re-deriving  
2. Route tools by query shape (exact → grep, known name → read, open → recall)  
3. Ingest raw text; remember distilled beliefs  
4. Write when it’s true, not only when you’re done  
5. Many small linked notes, not one blob  
6. Supersede, don’t delete  
7. Cite a source or say it’s inference  
8. Check `similar` on remember  
9. Cite note names in answers  
10. Save useful syntheses so the graph compounds  

---

## Optional system-prompt blurb

```text
You have Trove MCP (memory graph). Use it as working memory, not a diary.
Follow server instructions and/or resource trove://doctrine.

READ before reinventing:
  - exact ids/errors/keys → grep, then read if needed
  - known note name → read
  - open questions → recall (~8000 tokens), then read if the brief is thin

WRITE when a fact or decision becomes true (during the session):
  - long material → ingest, then remember several short notes with evidence + links
  - one fact → remember with type, summary, links
  - corrections → same slug, or connect with supersedesEdgeId; never delete
  - check remember's `similar` list; re-call with slug if merge missed

Close with several small linked notes, not one mega-node.
```

---

## MCP prompts

| Prompt | Use |
|---|---|
| `trove-recall` | Answer from memory with routing + citations |
| `trove-remember` | Save with ingest→remember→connect discipline |
| `trove-session` | Full start→work→capture→close loop |

---

## Logging vs a human diary

Trove does **not** append a human diary file. Mutations:

1. Create or revise **notes**  
2. Append **audit events** (who/what/when)  

Optional: `ingest` a short session note as evidence for the atoms you just saved.

---

## Bottom line

**retrieve → work → distill → link → correct → retrieve again.**

One end-of-day mega-note only stores a summary. Continuous, small, linked, evidence-backed notes make the *next* agent (any model, any client) useful on the first `recall`.
