-- Retention for the append-only audit log.
--
-- graph_event has recorded every write since the graph existed and nothing
-- ever removed a row. Production carries 30,479 rows / 16 MB over four
-- indexes, oldest 2026-07-03, ~76% dead tuples, growing on every capture,
-- update, link, ingest, annotate and every job transition besides. It is the
-- one table in the schema with no ceiling at all.
--
-- The lint job now prunes events past TROVE_EVENT_RETENTION_DAYS (default
-- 180) in bounded batches, oldest first. This file gives that prune its index
-- and does one bounded catch-up so a deploy is not waiting on the first lint.
--
-- The index is (created_at, id), not (created_at) alone. The prune wants
-- `where created_at < horizon order by created_at limit n`, which either
-- serves; the second column is free and matches the event feed's keyset
-- order exactly (`order by created_at desc, id desc`), so the unscoped feed
-- and timeline() stop sorting the whole table to return 100 rows. Fifth index
-- on a table this hot is a real write cost, and it is the one that finally
-- makes the table shrink.
--
-- Plain create, not CONCURRENTLY: the runner sends each file as one implicit
-- transaction, which forbids it, and on 30k rows the SHARE lock is held for
-- milliseconds. Same reasoning as 017.
create index if not exists graph_event_created_at_idx on graph_event(created_at, id);

-- One bounded catch-up. 180 is the default the reader in graphCore uses;
-- an operator running a shorter window gets the rest from the next lint
-- rather than from a migration, which is where a long delete does not belong.
--
-- On production today this deletes ZERO rows: the oldest event is 2026-07-03,
-- 62 days old, well inside the window. The statement exists for the databases
-- that outlive the horizon, and it is bounded so it can never be the reason a
-- deploy misses the 120-second healthcheck. Index-served by the create above.
delete from graph_event
where id in (
  select id from graph_event
  where created_at < now() - interval '180 days'
  order by created_at
  limit 20000
);

-- PARTITIONING: deliberately not done here.
--
-- Monthly range partitioning would make expiry a DETACH instead of a delete,
-- but converting graph_event costs a full table rewrite into a partitioned
-- parent plus a swap under ACCESS EXCLUSIVE, and the partition key has to
-- join the primary key -- (id) becomes (id, created_at) -- which changes the
-- table's identity for every FK and every `where id = ?` the codebase has.
-- At 16 MB / 30,479 rows that buys nothing: retention deletes 500 rows a day
-- in steady state, autovacuum (scale factor 0.02 since 017) reclaims them,
-- and the whole table fits in shared buffers many times over.
--
-- Revisit when the retained window itself is large -- order of 10 million rows
-- or a few GB, i.e. roughly 50x today's write rate against the same 180-day
-- window -- or when one prune run stops keeping up with the write rate (the
-- lint result's prunedEvents pinned at the per-run cap, run after run, is the
-- signal). Until then the delete is cheaper than the rewrite.
