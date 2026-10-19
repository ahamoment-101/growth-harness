-- Keep the human and agent-facing document source alongside structured compatibility fields.
alter table business_module_versions add column markdown text not null default '';
