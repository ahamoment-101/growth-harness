-- Project is identified by the customer website (example.com).
-- sites.domain remains the programmatic SEO host (blog.example.com).

alter table sites add column root_domain text not null default '';
