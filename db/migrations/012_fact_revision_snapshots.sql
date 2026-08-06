-- Snapshot the complete fact in every node revision so read({ asOf }) can
-- recover what Trove believed at a recorded time, not only the old body.
alter table node_revision
  add column if not exists title text,
  add column if not exists summary text;

-- Pre-migration revisions never recorded these fields. Seed them from the
-- node's current fact once; title is populated on every new revision, making
-- this replay-safe even when summary itself is null.
update node_revision nr
set title = n.title,
    summary = n.summary
from node n
where nr.node_id = n.id
  and nr.title is null;

-- Title/summary-only revisions legitimately share the same body hash.
alter table node_revision drop constraint if exists node_revision_node_id_content_sha256_key;

create index if not exists node_revision_as_of_idx
  on node_revision(node_id, created_at desc, revision_number desc);
