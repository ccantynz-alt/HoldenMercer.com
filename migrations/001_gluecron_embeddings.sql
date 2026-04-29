-- GlueCron embeddings table (pgvector)
-- Run once in your Supabase SQL editor.

-- Enable pgvector (available on all Supabase plans)
create extension if not exists vector;

-- Main embeddings table
create table if not exists gluecron_embeddings (
    id               bigserial primary key,
    repo             text not null,
    path             text not null,
    sha              text not null,
    content_snippet  text,
    embedding        vector(1536),   -- text-embedding-3-small dimension
    source           text default 'GlueCron',
    indexed_at       timestamptz default now(),
    unique (repo, path)
);

create index if not exists idx_gluecron_embeddings_repo
    on gluecron_embeddings (repo);

-- IVFFlat index for fast approximate nearest-neighbour search
-- Tune lists = rows/1000, capped at 100.  Re-run after bulk inserts.
create index if not exists idx_gluecron_embeddings_vec
    on gluecron_embeddings
    using ivfflat (embedding vector_cosine_ops)
    with (lists = 50);


-- RPC: match_gluecron_files
-- Returns top-k most similar files to the query embedding.
create or replace function match_gluecron_files(
    query_embedding  vector(1536),
    match_count      int default 5
)
returns table (
    repo             text,
    path             text,
    content_snippet  text,
    similarity       float
)
language sql stable
as $$
    select
        repo,
        path,
        content_snippet,
        1 - (embedding <=> query_embedding) as similarity
    from gluecron_embeddings
    order by embedding <=> query_embedding
    limit match_count;
$$;


-- RPC: match_gluecron_files_by_repo
-- Same as above but filtered to a specific repo.
create or replace function match_gluecron_files_by_repo(
    query_embedding  vector(1536),
    match_count      int default 5,
    filter_repo      text default ''
)
returns table (
    repo             text,
    path             text,
    content_snippet  text,
    similarity       float
)
language sql stable
as $$
    select
        repo,
        path,
        content_snippet,
        1 - (embedding <=> query_embedding) as similarity
    from gluecron_embeddings
    where repo = filter_repo
    order by embedding <=> query_embedding
    limit match_count;
$$;
