-- SEO identity is per site. Source locale is not assumed to be English.
-- Prefixes are persisted so adding a language cannot rewrite old URLs.
-- content_updated_at only moves when article body/title/slug/excerpt change.

alter table sites add column source_locale text not null default 'en';
alter table sites add column hub_urls_json text not null default '{}';
alter table sites add column seo_identity_json text not null default '{}';

alter table jobs add column content_updated_at text;
