-- The recall self-test job kind.
--
-- `graph_job.kind` is a CHECK list, so a new job kind is a schema change: the
-- Zod enum accepting it means nothing to Postgres, and the mismatch shows up as
-- a constraint violation on the first enqueue rather than as a type error.
--
-- Idempotent: the runner replays every file on each deploy, so the constraint
-- is dropped by name and rebuilt rather than added blind.
alter table graph_job drop constraint if exists graph_job_kind_check;
alter table graph_job add constraint graph_job_kind_check
  check (kind in (
    'refresh_obsidian_projection',
    'lint_graph',
    'refresh_embeddings',
    'reconcile_node',
    'recall_self_test'
  ));
