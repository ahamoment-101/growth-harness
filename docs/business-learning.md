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
3. For delegated work, `delegate_task.experience_uses` records the selected full-read references, observed versions, reasons and applicability with the assignment before dispatch. Pass an empty list when no lesson applies. `adopt_business_experience` remains available for decisions outside delegation. A search result or read is never automatically an adoption. Multiple assignments in one practice do not create independent outcome samples.
4. `record_business_practice` records actual delivery, material changes and exact supporting receipts. Topic submission atomically saves the real group/item identities and immutable delivered version/content. Publication is bound to actual saved job/version/URL/time receipts. Completed Leader tasks are not revived by late publication or outcome collection.
5. The Leader reads the frozen agreement with `read_business_evaluation`, arranges authorized evidence collection, and uses `submit_business_outcome` to submit formal evidence for assessment. It does not supply a reward or utility score. Scheduled observation continues to own automatic GSC outcomes. The Learning Agent checks evidence support and the frozen reviewer/source requirements; missing evidence stays unknown. Subsequent tasks can recall the updated understanding.

Business judgment remains model-directed: relevance, hypothesis, applicability, evaluation meaning, conclusions, adoption, no suitable experience and unknown results. The shared Runtime owns execution authority, stable identities, persisted context, replay and recovery. The learning domain owns practice lifecycle and scoring contracts. Deterministic checks enforce tenant isolation, observed versions, atomic writes, idempotency, arithmetic and real-source constraints; they do not rank business strategies.

Learning preparation has a persisted limit of three attempts, including the first. Unknown submissions are reconciled before retry. Exhausting preparation availability lets business work continue with an explicit gap; later tasks still attempt learning. Feedback failures retain pending work. This policy does not change other Agents' recovery strategy.

Existing tasks retain pinned tool contracts. New tasks use Leader definition 25, Learning Agent definition 6 and Topic definition 30. Upgrading does not invent pre-action judgments for historical tasks.

## Evaluation and Utility

The Agent fixes the evaluation agreement before action, including objective, evidence basis, named inputs and units, constants, arithmetic steps or an evidence rubric, score meaning, missing-data conditions, a comparison key, and an executable evidence plan (source, collector and readiness condition). Numeric execution is restricted arithmetic, not arbitrary code. Unsupported metrics cannot be inferred from available proxies: GSC clicks are not conversions.

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
- `0085_task_subjects.sql` and `0086_learning_attribution.sql`: nested-task object references and attributable learning evidence.

The delegated-adoption and formal-outcome update requires no additional migration, secret or binding beyond these existing learning prerequisites.

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

See [learning verification and known limits](verification.md#business-learning) for evidence boundaries and reproducible checks. Functional correctness, semantic relevance, changed decisions and measured business improvement are distinct claims. Real growth requires actual publication, matured outcome data and a defensible comparison; a synthetic fixture or increasing Utility is insufficient.

## Attribution and replay

Idempotency answers whether an effect already happened. Attribution answers which practice, object and version it concerns. A practice can contain several objects; a persistent Task can receive successive assignments. One retry key cannot replace these relationships.

The saved delegation selects the practice before dispatch. Runtime copies that relationship through descendant Task creation, carries opaque subject references and captures parent/assignment identity. Domain tools supply real `{ type, id, version }` references. A child without explicit object subjects inherits its parent's saved subjects, not its conversation. An author has no output artifact version until formal delivery. Empty subjects mean unknown attribution.

Task reports capture immutable assignment/subject snapshots. Later reassignment cannot rewrite them. Publication references come from real job/artifact relations; a delivery can establish an artifact version only for the actual associated job. Historical migration backfill uses saved structured references, never guessed versions or inferred prose, and does not rewrite evaluations or Utility.

The Learning Agent submits a complete replacement set of evidence-grounded findings: scope (`object`, `practice`, `unknown`), subjects, kind (`adjustment`, `delivery`, `conclusion`, `limitation`), text and exact evidence references. Object claims must cite matching objects/versions. Practice judgments and uncertainty remain expressible. The display derives adjustments, delivery and conclusions from these findings; the Agent reconciles unsupported prior interpretations while preserving the frozen intent, hypothesis and evaluation.

Declared use in delegation has its own durable decision receipt. It binds the normalized assignment and selected full-read references before child dispatch. The practice revision, adoption set, delegation link and receipt commit atomically; a stale reference rolls back the set. An assignment outside learning also saves its empty decision so replay cannot add adoption later. Interrupted dispatch reconciles the same child under existing parent/child authority. A committed adoption remains a declared decision, with actual implementation and outcome still unproven.

## Outcome evidence

`read_business_evaluation` returns the exact frozen `evaluation_ref`. The Leader obtains evidence within the authorized scope and submits original receipts, available measurements, completeness and limitations through `submit_business_outcome`. A correction creates a new outcome receipt for the same practice; it does not add another feedback sample.

The Learning Agent checks the agreement's source, reviewer and completeness requirements. If external review is required, the review must actually exist; an author's artifact or coordinator's completeness flag cannot substitute for it. `outcome_supported=false` keeps reward unknown. Numeric execution follows the frozen calculation; qualitative judgment follows the agreed rubric. Manual submission cannot replace automatic GSC measurements or their observation window.

Topic delivery snapshots save generated group/item IDs, immutable submission version and submitted content in the same transaction as the decision. Other deliverable types retain their own evidence paths; do not assume all domains emit the topic snapshot format. Evidence membership, measurement slots/units, agreement versions and replay are validated mechanically. Whether a real receipt supports a natural-language claim remains a model judgment.

## Interpretation limits

A finding's valid references do not prove its reasoning correct. Implemented revisions may be recorded as conclusions rather than separate adjustments; an empty adjustment field means no separately recorded adjustments, not that no business changes happened. Explicit semantic feedback can help the Agent reclassify evidence, but default autonomous classification is not established as reliable across models.

A declared adoption does not prove specialist implementation. A rubric reward establishes only that rubric's objective; it is not search performance. Utility from one compatible later practice is one sample with attribution uncertainty. Real growth needs actual external observations and a defensible comparison. See [Verification](verification.md#business-learning).
