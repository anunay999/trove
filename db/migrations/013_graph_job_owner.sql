-- Jobs belong to the owner whose write enqueued them.
--
-- graph_job rows carry more than bookkeeping: a lint result holds up to 200
-- findings with node ids and titles, and a reconcile result holds candidate
-- nodes with judge reasons. Until now the table had no owner column, so every
-- list of jobs was a list of everyone's jobs. Mirrors 006_user_isolation.sql
-- for the graph tables. NULL means global/operator work (a superuser context,
-- the background worker, an operator-triggered run) and is visible only to
-- unscoped readers; every pre-existing row stays NULL, which is the right
-- reading of history: those jobs ran over the whole graph.
--
-- on delete cascade rather than set null: a removed user's job history is
-- worthless without their graph, and orphaned results would otherwise be
-- promoted to "global" and shown to operators as if they were.
--
-- Idempotent; the migration runner replays every file on each deploy. On the
-- production table (a few thousand rows) both statements are sub-second: the
-- add column takes a brief ACCESS EXCLUSIVE lock, validates the FK against
-- all-NULL values, and the index build is a single small scan.
alter table graph_job add column if not exists owner_id uuid references app_user(id) on delete cascade;

create index if not exists graph_job_owner_idx on graph_job(owner_id);
