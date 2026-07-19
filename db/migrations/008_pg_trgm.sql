-- Trigram support for title-similarity matching (findSimilarTitles).
--
-- Remember-style flows check near-duplicate titles before minting a node;
-- pg_trgm gives us similarity() plus a GIN index to keep it fast.

create extension if not exists pg_trgm;

create index if not exists node_title_trgm_idx on node using gin (title gin_trgm_ops);
