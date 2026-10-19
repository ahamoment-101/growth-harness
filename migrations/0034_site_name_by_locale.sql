-- Per-locale project names ("Name" in project settings), keyed by locale.
-- Entries are soft-deleted (deleted_at tombstone) when a locale is deselected,
-- so re-enabling the locale brings the previous value back.
alter table sites add column name_by_locale_json text not null default '{}';
