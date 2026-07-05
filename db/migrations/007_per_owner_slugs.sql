-- Per-owner slug namespaces.
--
-- Slugs were globally unique, so two owners couldn't both hold `project-x`
-- (the second got suffixed, leaking that the name was taken). Scope uniqueness
-- to the owner instead. NULL owners (unowned / superuser writes) collapse to a
-- sentinel so they still dedup among themselves.

alter table node drop constraint if exists node_slug_key;
create unique index if not exists node_owner_slug_key
  on node (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);

alter table graph_view drop constraint if exists graph_view_slug_key;
create unique index if not exists graph_view_owner_slug_key
  on graph_view (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
