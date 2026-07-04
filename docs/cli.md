# CLI and HTTP Client

The Trove CLI is a thin reference client for the hosted HTTP API. It is useful for shell workflows, Raycast or Shortcuts wrappers, and as a concrete contract for future Obsidian or web clients.

## Environment

```bash
export TROVE_BASE_URL=http://localhost:8787
export TROVE_SERVICE_TOKEN=local-dev-token
export TROVE_INTERFACE_ID=cli
```

`TROVE_INTERFACE_ID` is stored on `graph_event.interface_id` for writes.

## Commands

Check readiness:

```bash
npm run cli -- ready
```

Query:

```bash
npm run cli -- query "Trove" --limit 5 --text-units false
npm run cli -- query "transactional provenance" --mode lexical
```

Capture:

```bash
npm run cli -- capture \
  --title "Example decision" \
  --summary "A durable note captured through the service." \
  --type decision \
  --content "Longer content can go here."
```

Lint:

```bash
npm run cli -- lint
```

Poll the interface sync event feed:

```bash
npm run cli -- events --limit 25
npm run cli -- events --after-cursor <cursor-from-previous-response>
```

Create and read a saved mind-map view:

```bash
npm run cli -- create-view --title "Trove Search Map" --query Trove
npm run cli -- views
npm run cli -- read-view trove-search-map
```

List pending maintenance jobs:

```bash
npm run cli -- jobs --status pending
```

Enqueue and run a maintenance job:

```bash
npm run cli -- enqueue-job lint_graph --dedupe-key manual:lint
npm run cli -- run-job
```

Export an Obsidian projection from the hosted service:

```bash
npm run cli -- export-obsidian exports/obsidian
```

## Production Build

After `npm run build`, the compiled client is:

```bash
npm run cli:prod -- ready
```

## Client Module

The reusable HTTP client lives at `src/httpClient.ts` and exposes:

- `ready`
- `search`
- `capture`
- `lint`
- `events`
- `views`
- `createView`
- `readView`
- `deleteView`
- `jobs`
- `enqueueJob`
- `runJob`
- `exportObsidian`

Use it as the first internal client contract for Obsidian plugin or web UI work.
