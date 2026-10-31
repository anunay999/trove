-- One-off: put every existing user into one company tenant, without moving a graph row.
--
--   psql "$DATABASE_URL" -v org_id=org_... -v org_name=Fairground \
--     -v shared_email=eng@fairground.run -v admin_emails=a@x.com,b@x.com \
--     -f scripts/joinEveryoneToTenant.sql
--
-- org_id is the Clerk organization id. Create the organization in Clerk and add
-- every user to it FIRST: credentials recheck Clerk membership and drop anyone
-- Clerk does not list.
--
-- Each user's personal private space (id = user id) moves into the tenant, so
-- their notes come with them as private notes. The shared account's space
-- becomes the tenant's shared space, so its notes become the team's. Space ids
-- never change, so owner_id and embedding.tenant_id stay valid. Rerun-safe.

\set ON_ERROR_STOP on
begin;
set local lock_timeout = '5s';

insert into tenant (clerk_org_id, name) values (:'org_id', :'org_name')
on conflict (clerk_org_id) do nothing;

create temp table target on commit drop as select id from tenant where clerk_org_id = :'org_id';

-- The shared account's space becomes the team space, unless the tenant already has one.
update space s set tenant_id = (select id from target), kind = 'shared', user_id = null
from app_user u
where u.email = :'shared_email' and s.id = u.id and s.kind = 'private'
  and not exists (select 1 from space x where x.tenant_id = (select id from target) and x.kind = 'shared');

insert into tenant_member (tenant_id, user_id, role)
select (select id from target), u.id,
       case when u.email = any(string_to_array(:'admin_emails', ',')) then 'admin' else 'member' end
from app_user u
on conflict (tenant_id, user_id) do nothing;

-- Personal private spaces move in, keeping their ids.
update space s set tenant_id = (select id from target)
from tenant p
where s.kind = 'private' and s.id = s.user_id
  and p.personal_user_id = s.user_id and s.tenant_id = p.id
  and not exists (select 1 from space x where x.tenant_id = (select id from target) and x.kind = 'private' and x.user_id = s.user_id);

-- Anyone still without a private space here (the shared account) gets a fresh one.
insert into space (tenant_id, kind, user_id)
select (select id from target), 'private', u.id from app_user u
on conflict (tenant_id, user_id) where kind = 'private' do nothing;

update app_user set active_tenant_id = (select id from target)
where active_tenant_id is distinct from (select id from target);

select (select count(*) from tenant_member where tenant_id = (select id from target)) as members,
       (select count(*) from space where tenant_id = (select id from target) and kind = 'private') as private_spaces,
       (select count(*) from space where tenant_id = (select id from target) and kind = 'shared') as shared_spaces,
       (select count(*) from app_user where active_tenant_id = (select id from target)) as active_here;
commit;
