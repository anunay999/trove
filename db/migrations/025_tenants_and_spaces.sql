-- Tenants and spaces: the owner of a graph row becomes a space, not a user.
--
-- A tenant is a company (or a one-person tenant made at sign-up). Inside it each
-- member has a private space, and the tenant has one shared space (the
-- workspace). docs/workspaces.md is the design.
--
-- No graph row is rewritten. Every existing user gets a personal tenant and a
-- private space whose id IS their user id, so every stored owner_id (and
-- embedding.tenant_id, which holds the same value) stays valid; only the
-- foreign keys move from app_user to space. A trigger provisions the same pair
-- for every user inserted afterwards, so no write path can stamp an owner that
-- has no space.
--
-- Deleting a user no longer unowns their rows: the space survives with
-- user_id NULL and its rows stay with the tenant (docs/workspaces.md, decision 9).
--
-- Idempotent: guarded creates, an on-conflict backfill, and constraints swapped
-- only when the old one is still there.

create table if not exists tenant (
  id uuid primary key default gen_random_uuid(),
  -- NULL for a personal tenant; a Clerk organization id otherwise.
  clerk_org_id text unique,
  name text not null,
  -- Set only on the personal tenant made for this user at sign-up.
  personal_user_id uuid unique references app_user(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists tenant_member (
  tenant_id uuid not null references tenant(id) on delete cascade,
  user_id uuid not null references app_user(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index if not exists tenant_member_user_idx on tenant_member (user_id);

create table if not exists space (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  kind text not null check (kind in ('private', 'shared')),
  user_id uuid references app_user(id) on delete set null,
  created_at timestamptz not null default now()
);

-- One private space per member per tenant, one shared space per tenant.
create unique index if not exists space_private_member_key on space (tenant_id, user_id) where kind = 'private';
create unique index if not exists space_shared_tenant_key on space (tenant_id) where kind = 'shared';

create or replace function provision_personal_tenant() returns trigger
language plpgsql as $$
declare t uuid;
begin
  insert into tenant (name, personal_user_id)
  values (coalesce(new.display_name, new.email, 'Personal'), new.id)
  on conflict (personal_user_id) do nothing
  returning id into t;
  if t is null then
    select id into t from tenant where personal_user_id = new.id;
  end if;
  insert into tenant_member (tenant_id, user_id, role) values (t, new.id, 'admin')
  on conflict do nothing;
  insert into space (id, tenant_id, kind, user_id) values (new.id, t, 'private', new.id)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists app_user_provision_personal_tenant on app_user;
create trigger app_user_provision_personal_tenant
  after insert on app_user
  for each row execute function provision_personal_tenant();

-- Backfill users that existed before the trigger. A no-op update fires
-- nothing, so call the provisioning body directly per user.
do $$
declare u record; t uuid;
begin
  for u in select id, display_name, email from app_user
           where not exists (select 1 from space s where s.id = app_user.id) loop
    insert into tenant (name, personal_user_id)
    values (coalesce(u.display_name, u.email, 'Personal'), u.id)
    on conflict (personal_user_id) do nothing
    returning id into t;
    if t is null then
      select id into t from tenant where personal_user_id = u.id;
    end if;
    insert into tenant_member (tenant_id, user_id, role) values (t, u.id, 'admin') on conflict do nothing;
    insert into space (id, tenant_id, kind, user_id) values (u.id, t, 'private', u.id) on conflict (id) do nothing;
  end loop;
end $$;

-- Move each graph owner foreign key from app_user to space, keeping its delete
-- rule. NOT VALID adds the constraint without a scan; VALIDATE then checks the
-- existing rows without blocking writes. Every stored owner_id is a user id,
-- and every user now has a space with that id, so validation cannot fail.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('annotation', 'set null'), ('edge', 'set null'), ('graph_event', 'set null'),
      ('graph_job', 'cascade'), ('graph_view', 'set null'), ('node', 'set null'),
      ('reconcile_flag', 'cascade'), ('source', 'set null'), ('text_chunk', 'set null'),
      ('text_unit', 'set null')
    ) as t(tbl, on_delete)
  loop
    if exists (
      select 1 from pg_constraint
      where conname = spec.tbl || '_owner_id_fkey' and confrelid = 'app_user'::regclass
    ) then
      execute format('alter table %I drop constraint %I', spec.tbl, spec.tbl || '_owner_id_fkey');
    end if;
    if not exists (select 1 from pg_constraint where conname = spec.tbl || '_owner_space_fkey') then
      execute format(
        'alter table %I add constraint %I foreign key (owner_id) references space(id) on delete %s not valid',
        spec.tbl, spec.tbl || '_owner_space_fkey', spec.on_delete
      );
      execute format('alter table %I validate constraint %I', spec.tbl, spec.tbl || '_owner_space_fkey');
    end if;
  end loop;
end $$;
