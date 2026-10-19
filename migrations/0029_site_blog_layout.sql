-- Blog page layout template chosen in console "Page Settings"; rendered by worker/blog.
alter table sites add column blog_layout text not null default 'classic';
