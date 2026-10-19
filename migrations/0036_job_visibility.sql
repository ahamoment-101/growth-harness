-- Independent show/hide toggle for published articles: lets a human unpublish
-- an article from the live blog (list, sitemap, feed, direct URL) without
-- re-running the content pipeline or losing the underlying content.
alter table jobs add column visibility text not null default 'visible';
