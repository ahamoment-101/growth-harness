# Real-time read models and caching

This document describes the console and public-blog read paths and their integrity requirements. It is not a production performance receipt. Verify the current implementation, actual resource use and deployed behavior before relying on a latency or cost estimate.

## Authoritative state and read models

D1 remains the authoritative business store. Runtime execution, permissions, version checks, operation receipts and recovery do not move into browser state or a read-model cache.

Business writes append site change records transactionally. A post-commit notification can wake the site's Durable Object to consume those changes, refresh affected rows and push an updated read model. Notification is a wake-up hint rather than an authoritative event payload: catch-up reads persistent change state so a missed wake does not silently lose a committed update.

```text
Authenticated API / Runtime / scheduled work
                    │ atomic write
                    ▼
             D1 state + site changes
                    │ post-commit wake
                    ▼
            SiteRoom read model
                    │ authenticated subscription
                    ▼
               Browser view
```

A viewer subscription does not grant mutation authority. Sending business input, approving and canceling continue through their authenticated action paths. The system must not use cached views to substitute newer versions for a version the Agent actually observed.

## Subscription and recovery

The browser subscribes only to permitted site topics. Snapshots and subsequent updates carry enough revision/generation information to reject stale state, recover a gap and replace an old connection's view. Reconnection, a replaced room, deployment, sleep and partial build failure must be recoverable from authoritative state.

Topics include team status, activity and Leader conversation views. Build and pagination boundaries are explicit. A display of the latest segment is not a claim that complete history has been loaded. Private child conversations are not projected into parent-facing business results.

A room maintains subscribed topics as well as newly changed rows. Following a code-version change or failed topic build, an existing connection must still receive a rebuilt snapshot; correctness cannot depend solely on every browser disconnecting during deployment.

Hibernation and platform lifecycle need verification in the actual deployed environment. A connected socket or local mock does not prove that an idle room is hibernating, that reads stopped, or that the chosen platform plan is suitable.

## Public blog path

Published article rendering, locale policy, canonical links, sitemap and conditional HTTP responses use the public rendering contracts. Cache identity must cover the full response representation, including configuration and template effects. A timestamp on the article alone is not sufficient invalidation evidence.

Cache reads never expose hidden, unpublished or cross-site content. Publication and edits must invalidate affected read representations without changing durable article identity or bypassing approval. Preview routes remain separated from production canonical URLs and indexing policy.

See [blog presentation](gsc-technical-checkpoints.md), [locale policy](multilingual-seo-strategy.md) and [blog shell](blog-shell.md).

## Required evaluation

Verify committed changes appear, duplicate notifications are harmless, missed notifications catch up, generation changes rebuild watched topics and stale updates cannot overwrite newer state. Exercise site authorization, cancellation, paginated conversation reads, deletion/hidden states, publication and replaced hosts.

Inspect actual browser DOM and network resources as well as API receipts. Measure D1 reads and room activity over an idle interval and after controlled updates, distinguishing local synthetic tests from deployed account metrics. Do not derive growth, scale or monthly cost claims from a diagram or one successful socket connection.
