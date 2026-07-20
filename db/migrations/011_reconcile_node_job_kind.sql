-- Write-time reconciliation (docs/memory-db-design.md §3): capture/update
-- enqueue reconcile_node jobs that candidate-match the written node against
-- existing ones and let a judge resolve duplicates/contradictions/supersessions.
alter table graph_job drop constraint if exists graph_job_kind_check;
alter table graph_job
  add constraint graph_job_kind_check
  check (kind in ('refresh_obsidian_projection', 'lint_graph', 'refresh_embeddings', 'reconcile_node'));
