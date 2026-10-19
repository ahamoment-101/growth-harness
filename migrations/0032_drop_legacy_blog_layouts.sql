-- classic list and timeline templates were removed; magazine is the only remaining layout.
update sites set blog_layout = 'magazine' where blog_layout != 'magazine';
