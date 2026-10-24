# Supplementary task facts and nested emphasis

Implementation review, 2026-10-24. This change adds a missing Agent action and repairs the article renderer. It does not change learning judgments, publish content, deploy a Worker or migrate a database.

## Evidence and scope

An existing acceptance record showed a parent obtaining a factual answer while its content child remained waiting for the same information. Answering a second form created by the parent resumed only the parent; answering the original child form resumed that child. Task-local form ownership was correct. The missing capability was a model-selectable action for supplying sourced facts to the original waiting child. Tool-contract inspection confirmed that gap. This implementation does not claim new production provider-transport evidence from that historical record.

Learning observations did not establish a separate systemic failure: a retrieved lesson described as optional was not necessarily adopted; a later Agent did record adoption and repaired an observed-version conflict. No forced adoption, keyword filter, frozen-evaluation rewrite or case-specific learning rule was added.

Nested star emphasis failed because independent bold/italic replacements could consume each other's delimiters. That is an objective renderer defect, independent of the quality of the generated prose.

## Ownership and behavior

- **Leader domain:** `read_task` exposes a direct child's original pending questions and, for a supported waiting contract, an observed `input_ref`. Leader chooses whether to call `provide_task_facts` with facts and their reported sources. It can still investigate, defer, or refer the user to the existing form. It cannot broadcast inputs through descendants or substitute a new assignment.
- **Receiving Agent:** `read_human_input_requests` reads its own pending questions. `resolve_human_input_request` can explicitly withdraw an obsolete question or `keep_waiting` on the same question. New facts are not a human answer or approval. Evidence sufficiency and whether to continue remain model judgments.
- **Shared Runtime:** the existing execution handoff accepts an optional waiting input. Input and successor execution commit in one fenced batch against the observed Task/Run, revision and execution. Parent authority is retained; the child runs under its independently persisted authority. No new Task or Run is created. Replay reuses the exact input and original successor, even after the child reaches another wait. Unknown child effects still require reconciliation.
- **Shared interaction protocol:** a human answer can claim the exact pending question only while the task is waiting. An already claimed answer is preserved and blocks a competing parent input. A rejected new claim records no answer. Child withdrawal atomically saves its decision receipt with request resolution; it never creates a human-response row. Keeping a question uses the existing Runtime waiting checkpoint.
- **Renderer:** star delimiter matching handles nested emphasis, Unicode punctuation and escaped/unmatched markers, including link labels. Code spans, HTML escaping, URL validation and link rewriting retain their existing boundaries. This is not a replacement Markdown engine or a claim of complete CommonMark support.

Deterministic checks protect identity, scope, observed versions, atomicity, operation replay, existing input capacity and actual rendering syntax. They do not prescribe a business answer, select evidence, choose a task to retry or score a lesson. The same mechanics apply to different child Agent definitions. Mission, evidence policy and completion decisions can evolve through definitions, prompts and semantic tools without changing the Runtime handoff.

## Compatibility

New tool contracts are gated by persisted definition versions: Leader 22, business research 8, strategy research 45, keyword research 11, topic decision 29, content production 28, article production 26 and content review 18. Older conversations retain their manifests and instructions. Leader does not offer supplementary-input references for legacy contracts or external-job Agents without the receiving capability. There is no automatic migration of live tasks.

## Verification

Focused tests use actual execution-scoped parent credentials, the real child start service, separate child identities, D1-compatible SQLite transactions and the ordinary Runtime conversation pipeline. They cover:

- same Task/Run continuation, unchanged conversation prefix and exactly one appended input;
- lost commit and dispatch responses, replay after a later wait, stale parent authority, changed child state and unknown effects;
- concurrent successors sharing an epoch: a failed input cannot claim the winner's receipt or rewrite its run state;
- human-answer-first and parent-facts-first races, including a change between form validation and atomic claim;
- child withdrawal versus continued waiting, original form preservation, no fabricated human response, pagination and legacy tool contracts;
- nested emphasis in text, links, tables and article rendering, with escaped code, unsafe links and HTML handling retained.

The pipeline scenarios use controlled model responses and simulated Workflow transport. They establish execution and recovery behavior, not the quality or frequency of real-model decisions. No new real-model, production or growth-effect acceptance is claimed.

Full-suite results for this change:

| Check | Result |
| --- | --- |
| Public core unit suite | 1,269 passed; 18 skipped |
| Private distribution unit suite | 1,282 passed; 24 skipped |
| TypeScript and production builds | Passed in both checkouts; existing large-chunk warning remains |
| Synchronization tests | 3 passed; shared-core comparison reports zero differences |
| Public source and build-artifact boundary checks | Passed |
| Build secret scans and diff whitespace checks | Passed in both checkouts |

Shared changes originated in the public core and were synchronized to the private distribution. No dependencies, deployment bindings, schema migrations or private adapters changed. No commit, push, deployment or live business action was performed as part of this implementation.
