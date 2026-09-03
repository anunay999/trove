-- Reconciliation's verdicts, where lint can read them.
--
-- reconcile.ts already judged duplicates and contradictions; the verdicts were
-- written into `graph_job.result` and nothing ever read them, while lint had no
-- contradiction pass at all. The two halves of the loop the design describes
-- were both built and never connected. This table is the join.
--
-- A durable table rather than a scan of job JSON, for three reasons: terminal
-- job rows are pruned after TERMINAL_JOB_RETENTION_DAYS, so the findings would
-- expire on a schedule that has nothing to do with the graph; "the most recent
-- verdict per node" out of a jsonb column is a sort-and-dedupe over every
-- reconcile job an owner ever ran; and the flags need the same owner filter and
-- the same soft-delete join as every other lint pass, which is a query, not a
-- JSON walk.
--
-- One row per (node, other node, code): a reconcile pass REPLACES its node's
-- rows, so re-judging a node that is no longer a duplicate drops the flag
-- instead of accumulating history. Both endpoints cascade on hard delete, and
-- lint joins through `node` so a soft-deleted endpoint hides the row too.
--
-- owner_id mirrors 013_graph_job_owner.sql: NULL is global/operator work,
-- visible only to unscoped readers.
--
-- Idempotent, and free on a large database: a new empty table plus two indexes
-- takes no lock on anything that exists.
create table if not exists reconcile_flag (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references app_user(id) on delete cascade,
  node_id uuid not null references node(id) on delete cascade,
  other_node_id uuid not null references node(id) on delete cascade,
  code text not null check (code in ('possible_duplicate', 'contradiction_candidate')),
  detail text not null default '',
  created_at timestamptz not null default now(),
  unique (node_id, other_node_id, code)
);

create index if not exists reconcile_flag_owner_idx on reconcile_flag(owner_id, created_at desc);
create index if not exists reconcile_flag_node_idx on reconcile_flag(node_id);
