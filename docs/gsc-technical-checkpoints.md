# Public Blog SEO / GEO Output Contract

This document describes the actual guarantees, configuration conditions, and acceptance criteria of the shared rendering pipeline, without treating "tags are present" as proof of indexation.

## Pages and Metadata

- Articles, lists, body links, tables, and images are output in server-side HTML and can be read without JavaScript.
- Page templates provide H1, main, article, navigation, and footer; article bodies support H2–H6, with H1 in legacy content rendered as H2. Sections generate stable, deduplicated Unicode anchors.
- Markdown supports paragraphs, nested lists, fenced code, dividers, tables, blockquotes, links, emphasis, and absolute HTTP(S) images. Raw HTML is escaped for display and not executed; unsafe link schemes are not output as clickable links. This is not a complete CommonMark implementation, so arbitrary extensions must not be assumed to work.
- `ArticleVersion.meta_description` is an independent search and share description; when empty, it falls back to the first paragraph of the excerpt, and then to the title. It is never scored by character count, forcefully truncated, or synthesized into a fake summary. The visible summary preserves the full excerpt.
- `image_url` / `image_alt` are the optional article cover and alt text, and the cover also appears in the body. Share image priority: article cover → first valid body image → site defaultOgImage. The image field is omitted when no trusted image is configured.
- List pages use the site's defaultOgImage. Article images are used synchronously for OG, Twitter, and BlogPosting; image dimensions are not fabricated.
- title, description, canonical, and OG URL point to the same page; the Twitter description matches the search description.
- OG locale is resolved using BCP-47 language and region (falling back to Intl likely-subtags when the region is missing), separate from HTML lang / hreflang; invalid codes do not generate an OG locale.
- BlogPosting, BreadcrumbList, CollectionPage, and Organization use real article and site information. Ratings, FAQs, author bios, or citation evidence are not automatically fabricated. The CollectionPage URL of list pagination matches the canonical of the current page.
- The publishing pipeline preserves existing published_at; datePublished and article:published_time use it, while the content modification date is expressed independently and never precedes initial publication.

## Configuration Saving

Site SEO configuration distinguishes unsubmitted fields from empty strings: unsubmitted fields are preserved, while empty strings clear explicit configurations (fields such as brand name can still fall back to the site name). Configuration objects are parsed by known fields; image and organization URLs must be absolute HTTP(S) URLs upon saving. Historical relative image configurations can be resolved based on product_origin, and invalid protocols are excluded from the output.

Article metadata is preserved across Agent tool schemas, version JSON, review contexts, public article read tools, the import API, the edit API, and edit forms. Legacy articles do not require backfilling new fields.

## URLs, Languages, and Crawling

- Production subdomains use their own canonical; preview content includes noindex, avoiding publishing previews as production sites.
- Only real language versions of the same Job form the hreflang set. The set shares the same source and x-default across HTML and sitemap. Independent articles in different language markets are not automatically linked just because their topics are similar.
- The root path may return 307 based on language and saved preferences, declaring Vary and private/no-store; explicit language URLs remain stable.
- Hidden, unpublished, and nonexistent articles do not enter the sitemap; out-of-bounds pagination returns 404, and empty language lists are noindex.
- Historical slugs are stored in jobs.url_aliases_json; modified old addresses directly 301 redirect to the current version in the same language. Historical addresses of hidden/unpublished articles remain inaccessible. If no corresponding language version exists, 404 is returned.
- Database triggers prevent other articles from occupying current or historical slugs within the same site and language, covering edits, imports, and direct lifecycle writes. Different sites and different languages can use the same slug.
- A SHA-256 ETag is generated for full response content; 304 is returned only when matching If-None-Match. When a legacy If-Modified-Since arrives alone, a full response is returned because article timestamps cannot cover changes in templates, configurations, and dynamic links. HEAD has no body.
- The site robots.txt allows crawling by default and declares the sitemap. Cloudflare-managed robots and firewalls serve as external control planes and require inspecting final production responses; training crawler policies are not modified this time.
- sitemap / RSS / canonical use the same set of URL generation functions as published versions. RSS contains the latest 50 published language versions.

## Boundary Between Agent and Deterministic Rules

This categorization addresses inconsistencies in presentation capabilities and output contracts, rather than a model quality judgment failure in a particular run. Legacy generation prompts and submit_article descriptions prohibited images, citations, and tables; QA likewise rejected them, yet the renderer already supported tables. Capability descriptions are now unified, and model call boundary tests check the descriptions received by the model and the preservation of returned fields. Mock model tests are not framed as production model canaries.

Topic selection, body text, evidence sufficiency, need for images or tables, excerpt phrasing, and internal link choices remain within model judgment; the existing submit / revise / defer loop and human publication approval remain unchanged.

Deterministic rules are solely responsible for: safe protocols and HTML escaping, HTML-supported heading depth and fenced code structures, URL identity and historical ownership, site/language isolation, configuration field types, and cache consistency. Images are not mandatory; subjective SEO thresholds for word count, keyword density, citation count, or quality scores are not added. Agent capability descriptions come from shared/article-presentation.ts, allowing future format or model prompt extensions without modifying shared Runtime scheduling.

## Local Acceptance and Launch Boundaries

- `npm test`: covers legacy behavior regression, cross-layer metadata preservation, configuration clearing, full-response caching, images/tables/quotes/anchors, historical addresses, hidden protection, as well as real SQLite full migrations and address conflict tests.
- `npm run build`: frontend/backend type checking and bundling, plus sensitive value inspection of production artifacts.
- `worker/blog/presentation.test.ts` and `worker/blog/url-history.test.ts` are newly added contract and persistence regressions.
- `0041_article_url_history.sql` must be applied before deploying the Worker. Migrations record only URL changes that occur afterward and cannot restore slugs lost in the past; legacy articles will not be rewritten.
- Post-launch verification must also include real-domain HTTP/HTML, robots, sitemap, share image accessibility, and Search Console URL inspections. A single 200, successful sitemap submission, or site: search does not prove indexing.

Google imposes no special schema or AI text file requirements for AI Overviews / AI Mode. The GEO improvements here consist of crawlable body text, clear structure, citeable anchors, real images, and consistent structured information, offering no guarantees of indexing, ranking, or AI citations.

References: [Google AI features](https://developers.google.com/search/docs/appearance/ai-features), [Article structured data](https://developers.google.com/search/docs/appearance/structured-data/article), [Open Graph](https://ogp.me/).
