-- Bitemporal edges + activation columns (memory-db-design.md v2 delta).
-- Edge supersession is invalidation, never deletion: expired_at marks when the
-- system stopped believing the edge, valid_from/valid_until bound when the
-- relationship was true in the world, invalidated_by points at the superseding edge.

alter table edge
  add column if not exists valid_from timestamptz,
  add column if not exists valid_until timestamptz,
  add column if not exists expired_at timestamptz,
  add column if not exists invalidated_by uuid references edge(id);

update edge set valid_from = created_at where valid_from is null;

-- Replace the hard uniqueness with active-edge uniqueness so a superseded
-- (from, to, predicate) triple can be re-asserted later without losing history.
alter table edge drop constraint if exists edge_from_node_id_to_node_id_predicate_key;
create unique index if not exists edge_active_unique_idx
  on edge(from_node_id, to_node_id, predicate)
  where deleted_at is null and expired_at is null;

create index if not exists edge_active_from_idx
  on edge(from_node_id)
  where deleted_at is null and expired_at is null;
create index if not exists edge_active_to_idx
  on edge(to_node_id)
  where deleted_at is null and expired_at is null;

-- ACT-R-style activation signals: reads strengthen memory.
alter table node
  add column if not exists access_count bigint not null default 0,
  add column if not exists last_accessed_at timestamptz;
