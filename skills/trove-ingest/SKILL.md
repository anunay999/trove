---
name: trove-ingest
description: Use when the user shares a source (URL, file path, paste, transcript) that should be indexed into the Trove memory graph. Stores the raw evidence first via graph.ingest, then captures semantic atoms citing exact text units.
---

# trove-ingest

> Evidence first, meaning second. The graph never contains a claim it cannot prove.

## When to use

- User shares a URL, file, gist, or paste worth remembering.
- A long document (spec, transcript, article) should become queryable memory.

When **not** to use:

- Conversation-born knowledge with no external source → `trove-capture`.
- The source is a vault page — the importer handles those (`npm run import:scribe`).

## Process

### Step 1 — obtain the text

Fetch/read the source. For URLs, extract the readable text.

### Step 2 — store the evidence

```
graph.ingest { kind, title, uri, contentText, metadata }
```

- `kind`: `url` | `file` | `paste` | `transcript` | `email` | `slack`.
- Identical content dedupes by hash — re-ingesting is safe.
- Returns the `source` and its addressable `textUnits`.

### Step 3 — extract atoms

From the text units, capture the meaning-bearing atoms (typically far fewer than the text is long): entities, claims, decisions, patterns. For each:

```
graph.capture { title, type, summary, evidence: [{ textUnitId }], links }
```

Every atom cites the exact text unit that supports it. Link atoms to existing project/domain nodes (`graph.search` first to find them).

### Step 4 — annotate (optional)

`graph.annotate` to mark important spans ("contradicts claim X", "important quote") without rewriting anything.

### Step 5 — confirm

Source id + how many text units; atoms captured with slugs; anything that contradicted existing nodes (recommend `trove-update` or `trove-lint`).

## Anti-patterns

- **Don't** capture atoms without text-unit citations when the source is right there.
- **Don't** turn the whole document into one giant node — the source already stores the full text; atoms are the compression.
- **Don't** ingest secrets or credentials as content.
