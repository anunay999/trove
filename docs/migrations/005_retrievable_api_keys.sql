-- Store the API key secret alongside its hash so owners can re-copy keys
-- from the dashboard. Deliberate tradeoff: database readers can see keys;
-- acceptable for a personal/small-team instance. Keys created before this
-- migration have secret = null (unrecoverable; recreate them).

alter table user_api_key add column if not exists secret text;
