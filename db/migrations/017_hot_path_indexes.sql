-- Hot-path indexes and vacuum tuning for the tables every request touches.
--
-- annotation(node_id) is the join key on every recall and read: evidence for
-- a node is "annotations where node_id = ?". The only annotation index was on
-- text_unit_id, so with 5k+ annotations in production (and growing with every
-- remember) each read paid a sequential scan. Small table, so the plain
-- create takes its SHARE lock for milliseconds; the migration runner sends
-- each file as one implicit transaction, which rules out CONCURRENTLY anyway.
create index if not exists annotation_node_idx on annotation(node_id);

-- node churns on every read (access_count / last_accessed_at) and graph_event
-- grows on every write. Postgres's default trigger (20% of the table dead)
-- lets bloat and stale statistics build for a long time on tables this size;
-- 2% keeps the hot rows tight and the planner honest. Repeatable: ALTER TABLE
-- SET is idempotent, and every migration re-runs at boot.
alter table node set (autovacuum_vacuum_scale_factor = 0.02);
alter table graph_event set (autovacuum_vacuum_scale_factor = 0.02);

-- Deliberately untouched: revision_content_search_idx still indexes
-- coalesce(content, '') || ' ' || coalesce(projection_markdown, ''), even
-- though projection_markdown is never written (both revision inserts leave it
-- null). lexicalSearch reads the same expression, and a GIN expression index
-- serves only a query whose expression matches it exactly, so the column and
-- the index have to change in the same commit as that query. There is also no
-- row-local "current revision" predicate on node_revision (currency lives in
-- node.current_revision_id), so the index cannot be made partial.
