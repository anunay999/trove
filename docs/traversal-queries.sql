-- Trove traversal and retrieval query recipes.
-- These are the v1 Postgres patterns before adding Kuzu as a materialized graph index.

-- 1. Bounded neighborhood expansion for mind maps and agent context.
with recursive walk as (
  select
    n.id as node_id,
    n.title,
    n.type,
    0 as depth,
    array[n.id] as path
  from node n
  where n.slug = $1

  union all

  select
    next_node.id as node_id,
    next_node.title,
    next_node.type,
    walk.depth + 1 as depth,
    walk.path || next_node.id as path
  from walk
  join edge e
    on e.deleted_at is null
   and (e.from_node_id = walk.node_id or e.to_node_id = walk.node_id)
  join node next_node
    on next_node.deleted_at is null
   and next_node.id = case
     when e.from_node_id = walk.node_id then e.to_node_id
     else e.from_node_id
   end
  where walk.depth < $2
    and not next_node.id = any(walk.path)
)
select distinct on (node_id)
  node_id,
  title,
  type,
  depth
from walk
order by node_id, depth;

-- 2. Evidence trail for a semantic node.
select
  n.slug,
  n.title,
  a.motivation,
  tu.section_path,
  tu.char_start,
  tu.char_end,
  tu.text,
  s.kind as source_kind,
  s.title as source_title,
  s.uri as source_uri
from node n
join annotation a on a.node_id = n.id
left join text_unit tu on tu.id = a.text_unit_id
left join source s on s.id = coalesce(a.source_id, tu.source_id)
where n.slug = $1
order by s.created_at, tu.ordinal, a.created_at;

-- 3. Hybrid-ish v1 search inside Postgres: lexical node matches plus source text matches.
with node_hits as (
  select
    'node' as hit_type,
    n.id,
    n.title,
    n.summary as snippet,
    ts_rank(
      to_tsvector('english', coalesce(n.title, '') || ' ' || coalesce(n.summary, '')),
      plainto_tsquery('english', $1)
    ) as score
  from node n
  where n.deleted_at is null
    and to_tsvector('english', coalesce(n.title, '') || ' ' || coalesce(n.summary, ''))
      @@ plainto_tsquery('english', $1)
),
text_hits as (
  select
    'text_unit' as hit_type,
    tu.id,
    s.title,
    left(tu.text, 280) as snippet,
    ts_rank(to_tsvector('english', tu.text), plainto_tsquery('english', $1)) as score
  from text_unit tu
  join source s on s.id = tu.source_id
  where to_tsvector('english', tu.text) @@ plainto_tsquery('english', $1)
)
select *
from (
  select * from node_hits
  union all
  select * from text_hits
) hits
order by score desc
limit coalesce($2, 20);

-- 4. Projection feed for Kuzu. The worker can stream these rows into node and relationship tables.
select
  id,
  type::text as label,
  slug,
  title,
  summary,
  metadata
from node
where deleted_at is null;

select
  id,
  from_node_id,
  to_node_id,
  predicate,
  weight,
  metadata
from edge
where deleted_at is null;

-- 5. Claims that may be stale because supporting evidence was superseded or contradicted.
select
  c.id as claim_id,
  c.statement,
  c.status,
  n.slug,
  n.title,
  array_agg(distinct a.motivation) as evidence_motivations
from claim c
join node n on n.id = c.node_id
left join annotation a on a.claim_id = c.id or a.node_id = n.id
where c.status = 'active'
group by c.id, c.statement, c.status, n.slug, n.title
having bool_or(a.motivation in ('contradicts', 'supersedes'));
