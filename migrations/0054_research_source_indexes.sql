-- Optional immutable snapshot indexes. Existing sources keep the full-read fallback.
create table research_source_indexes (
  source_id text primary key references research_sources(id) on delete cascade,
  index_json text not null
);
