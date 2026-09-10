-- MCP Tasks extension (io.modelcontextprotocol/tasks, SEP-2663).
-- One row per server-minted task handle: the stateless-era replacement for
-- holding work open on a connection. export_obsidian (and future heavy
-- tools) inserts a row, answers tools/call with a CreateTaskResult handle,
-- and the client polls tasks/get; any instance can serve the poll because
-- the state lives here, not in a process.
create table if not exists mcp_task (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  status text not null default 'working'
    check (status in ('working', 'completed', 'failed', 'cancelled')),
  status_message text,
  -- The tool name + arguments snapshot, so the task can be audited and (one
  -- day) resumed without remembering the request that created it.
  request jsonb not null default '{}'::jsonb,
  -- Final result: a CallToolResult for tools/call tasks (isError:true stays
  -- 'completed' per the extension spec; 'failed' is for JSON-RPC errors).
  result jsonb,
  -- JSON-RPC error object when status = 'failed'.
  error jsonb,
  -- Caller binding: a task is a bearer handle, but polls re-authenticate and
  -- must resolve to the same owner (or a superuser) before reading state.
  owner_id uuid,
  actor_id text not null,
  ttl_ms integer not null default 3600000,
  poll_interval_ms integer not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mcp_task_owner_created_idx on mcp_task(owner_id, created_at desc);
