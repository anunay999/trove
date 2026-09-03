-- Vectors leave with the row that owns them.
--
-- embedding is polymorphic: owner_table / owner_id name the owning ROW (a
-- node_revision or a text_unit) with no foreign key behind them, so deleting
-- a text unit or a revision left its vector behind, still answering semantic
-- searches for content that no longer exists. No code path deletes those rows
-- today (scripts/cleanupSmokeData.ts and hand maintenance do), so this is a
-- trigger rather than a change to the store: a sweep for the orphans already
-- there, then an AFTER DELETE trigger on both tables. The owner_table check
-- also finally forgets the claim table dropped in 010.
--
-- What is deliberately NOT here: a tenant column on embedding. The semantic
-- arm now scopes to the tenant inside the index probe by joining the owning
-- row (see semanticNodeSearchSql in pgStore), which needs no schema change.
-- Stamping a tenant column onto the existing rows was prototyped and measured:
-- the vector is TOASTed so the UPDATE copies a pointer, but pages are full, so
-- none of the 72k rewrites are HOT and every new tuple version is inserted
-- into the HNSW index — 176 s on a laptop, the index doubled from 481 MB to
-- 996 MB, and it never shrinks without a REINDEX. That belongs in the same
-- maintenance window as the halfvec conversion, where the rewrite is free.
--
-- Every statement is idempotent and cheap on the production table: the
-- sweeps are anti-joins through the unique key (owner_table leads it) against
-- primary keys, and the trigger is per-row.

delete from embedding e
where e.owner_table = 'text_unit'
  and not exists (select 1 from text_unit tu where tu.id = e.owner_id);

delete from embedding e
where e.owner_table = 'node_revision'
  and not exists (select 1 from node_revision nr where nr.id = e.owner_id);

create or replace function embedding_forget_owner() returns trigger
language plpgsql as $$
begin
  delete from embedding where owner_table = tg_table_name and owner_id = old.id;
  return old;
end $$;

drop trigger if exists text_unit_forget_embedding on text_unit;
create trigger text_unit_forget_embedding
  after delete on text_unit
  for each row execute function embedding_forget_owner();

drop trigger if exists node_revision_forget_embedding on node_revision;
create trigger node_revision_forget_embedding
  after delete on node_revision
  for each row execute function embedding_forget_owner();

-- 010 dropped the claim table; the check still admitted it.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'embedding'::regclass
      and conname = 'embedding_owner_table_check'
      and pg_get_constraintdef(oid) like '%claim%'
  ) then
    alter table embedding drop constraint embedding_owner_table_check;
    alter table embedding
      add constraint embedding_owner_table_check
      check (owner_table in ('node', 'node_revision', 'source', 'text_unit', 'annotation'));
  end if;
end $$;
