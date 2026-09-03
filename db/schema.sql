-- Trove starter schema.
-- This is intentionally plain Postgres: relational graph first, specialized indexes later.
--
-- STATUS: historical bootstrap snapshot, not the current schema. db/migrations/
-- is the source of truth; a fresh database is bootstrapped as this file followed
-- by every migration (src/migrate.ts records each in schema_migrations). Known
-- drift, so nobody mistakes this file for either the baseline or the present:
--   - migrations 003 (bitemporal edge columns), 008 (pg_trgm + node_title_trgm_idx),
--     009 (embedding_hnsw_idx) and 012 (node_revision.title/summary) are merged
--     in here, so a fresh bootstrap applies them as no-ops;
--   - migration 006 (per-user isolation: owner_id on graph tables, the owner
--     backfill and owner indexes) is NOT merged in, so it does real work on a
--     fresh database;
--   - this file still declares the global unique constraints that 006 and 007
--     replace: source (kind, content_sha256) -> source_owner_content_key,
--     node.slug -> node_owner_slug_key, graph_view.slug -> graph_view_owner_slug_key;
--   - it still lists 'claim' in embedding.owner_table's check, which 010 drops
--     alongside the claim table;
--   - migration 020 (text_chunk, the grain the vector index is built on) is NOT
--     merged in either: its owner_id references app_user, which migration 004
--     creates, so the table cannot be declared before the migrations run.
-- Do not "fix" the drift by editing applied migrations: their checksums are
-- recorded, and a changed file fails the next boot.

create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists btree_gist;

create type node_type as enum (
  'entity',
  'project',
  'pattern',
  'domain',
  'person',
  'infrastructure',
  'claim',
  'decision',
  'task',
  'question',
  'community',
  'view'
);

create type source_kind as enum (
  'markdown_page',
  'url',
  'file',
  'paste',
  'email',
  'slack',
  'screenshot',
  'transcript',
  'agent_note'
);

create table actor (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique,
  display_name text not null,
  kind text not null check (kind in ('human', 'agent', 'service')),
  created_at timestamptz not null default now()
);

create table source (
  id uuid primary key default gen_random_uuid(),
  kind source_kind not null,
  uri text,
  title text not null,
  content_sha256 text not null,
  content_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references actor(id),
  created_at timestamptz not null default now(),
  unique (kind, content_sha256)
);

create table text_unit (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references source(id),
  parent_text_unit_id uuid references text_unit(id),
  ordinal integer not null,
  section_path text[] not null default '{}',
  char_start integer,
  char_end integer,
  text text not null,
  token_count integer,
  content_sha256 text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_id, ordinal)
);

create table node (
  id uuid primary key default gen_random_uuid(),
  type node_type not null,
  slug text not null unique,
  title text not null,
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  current_revision_id uuid,
  access_count bigint not null default 0,
  last_accessed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table node_revision (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references node(id),
  source_id uuid references source(id),
  revision_number bigint not null,
  title text,
  summary text,
  content text,
  frontmatter jsonb not null default '{}'::jsonb,
  content_sha256 text not null,
  created_by uuid references actor(id),
  created_at timestamptz not null default now(),
  unique (node_id, revision_number)
);

alter table node
  add constraint node_current_revision_fk
  foreign key (current_revision_id) references node_revision(id);

create table edge (
  id uuid primary key default gen_random_uuid(),
  from_node_id uuid not null references node(id),
  to_node_id uuid not null references node(id),
  predicate text not null,
  weight double precision not null default 1.0,
  metadata jsonb not null default '{}'::jsonb,
  source_id uuid references source(id),
  created_by uuid references actor(id),
  -- Bitemporal belief tracking: created_at is transaction time, valid_from/valid_until
  -- are world time, expired_at marks when the system stopped believing the edge.
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  expired_at timestamptz,
  invalidated_by uuid references edge(id),
  -- Why the edge stopped being believed; set iff expired_at is set (014).
  invalidation_reason text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint edge_valid_range_check
    check (valid_until is null or valid_until >= valid_from),
  constraint edge_invalidation_reason_check
    check (
      (expired_at is null and invalidation_reason is null)
      or (expired_at is not null and invalidation_reason in ('superseded', 'invalidated', 'tombstoned'))
    ),
  -- One version of a triple per world-time instant, expired versions included.
  constraint edge_valid_range_excl
    exclude using gist (
      from_node_id with =,
      to_node_id with =,
      predicate with =,
      tstzrange(valid_from, valid_until, '[)') with &&
    ) where (deleted_at is null)
);

create unique index edge_active_unique_idx
  on edge(from_node_id, to_node_id, predicate)
  where deleted_at is null and expired_at is null;

create table annotation (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references source(id),
  text_unit_id uuid references text_unit(id),
  node_id uuid references node(id),
  motivation text not null,
  body jsonb not null default '{}'::jsonb,
  selector jsonb not null default '{}'::jsonb,
  created_by uuid references actor(id),
  created_at timestamptz not null default now(),
  check (source_id is not null or text_unit_id is not null),
  constraint annotation_target_check check (node_id is not null or body <> '{}'::jsonb)
);

create table graph_event (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references actor(id),
  interface_id text,
  action text not null,
  entity_table text not null,
  entity_id uuid not null,
  before jsonb,
  after jsonb,
  request_id text,
  created_at timestamptz not null default now()
);

create table graph_view (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  root_node_id uuid references node(id),
  query text,
  layout jsonb not null default '{}'::jsonb,
  included_node_ids uuid[] not null default '{}',
  included_edge_ids uuid[] not null default '{}',
  summary text,
  created_by uuid references actor(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table graph_job (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('refresh_obsidian_projection', 'lint_graph', 'refresh_embeddings', 'reconcile_node')),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'dead')),
  priority integer not null default 50 check (priority between 0 and 100),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  dedupe_key text,
  attempts integer not null default 0,
  created_by uuid references actor(id),
  claimed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create unique index graph_job_open_dedupe_idx
  on graph_job(kind, dedupe_key)
  where dedupe_key is not null and status in ('pending', 'running');

create table embedding (
  id uuid primary key default gen_random_uuid(),
  -- owner_table / owner_id name the owning ROW (no FK: the table is
  -- polymorphic); the triggers below delete a vector with its row.
  owner_table text not null check (owner_table in ('node', 'node_revision', 'source', 'text_unit', 'annotation')),
  owner_id uuid not null,
  model text not null,
  dimensions integer not null,
  -- vector(1536), not halfvec: converting is a ~413 MB column rewrite plus an
  -- HNSW rebuild in production — a maintenance-window job, not a boot migration.
  embedding vector(1536) not null,
  content_sha256 text not null,
  created_at timestamptz not null default now(),
  unique (owner_table, owner_id, model, content_sha256)
);

create index node_type_idx on node(type) where deleted_at is null;
create index node_metadata_gin_idx on node using gin(metadata);
create index source_metadata_gin_idx on source using gin(metadata);
create index text_unit_source_idx on text_unit(source_id, ordinal);
create index text_unit_section_path_gin_idx on text_unit using gin(section_path);
create index edge_from_idx on edge(from_node_id) where deleted_at is null;
create index edge_to_idx on edge(to_node_id) where deleted_at is null;
create index edge_predicate_idx on edge(predicate) where deleted_at is null;
create index annotation_text_unit_idx on annotation(text_unit_id);
create index annotation_node_idx on annotation(node_id);
create index graph_event_entity_idx on graph_event(entity_table, entity_id, created_at desc);
-- Migration 019: retention prunes oldest-first, and the feed's keyset order is
-- (created_at, id); one index serves both.
create index graph_event_created_at_idx on graph_event(created_at, id);
create index graph_job_status_idx on graph_job(status, priority desc, created_at);
create index graph_job_kind_idx on graph_job(kind, created_at desc);
create index node_revision_as_of_idx
  on node_revision(node_id, created_at desc, revision_number desc);

create index node_search_idx on node using gin(
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))
) where deleted_at is null;

create index revision_content_search_idx on node_revision using gin(
  to_tsvector('english', coalesce(content, ''))
);

create index text_unit_search_idx on text_unit using gin(
  to_tsvector('english', text)
);

create index node_title_trgm_idx on node using gin (title gin_trgm_ops);
create index node_summary_trgm_idx on node using gin (summary gin_trgm_ops);
create index node_slug_idx on node (slug);
create index node_revision_content_trgm_idx on node_revision using gin (content gin_trgm_ops);
create index text_unit_text_trgm_idx on text_unit using gin (text gin_trgm_ops);

create index embedding_hnsw_idx on embedding using hnsw (embedding vector_cosine_ops);

-- node churns on every read (access activation) and graph_event grows on every
-- write; the default 20% dead-tuple trigger is far too lazy for them.
alter table node set (autovacuum_vacuum_scale_factor = 0.02);
alter table graph_event set (autovacuum_vacuum_scale_factor = 0.02);

-- Migration 016: a vector leaves with the row that owns it.
create or replace function embedding_forget_owner() returns trigger
language plpgsql as $$
begin
  delete from embedding where owner_table = tg_table_name and owner_id = old.id;
  return old;
end $$;

create trigger text_unit_forget_embedding
  after delete on text_unit
  for each row execute function embedding_forget_owner();

create trigger node_revision_forget_embedding
  after delete on node_revision
  for each row execute function embedding_forget_owner();
