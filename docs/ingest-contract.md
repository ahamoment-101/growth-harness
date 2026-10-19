# Optional Webhook export

Hosted article publication does not require a customer CMS or Webhook. After existing publication approval, the Publish Workflow makes the article live in GrowthHarness, then optionally exports the saved versions to the site's configured endpoint.

## Configuration and request

Configure an `ingest_url`, `secret_header`, `ingest_secret` and at least one mapped field for the site. Export is enabled only when the URL and field mapping are present. The Worker sends `POST {ingest_url}` with JSON and the configured secret header, defaulting to `x-ingest-secret`.

A mapping selects a saved source value for each destination key. Mapping `article` from `languages`, for example, produces:

```json
{
  "article": {
    "content_id": "example-article",
    "languages": [
      {
        "code": "en",
        "slug": "example-article",
        "title": "Example article",
        "excerpt": "An illustrative summary.",
        "content": "Saved Markdown body."
      },
      {
        "code": "fr",
        "slug": "article-exemple",
        "title": "Article exemple",
        "excerpt": "Un resume illustratif.",
        "content": "Corps Markdown enregistre."
      }
    ]
  }
}
```

These are synthetic values. Actual locales and versions come from the job; the source locale need not be English, and no specific second language is required. `content_id` uses the saved translation group, falling back to a saved slug or job identity. Primitive fields such as title, slug and content use the source version. Literal mappings are also supported; see `worker/lib/webhook.ts` for the authoritative mapping vocabulary.

The connectivity test adds `dry_run: true` unless already mapped. The receiver should validate authentication and payload, return a successful response and perform no write for a dry run. A live request contains `dry_run` only when the site's mapping supplies it.

## Outcomes and receiver responsibilities

A successful HTTP response records an export reply. Non-2xx responses and network failures are recorded on the published job; they do not roll back the already-hosted article. An unconfigured export is skipped. Inspect saved `error` and `publish_response` alongside article status rather than treating `published` alone as proof of external delivery.

The receiver owns storage, rendering, cache invalidation and any stricter content requirements. Use the stable content identity to handle replay safely. An ambiguous network result is not proof that the receiver did nothing; reconcile external effects before manually repeating a publish operation. Do not assume another CMS's authentication headers, required locales or response semantics.

Secrets are site-specific configuration and must never appear in public examples, model context, issue reports or source control. See [configuration](configuration.md) and [publication verification](verification.md).
