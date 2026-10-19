-- Preserve the exact post-publication locales chosen with the approval.
-- Recovery must replay the original dispatch, not reinterpret a changed site policy.
alter table jobs add column publication_locales_json text not null default '[]';
