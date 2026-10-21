# Multilingual SEO Strategy

> This document records the technical decisions and implementation standards of GrowthHarness for multilingual content production, for reference in future iterations and onboarding of new tenants.

---

## Background and Core Principles

GrowthHarness is a self-hosted content workspace: the owner can point a subdomain CNAME at their deployment to serve crawlable blog HTML. Each site can produce articles in multiple languages, letting Google index and rank the different language versions as **independent SEO pages**.

**Core principle: share one domain authority; do not use subdomains or different top-level domains.**

```
blog.customer-domain/
├── en/blog/
├── pt-BR → /pt/blog/
└── zh-CN → /zh/blog/
```

Not:
- `en.blog.customer-domain` (subdomains split domain authority)
- `blog.customer-domain.br` (different top-level domains are harder to build up)

---

## 1. URL Structure

### Each language version is a separate URL

Three versions of the same content:

```
/en/blog/how-to-read-english-without-translating
/pt/blog/como-ler-em-ingles-sem-traduzir
/zh/blog/ruhe-yuedu-yingwen-bujie
```

What Google sees is **3 HTML pages, 3 URLs**, not one URL that dynamically returns different content based on browser language.

Google has stated explicitly that locale-adaptive pages (returning different languages based on IP/Cookie/Accept-Language) may prevent some language versions from being fully crawled.

### URL prefix separated from BCP-47 code

| BCP-47 locale code | URL prefix (in the slug) | hreflang value (in the head) |
|--------------------|----------------------|----------------------|
| `pt-BR`            | `/pt/`               | `pt-BR`              |
| `zh-CN`            | `/zh/`               | `zh-CN`              |
| `en-US`            | `/en/`               | `en-US`              |
| `en-GB`            | `/en-gb/`            | `en-GB`              |

**Once a prefix is published, it must not be changed casually.** When a prefix must be changed, a 301 redirect history must be written into the system (`locale_policy.redirects`), and 301s must be served externally.

---

## 2. hreflang

### Rule: reference each other, include self, and add x-default at the end

All existing language versions of the same content must declare each other in their respective `<head>`:

```html
<!-- The PT-BR page's <head> -->
<link rel="alternate" hreflang="pt-BR" href="https://blog.example.com/pt/blog/como-ler-em-ingles-sem-traduzir">
<link rel="alternate" hreflang="en"    href="https://blog.example.com/en/blog/how-to-read-english-without-translating">
<link rel="alternate" hreflang="x-default" href="https://blog.example.com/pt/blog">
```

The English page carries **exactly the same set**, except the canonical points to itself.

**x-default** points to the default language's listing page (usually the listing URL corresponding to the site-configured `defaultCode`), telling Google which page to use when there is no language match.

### Only declare versions that actually exist

If an article only has a PT-BR version, the `hreflang` should only list `pt-BR`, without faking English or Chinese hreflang entries.

```html
<!-- Article with only a PT-BR version -->
<link rel="alternate" hreflang="pt-BR" href="...">
<link rel="alternate" hreflang="x-default" href="...">
```

This means you can do large-scale PT-BR SEO independently, without needing to produce English content in sync.

### Implementation location

`worker/blog/seo.ts` → `hreflangAlternates(pages, defaultCode, selfHref)`

The incoming `pages` are the language versions that actually exist for the current article/listing page; the function automatically adds `x-default`.

`selfHref` is the current page's own canonical. **The cluster must include the current page itself**, otherwise the function returns an empty array and this page simply outputs no hreflang. This is because Google drops an entire cluster that lacks a self-reference — it is better for this page to have no hreflang than for it to drag down the relationships of the other languages too. Paginated listing pages (`/pt/blog/page/2`) are exactly what relies on this guard to automatically omit hreflang.

---

## III. Canonical

### Each language version is self-canonical, never pointing to English

```html
<!-- PT-BR page -->
<link rel="canonical" href="https://blog.example.com/pt/blog/como-ler-em-ingles-sem-traduzir">

<!-- EN page -->
<link rel="canonical" href="https://blog.example.com/en/blog/how-to-read-english-without-translating">
```

**This must never be done:**

```html
<!-- ❌ Wrong: PT-BR pointing to EN -->
PT-BR page: <link rel="canonical" href="...en/blog/...">
```

This effectively tells Google: "the Portuguese page is not the primary page to index — the English one is." This will prevent the PT-BR version from ranking independently.

### The relationship between hreflang and canonical

- `canonical`: declares that this URL is the canonical address of the content
- `hreflang`: declares the relationships between different language/region versions

Each serves its own purpose; they coexist without conflict.

---

## IV. `<html lang>`

```html
<html lang="pt-BR">   <!-- PT-BR page -->
<html lang="en">      <!-- EN page -->
<html lang="zh-CN">   <!-- ZH-CN page -->
```

Note: Google Search does not primarily rely on the `lang` attribute to determine a page's language; it mainly determines it from the **actual text content**.

Therefore:
- The Title, H1, and body framework of PT-BR SEO pages must be primarily in Portuguese
- It is perfectly reasonable for English to appear on PT-BR pages as learning material/examples when those examples are relevant to the actual product and audience)
- You cannot put English content with `lang="pt-BR"` and expect Portuguese rankings

---

## V. Not all articles are required to have all language versions

A site may have an uneven language distribution:

```
EN: 120 articles
PT-BR: 500 articles
ZH-CN: 60 articles
```

Each article's hreflang only declares the language versions that **actually exist**. Versions that do not exist are not written, and no placeholder pages are added.

---

## VI. Sitemap strategy

### Declare hreflang redundantly in the sitemap

Google supports declaring language relationships in the sitemap with `xhtml:link`, which is redundant with `<link rel="alternate">` in the `<head>` and reinforces crawling:

```xml
<url>
  <loc>https://blog.example.com/pt/blog/como-ler-em-ingles-sem-traduzir</loc>
  <lastmod>2026-08-18</lastmod>
  <xhtml:link rel="alternate" hreflang="pt-BR"
    href="https://blog.example.com/pt/blog/como-ler-em-ingles-sem-traduzir"/>
  <xhtml:link rel="alternate" hreflang="en"
    href="https://blog.example.com/en/blog/how-to-read-english-without-translating"/>
  <xhtml:link rel="alternate" hreflang="x-default"
    href="https://blog.example.com/pt/blog"/>
</url>
```

### Sitemap sharding

When a single sitemap exceeds 50,000 URLs, it is automatically sharded; `/sitemap.xml` becomes a sitemap index, with the shards at `/sitemap-1.xml`, `/sitemap-2.xml`, etc.

### Use content_updated_at for lastmod

`<lastmod>` uses `jobs.content_updated_at`, not `jobs.updated_at`. The latter also updates on webhook failures and status changes, which would mislead Google into thinking the content changed.

The same timestamp is also used to answer conditional requests: article pages respond with `Last-Modified: content_updated_at`, and requests carrying `If-Modified-Since` with no updates are answered directly with a `304` and an empty body, without going through rendering again. The more sites hosted, the more this difference represents real crawl budget saved, rather than a nice-to-have for a single site. Implemented in `worker/blog/live.ts` → `notModifiedSince()` / `toHttpDate()`.

### Pagination page numbers have an upper bound

Requesting a page number beyond the real last page (e.g. `/en/blog/page/3` when there are 51 articles at 50 per page) returns a direct 404, and does not keep re-serving the last page's content with larger page numbers — that would be a URL space that can be crawled infinitely deeply; crawlers would keep thinking there are new pages to fetch when in fact it is all duplicate content. The upper bound is computed with `worker/blog/seo.ts` → `totalPages(count)` and intercepted at the routing layer in `worker/blog/live.ts`, never entering rendering.

### Only include page 1 listings

The sitemap only includes each language's page 1 listing and all article pages. Paginated listings (`/pt/blog/page/2`) are not in the sitemap; they are discovered via `rel="prev"` / `rel="next"` and pagination links between listing pages.

**But the paginated listings themselves remain indexable** — they only get self-canonical, with no `noindex`: Google ultimately treats `noindex` as `nofollow`; once pagination is noindexed, articles beyond the 51st lose all internal links and are left with only the sitemap as a discovery path. Paginated pages do not output hreflang (other languages have different article counts, so page 2 often has no corresponding page); this is automatically guaranteed by the self-reference guard in `hreflangAlternates`.

---

## VI-b. Preview domains must be isolated from production domains

The same article has two outlets: the customer domain (`https://blog.example.com/pt/blog/...`) and the internal preview path (`https://<worker>/live/<siteId>/pt/blog/...`). The content is identical word for word; **once a preview domain gets indexed it is competing for rankings against the customer's own site**. The more sites hosted, the greater this risk.

Therefore the preview surface is closed off at three layers simultaneously:

| Layer | Output |
|---|---|
| `robots.txt` | `User-agent: *` + `Disallow: /`, and no sitemap declared |
| HTML head | `<meta name="robots" content="noindex, follow">` |
| HTTP response headers | `X-Robots-Tag: noindex, follow` (on HTML, sitemap, and feed alike) |

Keeping `follow` is intentional: when a crawler lands on a preview page it should still follow links to the production domain rather than stop there.

The decision is made only once, in `decideIndexing(surface, page)` in `worker/blog/indexing.ts`; the surface takes precedence over the page's own judgment — on the preview surface, regardless of what the page itself is, the result is non-indexable. The rendering layer and routing layer are only responsible for executing.

---

## VI-c. Site identity: favicon and Organization consistency

Every hosted customer site must look like "this customer's own site" in search results, browser tabs, and AI summary cards, not like an unbranded default page.

**favicon**: prefer the scraped brand logo (`site.seo_identity_json.logoUrl`); if unavailable, fall back to Google's favicon query against the customer's real root domain (`https://www.google.com/s2/favicons?domain=<root_domain>`). **Never use our own icon** — it is better to borrow the icon from the customer's existing site than to show an unrelated default icon on the customer's brand domain. This fallback order is exactly identical to the console sidebar site icon (`src/components/Shell.tsx` `SiteIcon`); both are answering the same question: "what is this site's icon", and the answers must not differ.

**Organization/sameAs**: the article's `BlogPosting.publisher` and the `Organization` newly added on listing pages must be the same entity — same name, same logo, same `sameAs`. `sameAs` is taken from the social media links captured by the legacy brand shell (schemaVersion 1); the new DOM replica shell (schemaVersion 2) does not yet have this kind of classified data, in which case `sameAs` is simply omitted rather than fabricated.

Implementation locations: `worker/blog/render.ts` → `faviconHrefOf(site)` / `sameAsOf(brandShell)`; schema construction in `worker/blog/seo.ts` → `organizationJsonLd`.

---

## VII. Crawlable Language Switcher

The bottom of the page must have real cross-language links as `<a href>`, not just JavaScript switching.

```html
<!-- Rendered at the bottom of the article -->
<p class="langs">
  <a href="/pt/blog/como-ler-em-ingles-sem-traduzir" class="langs-cur">pt-BR</a>
  ·
  <a href="/en/blog/how-to-read-english-without-translating">en</a>
</p>
```

Reason:
1. Googlebot discovers URLs from real, parseable `href`s; JavaScript-rendered switchers cannot be guaranteed to be crawled
2. It forms an internal link network of `EN ↔ PT-BR ↔ ZH`, strengthening the association signals between language versions

Single-language articles (with no other translated versions) do not render the switcher.

---

## 8. Homepage and Language Selection

```
/ (domain root)
  ↓
307 (negotiated by Cookie preference / Accept-Language) to a language listing that has content (e.g. /en/blog)
```

When the site has no published content, show the trial page (noindex) and do not redirect.

**No IP-based forced language redirects**, to avoid Googlebot only seeing one language version and other languages failing to be adequately crawled. But the homepage implements an intentional **negotiated redirect** (`worker/blog/live.ts` → `localizedHomeRedirect`): it selects the target listing based on the language preference saved in the Cookie and Accept-Language, returning 307 + `Vary: Cookie, Accept-Language` + `Cache-Control: private, no-store`.

A 301 cannot be used here: 301s can be cached, which would pin the first visitor's negotiation result onto all subsequent visitors. The indexing cost of 307 is manageable — `/` is a pure redirect page with no content of its own, and Googlebot does not send Accept-Language, so it stably gets the default language listing every time and will not treat `/` as a separately indexed URL long-term. If real-world testing later shows that `/`'s signals do not consolidate into the listing page over the long term, consider abandoning negotiation and using a fixed 301 to the default language listing (at the cost of losing the preference-based per-visitor redirect).

---

## 9. Data Model

One piece of content corresponds to one `job`, whose `versions_json` stores all language versions:

```
job (translation_group = "como-ler-ingles")
├── version: locale=en,    slug=how-to-read-english-without-translating
├── version: locale=pt-BR, slug=como-ler-em-ingles-sem-traduzir
└── version: locale=zh-CN, slug=ruhe-yuedu-yingwen-bujie
```

The system automatically generates from this single record:
- An independent URL for each language version
- Mutually referencing hreflang
- self-canonical
- sitemap entries (including xhtml:link)
- The language switcher at the bottom of the article

**A single source of truth that automatically keeps all SEO signals in sync, avoiding hreflang mismatches.**

---

## 10. Slug Localization

URL slugs are recommended to be localized; they do not need to match the English slug:

```
/en/blog/how-to-read-english-without-translating
/pt/blog/como-ler-em-ingles-sem-traduzir   ← localized slug
```

Technically `/pt/blog/how-to-read-english-without-translating` can also be indexed, but localized slugs are better in terms of user experience, link semantics, and local keyword coverage.

---

## 11. Conventions for Adding a New Language

1. Add a new locale code in the site configuration (e.g. `es-MX`)
2. The system automatically assigns it a non-conflicting URL prefix (e.g. `/es/`)
3. Prefixes of existing articles **will not change**
4. Articles in the new language only appear in hreflang and the sitemap after production finishes and they are published

When changing an existing prefix (e.g. `/pt/` → `/br/`), the system records redirect history; old URLs 301 to the new URLs, and Google will complete the migration within crawl cycles.

---

## 12. Filling In Other Languages for Published Articles (Localized Rewriting)

Topic selection is isolated by language (each language market decides what to write on its own), but articles that have been written and passed human review can be reused in other languages.

- **Entry point**: in the content list, when a published article is missing some languages enabled on the site, show "Fill in other languages". Clicking it launches a separate background workflow (`LocalizeWorkflow`) for each missing language, without affecting each other; the page shows in-progress/failed statuses.
- **Generation**: using the original language version as the base draft, call the writing model once to do a localized rewrite (market phrasing, examples, search expressions) — not a word-for-word translation; it must not add new facts, sources, or product capabilities, and product names follow the official full names in the business information. If the check fails, give the specific problems back to the model to fix once; if it still fails, mark it as failed, do not publish it, and it can be re-initiated.
- **No more human review**: the original has already been human-reviewed; after the translation passes the machine check, it is attached directly to the same article and published, automatically forming mutual hreflang with the original. If something goes wrong, use "Take down this language" to take down only that language version, leaving the original unaffected; the taken-down URL is kept as a historical URL and will not be taken over by other articles.
- **Internal links**: in-site article links are stored as `article:<job_id>` and rendered according to the reader's language; when the target article has no version in that language, it displays as plain text, and once it is added later it automatically becomes a link, so translations do not need links rewritten. Before rewriting, the system first replaces hand-written blog URLs in the original with `article:` references (if no corresponding article is found, remove the link and keep the text), then requires that all links and image targets in the translation match the original one by one and in the same order. External source links remain unchanged.
- **Not doing**: bulk filling in; judging whether the target language already has a similar article (conflict detection); syncing translation updates after the original is modified.

---

## Key File Index

| Feature | File |
|------|------|
| Indexing contract (whether it can be indexed, robots directives) | `worker/blog/indexing.ts` |
| hreflang / canonical / sitemap generation | `worker/blog/seo.ts` |
| HTML rendering (including language switcher) | `worker/blog/render.ts` |
| Route matching and 301 handling | `worker/blog/live.ts` |
| Locale policy persistence | `worker/index.ts` → `persistSitePolicy()` |
| content_updated_at writing | `worker/lib/versions.ts` → `versionsPatch()` |
| DB migration | `migrations/0007_site_seo.sql`, `0008_seo_contract.sql` |
| Filling in languages for published articles (localized rewriting, link consistency, attach/take down) | `worker/lib/localize.ts`, `worker/workflows/localize.ts`, `migrations/0060_article_localizations.sql` |
