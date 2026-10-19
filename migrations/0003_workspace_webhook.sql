-- Workspace webhook mapping + user-selected translation locales.
-- English remains the source locale in code (not a column).

alter table sites add column translate_locales_json text not null default '["pt-BR"]';
alter table sites add column webhook_mode text not null default 'group';
alter table sites add column webhook_fields_json text not null default '[{"key":"translation_group","from":"translation_group"},{"key":"category","from":"category"},{"key":"status","from":"status"},{"key":"versions","from":"versions"}]';
