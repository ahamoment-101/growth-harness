-- Immutable delivery snapshots, independent of the visible report rows.
create table seo_strategy_report_snapshots (
  strategy_version_id text not null references seo_strategy_versions(id) on delete cascade,
  doc_type text not null check(doc_type in ('strategy','keyword_map','research_notes')),
  body_md text not null,
  content_hash text not null,
  created_at text not null,
  primary key(strategy_version_id, doc_type)
);

-- Only existing, nonempty reports are recoverable. Do not invent missing history.
insert into seo_strategy_report_snapshots
select d.strategy_version_id,d.doc_type,d.body_md,d.content_hash,d.created_at
from seo_strategy_documents d join seo_strategy_versions v on v.id=d.strategy_version_id
where v.status!='draft' and d.doc_type in ('strategy','keyword_map','research_notes') and length(trim(d.body_md))>0;
