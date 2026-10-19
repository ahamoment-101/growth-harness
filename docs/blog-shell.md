# Blog shell (Header / Footer)

The Blog's public pages render our own fixed shell rather than copying the client's main-site navigation and footer.

## Structure

- **Header**: the brand (client logo + site name, linking to the client's main-site homepage) and the language entry sit in the same `.wrap` container, aligned to both ends with flex `space-between`—not two overlapping floating layers. There are no other navigation items and no CTA.
- **The shell is wider than the body**: `.site-head .wrap` / `.site-foot .wrap` are `80rem`, while the body column (`body.layout-magazine main.wrap`) is `72rem`, meaning the shell extends `4rem` beyond the body on each side—it frames the body rather than shrinking inside it. This relationship is locked by a test case in `render.test.ts` (comparing the two `max-width` values rather than hardcoding numbers)—when changing the body width, the shell width must be checked at the same time.
- **Footer**: copyright, an internal link back to the Blog index with labels localized by `locale` (for example, `All posts` in English or its Chinese equivalent), and a localized `Home` link to the customer's main site, pointing to the same target as the Header brand link. The Header's only link leads out of the Blog, so the internal link back to the Blog index must be in the Footer to keep article pages from becoming isolated. This internal link must remain; `Home` is an additional exit for visitors who want to leave the Blog.
- The former `RSS` / `Sitemap` links have been removed: the `/feed.xml` and `/sitemap.xml` endpoints themselves are unaffected; they are simply no longer shown in the footer—most visitors don't use them, and they were previously hardcoded in English and did not switch with `locale`.
- The localization table for Footer copy is maintained by `FOOTER_LABELS` in `render.ts` (keyed by BCP-47 base language, falling back to English for uncovered languages); adding a language only requires adding a row to this table, with no change to rendering logic.
- Desktop and mobile share the same HTML: `.site-head .wrap` defaults to a single-row flex with both ends aligned, and below the 640px breakpoint it switches to `flex-direction: column` so the language entry drops below the brand; these rules are all in `render.ts`, while `locale-switcher.ts` only handles the styles of the language entry itself (trigger button + dropdown panel).

## Value sources

| Element | Source | When missing |
|------|------|--------|
| logo | `brandIconHrefOf()`: `seo_identity.logoUrl` (filled in the console's "Site Settings") → Google favicon query against the client's root domain | Only renders the site name when the site has no domain at all |
| Site name | `siteNameForLocale(site, locale)` | `site.name` |
| Main-site link (Header brand / Footer `Home`) | `seo_identity.organizationUrl` → `product_origin` → `https://<root_domain>` | The brand is no longer a link, just text; the Footer does not render `Home` |
| Copyright Name | `organizationNameForLocale(site, locale)` | `site.name` |
| Footer Copy | `FOOTER_LABELS[base language of locale]` | Falls back to `FOOTER_LABELS.en` |

Every field of the shell comes from the site's existing configuration, requiring no changes on the customer's own site and no browser rendering or scraping.

## Why We No Longer Clone Main Site Navigation

The earlier BrandShell used Browser Rendering to traverse the Header/Footer DOM of the customer's main site, capturing snapshots of safe nodes, public attributes, and computed styles to re-render on Blog pages. It was removed entirely for structural reasons rather than implementation quality:

- **Snapshots support only a single language.** The scan entry point was fixed to `https://<root_domain>/`, and the entire site shared a single snapshot, resulting in `/pt/blog` displaying navigation in the main site's default language.
- **Adding a locale dimension still does not solve it.** Our Blog language set is inherently broader than the customer's main site language set—the customer's main site might only be in English while the Blog produces ten languages, which is precisely the value proposition of this product. Languages that do not exist on the main site can never be scraped.
- The remaining costs are ongoing: Browser Run capacity throttling and backoff, DOM/CSS/SVG allowlists, structural fingerprinting, and version rollbacks, all for a goal we cannot fundamentally achieve.

The true leverage for making the Blog "belong to the main site" lies not in shell fidelity, but at the domain level: mounting the Blog under the `customer-domain/blog/*` path to share domain authority; see `docs/multilingual-seo-strategy.md`.

## Removal Scope

`worker/blog/brand-shell.ts`, `brand-shell-dom.ts`, `worker/workflows/brand-shell.ts`, the three `/api/sites/:siteId/brand-shell*` routes, `BROWSER` and `BRAND_SHELL_WORKFLOW` bindings, and the "Sync Main Site Navigation & Footer" dashboard panel are all removed together. `locale-switcher.ts` only retains rendering for the Blog's own language entry points.

The three tables `brand_shell_settings` / `brand_shell_versions` / `brand_shell_sync_runs` are retained in the database following the migration additive convention, with no remaining readers or writers.

**Release Impact:** `0031_brand_shell_always_on.sql` previously set all sites to enabled, so live published pages currently mount the scraped shell. Switching to the native shell is a user-visible redesign for all customers, not a silent change.
