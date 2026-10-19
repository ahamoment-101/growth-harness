-- Per-job translation targets. NULL = legacy jobs (fall back to workspace).
-- '[]' = English only. '["pt-BR"]' = English then Portuguese, etc.

alter table jobs add column translate_locales_json text;
