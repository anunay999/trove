create table if not exists graph_job (
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

create unique index if not exists graph_job_open_dedupe_idx
  on graph_job(kind, dedupe_key)
  where dedupe_key is not null and status in ('pending', 'running');

create index if not exists graph_job_status_idx on graph_job(status, priority desc, created_at);
create index if not exists graph_job_kind_idx on graph_job(kind, created_at desc);
