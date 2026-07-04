-- Clerk-backed users and per-user API keys.
-- Idempotent: the migration runner replays every file on each deploy.

create table if not exists app_user (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null unique,
  email text,
  display_name text,
  role text not null default 'member' check (role in ('admin', 'member')),
  status text not null default 'waitlisted' check (status in ('waitlisted', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references app_user(id)
);

create index if not exists app_user_status_idx on app_user (status);

create table if not exists user_api_key (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  scopes text[] not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists user_api_key_user_idx on user_api_key (user_id);
