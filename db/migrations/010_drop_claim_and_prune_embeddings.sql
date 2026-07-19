-- Drop the dead claim table and prune stale-revision embeddings.
--
-- The claim table has no code references; it survives only as a foreign-key
-- target of annotation.claim_id and as the claim_status enum. Drop the column
-- (cascading away the old target check), re-add the target check without the
-- claim branch, then drop the table and its enum.
--
-- Widening graph_job.status with 'dead' rides along here: failed jobs that
-- exhaust their retries are dead-lettered, and the old CHECK rejected it.
--
-- Finally, embeddings used to be kept for every node revision, so a query for
-- a deleted phrase could resurrect a superseded revision ("franken-node").
-- Keep only embeddings whose revision is the node's current revision.

alter table annotation drop column if exists claim_id cascade;
alter table annotation drop constraint if exists annotation_target_check;
alter table annotation
  add constraint annotation_target_check
  check (node_id is not null or body <> '{}'::jsonb);

drop table if exists claim;
drop type if exists claim_status;

alter table graph_job drop constraint if exists graph_job_status_check;
alter table graph_job
  add constraint graph_job_status_check
  check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'dead'));

delete from embedding
where owner_table = 'node_revision'
  and owner_id in (
    select nr.id
    from node_revision nr
    join node n on n.id = nr.node_id
    where nr.id is distinct from n.current_revision_id
  );
