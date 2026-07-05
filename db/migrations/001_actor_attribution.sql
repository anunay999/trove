alter table graph_event
  add column if not exists interface_id text;

create index if not exists graph_event_actor_idx on graph_event(actor_id, created_at desc);
create index if not exists graph_event_interface_idx on graph_event(interface_id, created_at desc);
