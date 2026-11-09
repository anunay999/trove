-- The dream (offline consolidation) job kind; see src/dream.ts.
--
-- graph_job.kind is a CHECK list, so a new job kind is a schema change.
-- Idempotent: the constraint is dropped by name and rebuilt.
alter table graph_job drop constraint if exists graph_job_kind_check;
alter table graph_job add constraint graph_job_kind_check
  check (kind in (
    'refresh_obsidian_projection',
    'lint_graph',
    'refresh_embeddings',
    'reconcile_node',
    'recall_self_test',
    'dream'
  ));
