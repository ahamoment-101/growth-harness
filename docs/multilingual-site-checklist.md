# Multilingual site deployment checklist

This checklist applies to your own site. It contains no customer deployment state and does not assert indexing or ranking success.

## Business facts and rendered pages

- Confirm the site's actual product name, description, supported features and canonical origin. Do not reuse another business's pricing, promises, testimonials or installation claims.
- Read the final server-rendered HTML without JavaScript. Article body, title, headings, navigation and real links should be present.
- Use real published versions for each locale. Do not advertise empty language pages or declare translations that do not exist.
- Inspect error, empty, hidden and unpublished states; successful rendering of one article does not validate them all.

## URL and crawler behavior

- Verify each language URL's HTML `lang`, canonical, hreflang and `x-default` against actual saved versions. See [multilingual URL policy](multilingual-seo-strategy.md).
- Inspect custom-domain DNS and Worker routing on the deployed installation. A working preview URL does not prove the custom domain is connected.
- Read the final public `robots.txt` and sitemap, including Cloudflare-managed output and firewall behavior. Application templates are not the only control plane.
- Check published article inclusion, hidden/unpublished exclusion, historical redirects, 404s and sitemap URL origins.
- Test share images and article assets at their actual public URLs. Do not publish invented image dimensions or structured-data properties.
- Test ETags and conditional responses at the final served edge, rather than assuming local behavior survives every cache layer.

## Search services and evidence

Connect the deployer's own GSC application and verified property only if using Search Console features. Record authorization, property verification and sitemap submission separately. A 200 response, accepted sitemap or presence of markup does not prove indexing, rankings or AI citation.

A root-domain main site and a blog subdomain can link through real relevant pages. The application does not require a particular CMS or main-site repository. Optional export must follow the receiver's [Webhook contract](ingest-contract.md), without customer-specific required languages or authentication values in public documentation.

## Acceptance record

Record the tested source version, deployment target, configured capabilities, exact actions and observed results privately. Public reports may describe methods and aggregate limitations using synthetic examples. Keep production account/resource IDs, internal site/task references, cookies, raw conversations and customer material outside the release.
