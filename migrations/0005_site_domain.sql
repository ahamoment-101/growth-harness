-- Site is identified by the customer subdomain we will host.
-- ingest_url stays nullable-by-empty-string: webhook export is optional.

alter table sites add column domain text not null default '';
