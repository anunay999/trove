-- projection_markdown was declared on node_revision and indexed into the
-- revision full-text index, but every insert site wrote a literal null: half
-- of the index expression was dead weight, and lexical search recomputed the
-- same concatenation on every candidate row. Drop the column and rebuild the
-- index on content alone; the search SQL matches the new expression exactly,
-- which is what lets the planner use it.
drop index if exists revision_content_search_idx;
create index if not exists revision_content_search_idx
  on node_revision using gin (to_tsvector('english', coalesce(content, '')));
alter table node_revision drop column if exists projection_markdown;
