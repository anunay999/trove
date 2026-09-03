-- The boot-safe half of the halfvec + tenant conversion.
--
-- Two changes want the same table rewrite: halving the vector column
-- (halfvec(1536) — measured identical recall, half the bytes, an HNSW build
-- roughly twice as fast) and giving the embedding row its own tenant so the
-- semantic probe can filter inside the index scan without joining the owning
-- row. Migration 016 measured the tenant backfill on its own at 176 s with the
-- HNSW index doubling from 481 MB to 996 MB, and declined to do it then. Both
-- still belong in a maintenance window, together, on the smaller table that
-- chunk embeddings (020) leaves behind — so the work lives in
-- scripts/convertEmbeddingStorage.ts, batched and resumable, and NOT here:
-- a rewrite plus an HNSW rebuild cannot finish inside Railway's 120-second
-- healthcheck window, and a retried boot would start it over.
--
-- What IS boot-safe is the column itself. ALTER TABLE ADD COLUMN with no
-- default is a catalog-only change on PostgreSQL 11+ — no rewrite, no scan,
-- milliseconds on a 1 GB table. Landing it at deploy time means every vector
-- written from then on is stamped by pgStore.embedRows, so the script has only
-- history to backfill rather than a moving target.
--
-- The name is tenant_id, not owner_id: embedding.owner_id already means the
-- polymorphic OWNING ROW (a node_revision or a text_chunk), which is a
-- different thing from the tenant that owns it. NULL means "not stamped yet"
-- and nothing else — an unowned row (pre-isolation, or superuser-written)
-- stamps the all-zero sentinel migration 006 already uses in
-- source_owner_content_key. That is what lets the store tell a finished
-- backfill from an unfinished one with one indexless heap probe.
--
-- No index here on purpose: an index over a column that is entirely NULL would
-- have to scan the whole 1 GB table at boot to build. The script creates it
-- after the rewrite, where an index build is expected and paid for.

alter table embedding add column if not exists tenant_id uuid;

comment on column embedding.tenant_id is
  'Tenant (app_user) that owns this vector''s owning row; all-zero uuid when unowned. NULL means the conversion backfill has not reached this row yet.';

-- The halfvec half, but ONLY on an empty table.
--
-- db/schema.sql cannot declare halfvec: migration 009 creates
-- embedding_hnsw_idx with vector_cosine_ops, and Postgres validates an operator
-- class against the column type before honouring CREATE INDEX IF NOT EXISTS, so
-- a halfvec column there would fail every fresh bootstrap on an applied,
-- immutable migration. Doing it here instead works because 009 has already run
-- by this point.
--
-- Guarded on the table being EMPTY, which is the whole safety argument: with no
-- rows, ALTER COLUMN TYPE is a catalog-only rewrite and the index rebuild
-- indexes nothing, so a fresh database (local, CI, a new deployment) is born in
-- the end state in milliseconds. Production has ~70k rows, so this is skipped
-- there and scripts/convertEmbeddingStorage.ts does the rewrite in a
-- maintenance window, where the HNSW rebuild has time to finish. Re-running is
-- a no-op either way: a converted column is already halfvec, and a populated
-- one is left alone.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'halfvec') then
    return;  -- pgvector older than 0.7; nothing to convert to.
  end if;
  if exists (select 1 from embedding limit 1) then
    return;  -- populated: a maintenance-window job, not a boot migration.
  end if;
  if (select format_type(atttypid, null) from pg_attribute
       where attrelid = 'embedding'::regclass and attname = 'embedding') like 'halfvec%' then
    return;  -- already converted.
  end if;

  drop index if exists embedding_hnsw_idx;
  alter table embedding alter column embedding type halfvec(1536) using embedding::halfvec(1536);
  create index embedding_hnsw_idx on embedding using hnsw (embedding halfvec_cosine_ops);
  create index if not exists embedding_tenant_idx on embedding(tenant_id);
end $$;
