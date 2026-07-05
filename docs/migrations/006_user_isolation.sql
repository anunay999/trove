-- Per-user data isolation.
--
-- Every graph row gets an owner (app_user). Reads filter by it; writes stamp it.
-- NULL owner_id means "unowned": pre-isolation rows before backfill, and rows
-- written by a superuser context (auth-disabled local dev / CI, which sees the
-- whole graph). Every authenticated production credential resolves to an owner,
-- so NULL never appears in a multi-user deployment after backfill.

-- on delete set null: removing a user unowns their rows (they fall out of every
-- scoped read) rather than failing on the FK or cascade-deleting graph history.
alter table source      add column if not exists owner_id uuid references app_user(id) on delete set null;
alter table text_unit   add column if not exists owner_id uuid references app_user(id) on delete set null;
alter table node        add column if not exists owner_id uuid references app_user(id) on delete set null;
alter table edge        add column if not exists owner_id uuid references app_user(id) on delete set null;
alter table annotation  add column if not exists owner_id uuid references app_user(id) on delete set null;
alter table graph_view  add column if not exists owner_id uuid references app_user(id) on delete set null;
alter table graph_event add column if not exists owner_id uuid references app_user(id) on delete set null;

-- Backfill the existing graph to the founding admin (oldest admin user), so the
-- data captured before isolation stays visible to its owner once scoping is on.
do $$
declare founder uuid;
begin
  select id into founder from app_user where role = 'admin' order by created_at asc limit 1;
  if founder is not null then
    update source      set owner_id = founder where owner_id is null;
    update text_unit   set owner_id = founder where owner_id is null;
    update node        set owner_id = founder where owner_id is null;
    update edge        set owner_id = founder where owner_id is null;
    update annotation  set owner_id = founder where owner_id is null;
    update graph_view  set owner_id = founder where owner_id is null;
    update graph_event set owner_id = founder where owner_id is null;
  end if;
end $$;

-- Dedup sources per owner, not globally: two owners may hold identical content
-- independently, and an ingest can never dedup into (or overwrite) another
-- owner's source row. NULLs (unowned/superuser) collapse to a sentinel so
-- local/CID re-ingests still dedup.
alter table source drop constraint if exists source_kind_content_sha256_key;
create unique index if not exists source_owner_content_key
  on source (kind, content_sha256, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid));

create index if not exists source_owner_idx      on source(owner_id);
create index if not exists text_unit_owner_idx   on text_unit(owner_id);
create index if not exists node_owner_idx        on node(owner_id);
create index if not exists edge_owner_idx         on edge(owner_id);
create index if not exists annotation_owner_idx  on annotation(owner_id);
create index if not exists graph_view_owner_idx  on graph_view(owner_id);
create index if not exists graph_event_owner_idx on graph_event(owner_id);
