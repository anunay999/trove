-- Temporal integrity for the bitemporal edge.
--
-- The edge carried four timestamps and nothing that related them: valid_from
-- could be null (which hid the edge from every world-time query), valid_until
-- could precede valid_from, and once an edge was expired nothing stopped a
-- second version of the same (from, to, predicate) from claiming the same
-- world-time interval -- so a point-in-time read could return two
-- contradictory versions with no tiebreak. Invalidation was also written three
-- ways: invalidated_by on supersession, a bare expired_at from invalidateEdge,
-- and a metadata {"invalidatedBy":"tombstone"} marker from tombstoneNodes.
--
-- Every statement here is replay-safe: the runner applies every file on every
-- boot. The exclusion constraint needs btree_gist so uuid/text equality can
-- share a GiST index with the range overlap.
create extension if not exists btree_gist;

-- valid_from: never null. Pre-migration rows that omitted it were believed
-- from the moment they were recorded, which is also the default going forward.
update edge set valid_from = created_at where valid_from is null;
alter table edge alter column valid_from set default now();
alter table edge alter column valid_from set not null;

-- Validity cannot end before it begins. Equality is allowed: an edge
-- superseded at the very instant it started is an empty interval, which is
-- the honest record of a belief that never held.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'edge_valid_range_check') then
    alter table edge
      add constraint edge_valid_range_check
      check (valid_until is null or valid_until >= valid_from);
  end if;
end $$;

-- One version of a triple per world-time instant. Unlike edge_active_unique_idx
-- this covers expired versions too: closing an edge is what makes room for its
-- successor, so every path that expires an edge must also set valid_until.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'edge_valid_range_excl') then
    alter table edge
      add constraint edge_valid_range_excl
      exclude using gist (
        from_node_id with =,
        to_node_id with =,
        predicate with =,
        tstzrange(valid_from, valid_until, '[)') with &&
      ) where (deleted_at is null);
  end if;
end $$;

-- One invalidation encoding. Backfill only expired rows, oldest encoding
-- first, so the iff constraint below holds by construction.
alter table edge add column if not exists invalidation_reason text;

update edge
set invalidation_reason = 'superseded'
where expired_at is not null and invalidation_reason is null and invalidated_by is not null;

update edge
set invalidation_reason = 'tombstoned'
where expired_at is not null and invalidation_reason is null and metadata->>'invalidatedBy' = 'tombstone';

update edge
set invalidation_reason = 'invalidated'
where expired_at is not null and invalidation_reason is null;

-- The metadata marker is retired; the reason column is the only encoding.
update edge
set metadata = metadata - 'invalidatedBy'
where metadata ? 'invalidatedBy';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'edge_invalidation_reason_check') then
    alter table edge
      add constraint edge_invalidation_reason_check
      check (
        (expired_at is null and invalidation_reason is null)
        or (expired_at is not null and invalidation_reason in ('superseded', 'invalidated', 'tombstoned'))
      );
  end if;
end $$;
