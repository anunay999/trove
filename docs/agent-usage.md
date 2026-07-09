# How agents should use Trove

> Trove is a **working memory graph**, not an end-of-day diary.
> The failure mode is one `remember` at wrap-up. The success mode is: load context before work, write as beliefs form, link them, correct with supersession, leave evidence.

This guide is for **any LLM** with Trove MCP (Claude Code, Cursor, Codex, claude.ai connectors, custom hosts). Claude-specific skills (`npx skills add anunay999/trove -g`) are optional sugar; the same doctrine ships over MCP itself.

Related: [MCP tools](mcp.md) · [Agent API](agent-api.md) · [Quickstart](quickstart.md)

---

## Mental model (30 seconds)

| Layer | What it is | Tool |
|---|---|---|
| **Source** | Raw long-form (transcript, PR, page, paste) | `ingest` — never a “belief” |
| **Atom (node)** | Distilled fact / decision / runbook / pattern | `remember` — ranked by `recall` |
| **Edge** | Typed relationship | `connect` / `forget` |
| **Pack** | Budgeted context for *this* question | `recall` |
| **Full page** | Complete node body or raw source | `read` |
| **Exact hit** | Port, IP, error string, flag, SHA | `grep` |

**Beliefs are small and linked. Evidence is large and citable. The pack is a digest, not a dump.**

---

## Where the doctrine lives (MCP-only clients)

You do **not** need skills for this model to reach the agent:

| Surface | What it carries |
|---|---|
| **Server `instructions`** | Full operating doctrine on MCP initialize (hosts that surface it inject this) |
| **Resource `trove://doctrine`** | Same text; `resources/read` at session start if instructions are ignored |
| **Tool descriptions** | Per-tool routing (shared by MCP `tools/list` and `GET /v1/tools`) |
| **Prompts** | `trove-recall`, `trove-remember`, `trove-session` for structured workflows |

If your host strips instructions, pin `trove://doctrine` or paste the [system-prompt blurb](#optional-system-prompt-blurb) into the host system prompt.

---

## The session loop

```
┌─────────────────────────────────────────────────────────┐
│  1. BOOT      recall / grep / read  BEFORE re-deriving  │
│  2. WORK      code, debug, design                       │
│  3. CAPTURE   mid-session when a belief crystallizes    │
│  4. LINK      connect new atoms to projects/domains     │
│  5. CORRECT   supersede, don't overwrite history        │
│  6. CLOSE     3–8 high-value atoms, not one mega-node   │
└─────────────────────────────────────────────────────────┘
```

End-of-day single-node dumps are the anti-pattern. Maximum value = many small, linked, evidence-backed atoms over time.

---

## 1. Read path — load memory before thinking

### Routing table (non-negotiable)

| Query shape | Call | Then |
|---|---|---|
| Exact string: port, IP, slug, error, flag, SHA | **`grep`** | **`read`** the hit if you need the full page |
| Known page / slug | **`read`** | — (full body) |
| Open / multi-hop: “how does X work?”, “state of Y?” | **`recall`** (`tokenBudget` ~8000) | **`read`** top slug if pack is thin |
| Structure / history of a belief | **`neighborhood`** | optional `asOf` / `includeExpired` |

### Rules of thumb

- **Never open with `recall` for a port or error code.** Grep wins.
- **Never answer a runbook from a thin pack.** If the top atom is right, `read` it.
- **Phrase `recall` as a question**, not keywords:  
  `"How do we recover anunay-vm-rocket when Tailscale is offline?"`  
  not `"rocket vm tailscale"`.
- **One good `recall` beats** five random greps for open questions — then drill with `read`.

### When to load memory (triggers)

Call Trove **before** you:

- Touch a system you’ve worked on before (infra, domain, project)
- Debug something that “happened last week”
- Design against prior decisions
- Answer “what was I / we working on?”
- Guess a port, path, tenant id, or env var

If you would have opened a wiki page, hit Trove first.

---

## 2. Write path — continuous capture, not one dump

### Two write verbs (do not conflate)

| Tool | Writes | Competes in `recall`? | Use for |
|---|---|---|---|
| **`ingest`** | Raw document → text units | No (evidence only) | Transcripts, long notes, PR bodies, URLs, session dumps |
| **`remember`** | Distilled atom (title + summary + optional content) | **Yes** | Decisions, facts, gotchas, patterns, runbook updates |

**Pipeline for heavy material:**

```
ingest(source) → remember(2–5 atoms citing textUnitIds) → connect(to project/domain)
```

**Pipeline for a single fact mid-session:**

```
remember({ title, type, summary, links })   // state agent-inference if no source
```

### What to save (and what not to)

**Save (gold):**

| Type | Examples |
|---|---|
| `decision` | “We’ll use X because Y” |
| `claim` / fact | Port, IP, budget, “P2028 root cause is …” |
| `pattern` | Reusable rule / gotcha / routing table |
| `project` | Status, open threads, ship date |
| `infrastructure` | Runbook, recovery, identity table |
| `task` | Only if durable across sessions |

**Do not save:**

- Transient debugging chatter
- Things already true in the repo (read the code)
- Speculative “maybe we should”
- One giant “session summary” that rewrites the whole world

**Cardinality:** prefer **5 sharp atoms** over 1 10k-char “everything that happened today.”

### Mid-session triggers (when to `remember` *now*)

Don’t wait for wrap-up. Write when:

1. User **agrees** a decision  
2. You **prove** a root cause  
3. You discover a **gotcha** (“never soft-restart rocket”)  
4. A **fact changes** (port moved, PR merged)  
5. You invent a **reusable rule** other agents need  

That’s how the graph compounds across agents and days.

### `remember` hygiene

1. **Stable titles** — revises on exact title/slug match.  
2. **Always check `similar`** — if the right node is near-miss, re-call with `slug`.  
3. **Evidence or honesty** — `textUnitId`s from ingest, or “agent inference from session YYYY-MM-DD” in the summary.  
4. **`links`** — every new atom should attach to at least one hub: project, domain, person, infra. Orphans are dead.  
5. **Types** — pick real types (`decision`, `pattern`, …); don’t put everything in `claim`.

---

## 3. Belief change — supersede, never delete

When truth changes:

| Situation | Action |
|---|---|
| Atom content wrong | `remember` with same **slug** (new revision) |
| Relationship wrong | `connect({ …, supersedesEdgeId })` |
| Belief retired, no replacement | `forget({ edgeIds })` or `forget({ query, dryRun: true })` first |
| “What did we believe last week?” | `neighborhood({ asOf, includeExpired })` |

Never “delete and recreate.” History is a feature (`asOf` time-travel).

---

## 4. Session shapes (concrete)

### A. Debugging / ops

```
1. grep error string / port
2. read the runbook slug
3. fix the system
4. remember gotcha or decision if new
5. connect → infrastructure / project
```

### B. Feature / design work

```
1. recall "state of <project> and open decisions"
2. read key project + pattern nodes
3. work
4. each agreed decision → remember(type: decision) + connect
5. close: remember 1 synthesis only if it spans multiple atoms
```

### C. Reading a long doc / PR / transcript

```
1. ingest(full text)
2. remember 3–7 distilled facts with evidence: [{ textUnitId }]
3. connect each to the right project/domain
```

Not: ingest and stop. Not: one mega-summary with no links.

### D. “What do we know about X?”

```
1. recall(question, tokenBudget: 8000)
2. read top 1–2 slugs if incomplete
3. answer with citations (slugs)
4. if answer is a non-trivial synthesis → remember it back (exploration compounds)
```

### E. End of substantial session

```
1. Scan: decisions, facts, gotchas, corrections (not everything)
2. remember each (or revise by slug)
3. connect hubs
4. optional: ingest short session note as evidence for those atoms
```

Still **not** one node titled “Session notes …” with everything inside.

---

## 5. Graph quality = maximum recall quality

| Practice | Why it matters |
|---|---|
| Link every atom | 1-hop expansion only works if edges exist |
| Prefer specific predicates (`part_of`, `decision_for`, `implements`) when you can | Better structure |
| Small summaries + optional long `content` | Packer ranks summaries; `read` gets depth |
| Fix wrong atoms when you notice them | Stale beliefs poison every future pack |
| Occasional `lint` (admin) | Orphans, missing evidence |

**Recall strengthens memory** (`access_count`). Using the graph makes important atoms easier to find later.

---

## 6. Healthy cadence (numerically)

| Cadence | Volume |
|---|---|
| Session start | 1–3 `recall` / `grep` / `read` |
| During work | 0–N mid-stream `remember` when beliefs form |
| Long sources | 1 `ingest` + 3–7 `remember` with citations |
| Session end | 3–8 atoms, mostly linked; 0 mega-dumps |
| Corrections | `remember(slug=…)` or `connect(supersedes…)` same day |

**Weak pattern:** no reads during the session; one node “stuff from today” at the end.

---

## 7. Invariants (copy into any system prompt)

1. **Load before re-deriving** — Trove first when prior context might exist.  
2. **Route tools by shape** — grep → read → recall (never recall-for-everything).  
3. **Ingest evidence, remember beliefs** — two layers, two verbs.  
4. **Write when true, not only when done** — mid-session capture.  
5. **Many small linked atoms** — not one end-of-day blob.  
6. **Supersede, don’t delete.**  
7. **Provenance or say it’s inference.**  
8. **Check `similar` on remember** — force `slug` if dedupe missed.  
9. **Cite slugs in answers** — so the next agent can `read` them.  
10. **Compound** — non-trivial answers get `remember`ed so the graph grows.

---

## Optional system-prompt blurb

Paste into any host that ignores MCP server instructions:

```text
You have Trove MCP (memory graph). Use it as working memory, not a diary.
Also follow server instructions and/or resource trove://doctrine.

READ: Before re-deriving project/system knowledge:
  - exact strings → grep, then read if needed
  - known slug → read
  - open questions → recall (tokenBudget ~8000), then read if pack is thin

WRITE: When a decision, fact, gotcha, or correction crystallizes (mid-session, not only end):
  - long material → ingest, then remember 3–7 distilled atoms with evidence + links
  - single fact → remember with type, summary, links to project/domain
  - changed belief → remember same slug, or connect with supersedesEdgeId; never delete
  - check remember's `similar` list; re-call with slug if merge missed

Close sessions with several small linked atoms, not one mega-node.
```

---

## MCP prompts (structured workflows)

| Prompt | Use |
|---|---|
| `trove-recall` | Answer from memory with grep/read/recall routing + citations |
| `trove-remember` | Save with ingest→remember→connect discipline |
| `trove-session` | Full boot→work→capture→close loop for a task |

---

## Logging vs a human diary

Trove does **not** append Scribe-style `log.md` narrative entries. Mutations:

1. Create or revise **nodes** (beliefs)
2. Append **`graph_event`** audit rows (who/what/when)

Optional: `ingest` a short session note as evidence for the atoms you just remembered.

---

## Bottom line

Trove pays off when agents run a closed loop:

**retrieve → work → distill → link → correct → retrieve again.**

End-of-day “update one node” only stores a summary. Continuous, typed, linked, evidence-backed atoms is what makes the next agent (any model, any client) smarter on the first `recall`.
