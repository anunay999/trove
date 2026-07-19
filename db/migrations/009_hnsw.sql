-- HNSW index over embeddings for approximate nearest-neighbor search.
--
-- Semantic search filters by owner scoping and distance floor, but the ANN
-- index keeps the <=> ordering cheap as embedding volume grows.

create index if not exists embedding_hnsw_idx on embedding using hnsw (embedding vector_cosine_ops);
