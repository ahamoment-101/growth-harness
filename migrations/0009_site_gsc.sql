-- Search Console (GSC) integration placeholders (per site)
-- This migration reserves fields for next-round OAuth + sitemap submission + property verification.

alter table sites add column gsc_oauth_status text not null default 'unconnected';
alter table sites add column gsc_google_account_email text not null default '';

-- URL-prefix property info (e.g. https://blog.example.com/)
alter table sites add column gsc_property_url_prefix text not null default '';
alter table sites add column gsc_property_verification_status text not null default 'unverified';
alter table sites add column gsc_property_verified_at text not null default '';

-- Next-round uses this token to inject <meta name="google-site-verification" ...> into hosted pages.
alter table sites add column gsc_verification_meta_token text not null default '';

-- Next-round uses these fields for sitemap submission attempts.
alter table sites add column gsc_sitemap_submit_status text not null default 'idle';
alter table sites add column gsc_sitemap_last_submit_at text not null default '';

-- Next-round stores encrypted OAuth refresh token (ciphertext only).
alter table sites add column gsc_refresh_token_cipher text not null default '';

