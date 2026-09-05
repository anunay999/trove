-- Take the Supabase Data API off the critical path.
--
-- Supabase grants `anon` and `authenticated` full DML on every table in
-- `public` by default, and Trove runs with RLS off on all of its tables --
-- correctly, since it is a direct-connection application whose authorisation
-- lives in the app (Clerk sessions, service tokens, per-user trove_* keys),
-- not in the database.
--
-- Those two facts together meant the only thing standing between the internet
-- and SELECT/INSERT/UPDATE/DELETE/TRUNCATE on `node` and `user_api_key` was the
-- Data API toggle being switched off in the dashboard. The anon key is
-- PUBLISHABLE by design -- it ships in client bundles -- so that single switch
-- was load-bearing security with nothing behind it. Measured on production
-- 2026-09-05: 112 grants to `anon`, 112 to `authenticated`, RLS off on 16/16
-- tables.
--
-- Revoking here rather than only in the dashboard matters for a reason the
-- dashboard cannot cover: a NEW environment comes up with the defaults
-- restored, and nobody reading the repo would know this was ever decided.
--
-- The default-privileges statements are not decoration. Without them the next
-- migration that creates a table re-opens the hole silently, because the grants
-- are attached to the schema's defaults rather than to the tables themselves.
--
-- `service_role` is deliberately untouched: it requires the secret key rather
-- than the publishable one, and Supabase's own tooling uses it.
--
-- Guarded on the roles existing, so this is a no-op on local Docker Postgres
-- and on every isolated test database, where `anon` and `authenticated` do not
-- exist. Idempotent: revoking a privilege that is already absent is a no-op.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')
     or not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise notice 'Supabase roles absent; nothing to revoke.';
    return;
  end if;

  execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
  execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
  execute 'alter default privileges in schema public revoke all on functions from anon, authenticated';

  execute 'revoke all on all tables in schema public from anon, authenticated';
  execute 'revoke all on all sequences in schema public from anon, authenticated';
  execute 'revoke all on all functions in schema public from anon, authenticated';
  execute 'revoke usage on schema public from anon, authenticated';
end $$;
