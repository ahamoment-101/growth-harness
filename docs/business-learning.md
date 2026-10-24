# Business learning

GrowthHarness keeps site-owned business experience across Leader tasks. It records what a practice intended, what happened, and whether using its lessons later was useful. It does not train model weights, learn tool-call sequences, or promise growth.

## Intent / Experience / Utility

| Object | Meaning | Authorship |
| --- | --- | --- |
| Intent | Goal, conditions and expected result | The internal Learning Agent derives it from the Leader's assignment and supplied business facts. |
| Experience | Pre-action hypothesis and evaluation agreement, approach, adjustments, delivered work, evidence, measured result and latest understanding | The Learning Agent prepares, records and evaluates formal business evidence through the existing Runtime. |
| Utility | An estimate of later-use value, valid feedback count and update-rule version | Code calculates it from eligible outcome feedback; unknown is `null`, not zero. |

There is no developer-created hypothesis template or predefinition. The hypothesis belongs to an experience. D1 owns records, revisions, evidence, operation receipts, observed versions, adoptions and feedback. Workspace and site scope determine access; a record is not owned exclusively by its contributing Agent.

The Growth Leader is the business-facing coordinator. It prepares a practice before consequential action, finds and reads history, explicitly records adopted lessons, delegates ordinary business briefs to specialists, and records formal deliverables and adjustments. Specialists do not need to understand the learning protocol. Delegated work carries a host-bound practice reference for attribution, without exposing child internal conversations.

The internal Learning Agent has its own persistent Task/Run on the same Runtime. Its model is selected with `learning_agent` in the existing model registry. No independent service, SDK, model key scheme, or separate Agent execution framework is introduced. An independent SDK remains a possible future extraction, not this release's installation model.

## Lifecycle and ownership

1. `prepare_business_practice` captures the assignment and invokes learning preparation. The Agent defines a hypothesis and a prospective evaluation agreement from available facts. Missing goals or measurable sources remain explicit gaps.
2. `find_business_experience` searches by business intent; `list_business_experience` browses paginated history. The Leader reads the full record and evidence using `read_business_experience` and its page tool, then chooses whether it fits.
3. `adopt_business_experience` records the experience, observed version, reason and compatibility. A search result or read is never automatically an adoption. Multiple Agents contributing to one practice do not create independent outcome samples.
4. `record_business_practice` records the actual delivery and material changes. Publication is bound to actual saved job/version/URL/time receipts. Completed Leader tasks are not revived by late publication or outcome collection.
5. Scheduled observation work collects available outcomes and invokes evaluation. Subsequent tasks can recall the updated understanding. Unavailable data, incomplete coverage and delayed results stay distinguishable from zero performance.

Business judgment remains model-directed: relevance, hypothesis, applicability, evaluation meaning, conclusions, adoption, no suitable experience and unknown results. The shared Runtime owns execution authority, stable identities, persisted context, replay and recovery. The learning domain owns practice lifecycle and scoring contracts. Deterministic checks enforce tenant isolation, observed versions, atomic writes, idempotency, arithmetic and real-source constraints; they do not rank business strategies.

Learning preparation has a persisted limit of three attempts, including the first. Unknown submissions are reconciled before retry. Exhausting preparation availability lets business work continue with an explicit gap; later tasks still attempt learning. Feedback failures retain pending work. This policy does not change other Agents' recovery strategy.

Existing tasks retain pinned tool contracts. New Leader tasks use definition 21 and Learning Agent definition 2. Upgrading does not invent pre-action judgments for historical tasks.

## Evaluation and Utility

The Agent fixes the evaluation agreement before action, including objective, evidence basis, named inputs and units, constants, arithmetic steps or an evidence rubric, score meaning, missing-data conditions and a comparison key. Numeric execution is restricted arithmetic, not arbitrary code. Unsupported metrics cannot be inferred from available proxies: GSC clicks are not conversions.

**Reward** measures the current practice against that agreement. **Utility** estimates the value of an explicitly adopted historical experience in later compatible practices. A failed practice can produce a useful lesson; its later value is not its original reward.

Only explicit compatible uses receive valid feedback. The first valid reward initializes Utility; later feedback uses `U = U + 0.2 * (reward - U)` under `ema-0.2-v1`. Corrections replace the old contribution and replay the stable feedback order without increasing the sample count. Display score and feedback count together. Co-used experiences share attribution uncertainty: neither Utility nor similarity is a causal contribution or success probability.

The initial automated outcome source is Search Console: page-filtered clicks, impressions, CTR and position for the saved publication-relative window. The source, requested dates, collection time and coverage limitations are retained. Other goals can remain unevaluable. Connecting GSC does not establish that a change caused better performance.

## Semantic recall

D1 is authoritative. Vectorize stores a rebuildable search projection, not the sole copy of experience. Workers AI `@cf/baai/bge-m3` embeds goal, context, hypothesis, approach, adjustments, delivery, insight and limitations into 1024-dimensional vectors. Utility is hydrated from current D1 state and does not need re-embedding when its score changes.

A durable indexed outbox saves vector identity before writes, confirms visibility, retries temporary failures and retires old generations. Workspace/site namespaces and D1 hydration reject foreign or obsolete matches. Search returns bounded candidate cards with IDs, observed versions, similarity, current Utility and indexing coverage. Full evidence is read separately; truncation is explicit.

The model decides relevance after retrieval. There is no keyword gate, minimum Utility or similarity cutoff. Negative lessons and unknown-Utility records remain candidates. `top_k` is limited to 50 by the metadata-bearing Vectorize query response contract. A nearest neighbor is not proof of applicability; an empty or partial result is not proof that all history has been searched.

If bindings are missing, search reports `configuration_missing`; directory/read tools remain usable and indexing work remains durable. Provider outages report unavailability. Neither path silently substitutes keyword matching and calls it semantic search.

## Installation and upgrades

Normal `npm run setup -- --local` applies all migrations without a Cloudflare account. Local business learning uses your selected model credentials; semantic recall additionally requires real Cloudflare Workers AI and Vectorize access. Embedding and model usage can incur charges.

For an existing installation, back up D1 and apply migrations before deploying the new Worker:

- `0082_business_learning.sql`: practice records, evidence, adoptions, feedback and pending learning/observation work.
- `0083_leader_learning.sql`: Leader attribution and supporting links.
- `0084_learning_search.sql`: search projections, indexed outbox and revision triggers; existing learning records are queued for indexing.

These migrations add learning structures; they do not rewrite Agent conversations. Follow [self-hosting upgrade steps](self-hosting.md#upgrading-a-release) and retain your resource names. No new Workflow or Durable Object declaration is required.

To enable semantic recall, select your own Cloudflare account and create a **dedicated index per installation/environment**:

```sh
npx wrangler whoami
npx wrangler vectorize create growth-harness-learning --dimensions=1024 --metric=cosine
```

Add these top-level entries to your deployment `wrangler.jsonc` (adjust the index name to your resource):

```json
{
  "ai": { "binding": "AI", "remote": true },
  "vectorize": [{
    "binding": "LEARNING_VECTOR_INDEX",
    "index_name": "growth-harness-learning",
    "remote": true
  }]
}
```

`remote: true` means local development calls the real binding. Keep local/testing resources separate from production. Leave these entries absent for fully local, account-free startup; the default file contains commented examples. In production the bound resources are used regardless of the local development setting. No Cloudflare API token is needed by the production learning module itself.

The existing scheduled handler drains pending indexing and observation work. Index visibility is asynchronous. Read indexing coverage from search results; saved-but-pending records are not yet searchable. Keep the embedding profile, model and index dimensions aligned; changing the profile requires an explicit reindex migration.

## Console and verification

![Business Experience using synthetic local data](images/business-experience.png)

Open **File Cabinet → Business Experience**. List and detail show Intent, Experience and Utility together. Evidence, evaluation methods, adoption decisions and related tasks explain how a lesson changed later work. Unknown Utility stays unknown; there is no manual score input.

Run the local baseline checks:

```sh
npm test
npm run build
node scripts/verify-installation-local.mjs
node scripts/verify-learning-offline.mjs
```

The offline check uses real local D1/Worker and synthetic evidence, with external services disabled. It verifies authorized API readback, missing-binding behavior and idempotent receipt replay through storage. It is not real-model or semantic relevance evidence.

For a bounded real semantic/model check, configure `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Workers AI and Vectorize permissions), and selected model credentials in your local environment or `.dev.vars`:

```sh
VERIFY_REAL_RUNTIME=1 VERIFY_LEADER=1 node scripts/verify-learning-search.mjs
```

This creates an isolated test index, seeds explicitly synthetic records, checks multilingual expected matches, stale-generation filtering, tenant isolation, Utility hydration, actual Leader adoption/rejection and recall of a newly generated practice. It attempts to delete the temporary index when finished, including on test failure. If cleanup cannot be confirmed, it retains the index receipt and reports its name for manual reconciliation. `KEEP_LEARNING_INDEX=1` retains it for debugging; remove it yourself afterward. Reusing retained state requires the same account. `LEARNING_STATE` selects an isolated local evidence directory; `LEARNING_ENV_FILE` selects an alternative environment file. No credentials are written to reports.

For a manual browser sandbox with synthetic GSC responses, run `VERIFY_REAL_RUNTIME=1 node scripts/verify-learning-local.mjs` after building. Open the printed loopback-only fixture login URL. It uses real selected models, isolated local persistence, and synthetic business documents. Start a Leader practice from the UI. Its fixture endpoints are never included in the deployed Worker. Stop it with Ctrl+C. This sandbox does not provide semantic bindings; use the semantic check above for vector acceptance.

See [acceptance scope](business-learning-acceptance.md) for the tested revision and evidence boundaries. Functional correctness, semantic relevance, changed decisions and measured business improvement are distinct claims. Real growth requires actual publication, matured outcome data and a defensible comparison; a synthetic fixture or increasing Utility is insufficient.
