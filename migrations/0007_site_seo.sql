-- Public blog SEO identity. Locale URL policy is per site, not a global tenant.
-- Empty locale_policy_json means derive prefixes from translate_locales_json.

alter table sites add column product_origin text not null default '';
alter table sites add column locale_policy_json text not null default '';
