-- A coarser grain for the vector index. The text unit stays the citation grain.
--
-- splitTextUnits splits a source into LINES, and every embeddable line got its
-- own 1536-dimension vector: 70,479 of production's 71,929 vectors, 98% of the
-- vector bytes, and the direct cause of the disk-full outage on 3 September.
-- A line is also the wrong thing to embed — "…and that is why we moved off
-- Railway." carries almost no retrievable meaning alone, which is the finding
-- behind Anthropic's contextual retrieval (a written prefix per chunk cut
-- top-20 misses from 5.7% to 1.9%) and AtomMem's flat atomic facts.
--
-- So: change what gets EMBEDDED, not what gets CITED. text_chunk gathers a
-- contiguous run of text units (never crossing a section_path boundary, capped
-- by CHUNK_TARGET_CHARS in graphCore) and carries the context prefix the run is
-- embedded with. A semantic hit resolves back through
-- (source_id, first_ordinal..last_ordinal) to the very text units it covers, so
-- evidence quotes, annotations and the served-unit log keep pointing at text
-- units exactly as before.
--
-- WHY A TABLE AND NOT A DERIVED GROUPING. A grouping keyed on
-- (source_id, ordinal / N) needs no DDL, and was rejected for three reasons:
-- embedding is polymorphic on a uuid owner_id, so a derived chunk has no stable
-- id to key the (owner_table, owner_id, model, content_sha256) unique index on;
-- the orphan-sweep triggers from 016 delete a vector by owner row, which a
-- phantom row cannot trigger; and resolving a hit back to text units would mean
-- re-deriving the split in SQL, a second implementation of buildTextChunks that
-- would drift from the TypeScript one the moment either changed. A real table
-- costs one index and gives all three for free.
--
-- Cheap at boot: an empty table, its indexes, one trigger, and a CHECK widened
-- NOT VALID (the new value is a superset of the old, so no existing row can
-- violate it and no scan of the 1 GB embedding table is needed). The chunk rows
-- for sources ingested before this are built by refresh_embeddings, batched,
-- which then retires the per-line vectors it has replaced.

create table if not exists text_chunk (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references source(id),
  owner_id uuid references app_user(id) on delete set null,
  -- Dense index of the chunk within its source.
  ordinal integer not null,
  -- The inclusive text_unit.ordinal range this chunk covers. Contiguous by
  -- construction, so resolving a hit is a range scan on text_unit_source_idx.
  first_ordinal integer not null,
  last_ordinal integer not null,
  section_path text[] not null default '{}',
  -- The written context the chunk is embedded WITH, and never cited from.
  context_prefix text not null default '',
  -- The units' own text, joined by newlines.
  text text not null,
  token_count integer,
  -- sha256 of the exact embedding input (prefix + text), so a changed prefix
  -- re-embeds through the same not-exists check the refresh job already uses.
  content_sha256 text not null,
  created_at timestamptz not null default now(),
  unique (source_id, ordinal)
);

create index if not exists text_chunk_source_idx on text_chunk(source_id, ordinal);
create index if not exists text_chunk_owner_idx on text_chunk(owner_id);

-- 016's rule, extended to the new owner: a vector leaves with its row.
drop trigger if exists text_chunk_forget_embedding on text_chunk;
create trigger text_chunk_forget_embedding
  after delete on text_chunk
  for each row execute function embedding_forget_owner();

-- Chunks are derived from a source's text units; when the units go, so do they.
create or replace function text_chunk_forget_source() returns trigger
language plpgsql as $$
begin
  delete from text_chunk where source_id = old.source_id;
  return old;
end $$;

drop trigger if exists text_unit_forget_chunks on text_unit;
create trigger text_unit_forget_chunks
  after delete on text_unit
  for each row execute function text_chunk_forget_source();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'embedding'::regclass
      and conname = 'embedding_owner_table_check'
      and pg_get_constraintdef(oid) like '%text_chunk%'
  ) then
    alter table embedding drop constraint if exists embedding_owner_table_check;
    alter table embedding
      add constraint embedding_owner_table_check
      check (owner_table in ('node', 'node_revision', 'source', 'text_chunk', 'text_unit', 'annotation'))
      not valid;
  end if;
end $$;
