-- Trigram indexes for the lexical arm of search and for grep.
--
-- Lexical search matched a tsvector OR three unanchored ilike patterns across
-- the node / node_revision join. No index can serve that disjunction, so every
-- hybrid search recomputed to_tsvector over every current revision, and the
-- same shape ran over every text unit (~149k rows in production). grep is a
-- regex with no index at all; pg_trgm has been installed since 008 but only
-- node titles carried a trigram index.
--
-- With these, each ilike/regex arm has a GIN path: within one table Postgres
-- BitmapOrs the full-text and trigram indexes, and lexicalSearch now unions a
-- node branch with a node_revision branch instead of OR-ing across the join.
-- node_slug_idx exists for the same reason — the per-owner slug key (007) has
-- owner_id leading, so a bare `slug = ...` arm had no path and dragged the
-- whole node branch back to a sequential scan.
--
-- node_revision has no "is current" column (currency is node.current_revision_id),
-- so the revision index covers every revision, not just current ones. The
-- statements are plain (non-concurrent) builds: they take SHARE on the table
-- for the duration, which blocks ingest writes but not reads. Measured on a
-- 149k-row, 42 MB text_unit stand-in at 2.3 s; a small Supabase instance is
-- expected to take well under a minute, inside the boot healthcheck window.

create index if not exists text_unit_text_trgm_idx on text_unit using gin (text gin_trgm_ops);
create index if not exists node_revision_content_trgm_idx on node_revision using gin (content gin_trgm_ops);
create index if not exists node_summary_trgm_idx on node using gin (summary gin_trgm_ops);
create index if not exists node_slug_idx on node (slug);
