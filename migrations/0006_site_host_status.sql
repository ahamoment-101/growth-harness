-- Persist the last real DNS / TLS / HTTP check for a customer hostname.

alter table sites add column domain_status text not null default 'unverified';
alter table sites add column domain_error text not null default '';
alter table sites add column domain_checked_at text not null default '';

create unique index if not exists sites_domain_unique
  on sites (domain)
  where domain != '';
