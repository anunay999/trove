-- Which tenant a user's credentials act in. Null means their personal tenant.
-- The dashboard's active Clerk organization sets it; API keys and OAuth follow it.
alter table app_user
  add column if not exists active_tenant_id uuid references tenant(id) on delete set null;
