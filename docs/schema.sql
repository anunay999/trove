-- Trove starter schema.
-- This is intentionally plain Postgres: relational graph first, specialized indexes later.

create extension if not exists pgcrypto;
create extension if not exists vector;

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

create type claim_status as enum (
  'active',
  'stale',
  'contradicted',
  'superseded',
  'retracted'
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
  content text,
  projection_markdown text,
  frontmatter jsonb not null default '{}'::jsonb,
  content_sha256 text not null,
  created_by uuid references actor(id),
  created_at timestamptz not null default now(),
  unique (node_id, revision_number),
  unique (node_id, content_sha256)
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
  valid_from timestamptz,
  valid_until timestamptz,
  expired_at timestamptz,
  invalidated_by uuid references edge(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index edge_active_unique_idx
  on edge(from_node_id, to_node_id, predicate)
  where deleted_at is null and expired_at is null;

create table claim (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references node(id),
  statement text not null,
  status claim_status not null default 'active',
  confidence double precision check (confidence is null or confidence between 0 and 1),
  source_id uuid references source(id),
  valid_from timestamptz,
  valid_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references actor(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table annotation (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references source(id),
  text_unit_id uuid references text_unit(id),
  node_id uuid references node(id),
  claim_id uuid references claim(id),
  motivation text not null,
  body jsonb not null default '{}'::jsonb,
  selector jsonb not null default '{}'::jsonb,
  created_by uuid references actor(id),
  created_at timestamptz not null default now(),
  check (source_id is not null or text_unit_id is not null),
  check (node_id is not null or claim_id is not null or body <> '{}'::jsonb)
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
  kind text not null check (kind in ('refresh_obsidian_projection', 'lint_graph', 'refresh_embeddings')),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
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
  owner_table text not null check (owner_table in ('node', 'node_revision', 'source', 'text_unit', 'claim', 'annotation')),
  owner_id uuid not null,
  model text not null,
  dimensions integer not null,
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
create index claim_node_status_idx on claim(node_id, status);
create index annotation_text_unit_idx on annotation(text_unit_id);
create index annotation_claim_idx on annotation(claim_id);
create index graph_event_entity_idx on graph_event(entity_table, entity_id, created_at desc);
create index graph_job_status_idx on graph_job(status, priority desc, created_at);
create index graph_job_kind_idx on graph_job(kind, created_at desc);

create index node_search_idx on node using gin(
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))
) where deleted_at is null;

create index revision_content_search_idx on node_revision using gin(
  to_tsvector('english', coalesce(content, '') || ' ' || coalesce(projection_markdown, ''))
);

create index text_unit_search_idx on text_unit using gin(
  to_tsvector('english', text)
);

-- Add an HNSW index after the embedding volume and dimensions are stable.
-- create index embedding_hnsw_idx on embedding using hnsw (embedding vector_cosine_ops);
