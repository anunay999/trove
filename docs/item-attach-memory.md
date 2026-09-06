# Item-center memory attach (Outcome OS / Relay)

Contract locked with Relay Eng for attaching Trove memories to Relay WorkItems.

## Ownership

| Concern | Owner |
| --- | --- |
| WorkItem record + `memoryIds[]` | **Relay** |
| Memory storage, hubs, evidence graph | **Trove** |

Canonical id: **`itemId`** = Relay `WorkItem.id` (string). Prefer over `workId` / `goalId`.

## Hub node

Every attach ensures a hub node exists:

- Logical form (docs / Relay): `item:{itemId}`
- **Stored Trove slug**: `item-{slugify(itemId)}`

Trove slugify maps non `[a-z0-9]` to `-`, so colons cannot appear in slugs. Callers should treat `item-{itemId}` as the durable hub key.

Hub type: `task`. Created on first attach if missing.

## MCP tools

### `attach_memory` (core)

Attach an existing memory **or** create then attach.

**Input**

| Field | Required | Notes |
| --- | --- | --- |
| `itemId` | yes | Relay WorkItem.id |
| `memoryId` | one of | Existing node UUID |
| `slug` | one of | Existing node slug |
| `title` + `summary` | one of | Create via `remember` then attach |
| `type`, `content`, `evidence` | no | Passed through to `remember` when creating |
| `bucket` | no | `suggested` | `pinned` | `excluded` | `available` (default `suggested`) |

Provide **either** `memoryId`/`slug` **or** `title`+`summary`.

**Output**

```json
{
  "memoryId": "<uuid>",
  "itemId": "<relay-id>",
  "bucket": "suggested",
  "hubSlug": "item-<id>",
  "hubNodeId": "<uuid>",
  "edgeId": "<uuid>",
  "action": "created_and_attached",
  "relayEvent": { "emitted": false, "status": "proposed", "reason": "url_unset" }
}
```

Edge predicate on the graph: `item_{bucket}` (e.g. `item_suggested`) from memory → hub.

### `attach_from_item_desc` (curator)

Auto path when Relay only has a work-item title + description:

1. `ingest(title + note)` as `agent_note`
2. Split note into short claims (paragraph / sentence heuristic, `maxClaims` default 5)
3. `remember` each claim with `{ quote }` evidence
4. Connect each to hub under `bucket`

**Input**: `itemId`, `title`, `note`, optional `bucket`, optional `maxClaims` (1–7).

**Output**: `{ itemId, bucket, hubSlug, hubNodeId, sourceId, memories: AttachMemoryResult[] }`.

Exposed as a **separate tool** (not a mode on `attach_memory`) to match the existing ingest → remember → connect curator pattern.

## HTTP

Same shapes as MCP:

- `POST /v1/attach-memory`
- `POST /v1/attach-from-item-desc`

Scopes: capture+link (and ingest for the desc path). `graph:write` / `graph:admin` satisfy the fine-grained scopes.

## How Relay should call it

1. On "suggest memory for item": `attach_memory` with `itemId` + `title`/`summary` (or existing `memoryId`), `bucket: "suggested"`.
2. Persist returned `memoryId` onto the WorkItem's `memoryIds[]`.
3. On pin / exclude / make available: call again with same `memoryId` + new `bucket` (rebuckets via superseding edge).
4. Optional bulk from description: `attach_from_item_desc`, then append all returned `memoryId`s.

## Durable belief / propose → approve

Today Trove has **`remember` only** — distilled claims become durable graph nodes immediately. There is no separate propose/approve gate in-product.

**Product intent:** suggested-bucket attachments are *proposals*; pin/available ≈ approve; excluded ≈ reject; rebucket supersedes the prior edge. When a richer approve UI lands, it should call the same attach/rebucket path (or a thin wrapper) rather than inventing a second approval store.

## Relay memory-events webhook

When an item-memory lifecycle resolves, Trove POSTs:

```json
{ "itemId": "...", "memoryId": "...", "status": "proposed|approved|rejected|superseded", "bucket": "suggested?" }
```

| Env | Meaning |
| --- | --- |
| `RELAY_MEMORY_EVENTS_URL` | Full URL to Relay `POST /api/trove/memory-events` |

**Bucket → status (MVP):**

| bucket | status |
| --- | --- |
| `suggested` | `proposed` |
| `pinned` / `available` | `approved` |
| `excluded` | `rejected` |
| rebucket replaces prior edge | emit `superseded`, then new status |

If the URL is **unset**, emit is a **no-op log** — attach never fails because Relay is missing or down. Network/HTTP errors are logged and swallowed.

## Deviations from the locked contract

1. **Hub slug** stored as `item-{id}` not `item:{id}` (Trove slug alphabet).
2. **`attach_from_item_desc` is a separate tool**, not a mode flag on `attach_memory`.
3. **Claim splitting** is heuristic (no LLM) until a curator model is wired.
4. **Propose→approve** is documented intent + webhook statuses; beliefs still land via `remember` immediately.
