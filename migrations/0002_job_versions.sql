-- Job drafts are a list of locale versions, not hardcoded en/pt columns.
-- Legacy en_* / pt_* columns stay as a compatibility mirror.

alter table jobs add column versions_json text not null default '[]';
