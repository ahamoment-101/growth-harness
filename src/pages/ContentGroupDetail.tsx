import { attendedPoll } from '../lib-polling';
import { useEffect, useState } from 'react';
import {
  api,
  formatDateTime,
  shortId,
  type ContentProductionGroupView,
  type ContentProductionItemView,
  type ContentReviewInteractionView,
  type Site,
} from '../api';
import { Shell } from '../components/Shell';
import { contentGroupStatus, contentGroupTone } from '../content-production-ui';
import { I, Link, agentPage, jobPage } from '../nav';

const ACTIVE_GROUPS = new Set(['queued', 'producing', 'reviewing']);
const ACTIVE_RUNS = new Set(['queued', 'running', 'waiting_for_approval', 'waiting_for_input']);

export default function ContentGroupDetail({ site, sites, groupId }: { site: Site; sites: Site[]; groupId: string }) {
  const [group, setGroup] = useState<ContentProductionGroupView | null>(null);
  const [err, setErr] = useState('');

  async function load() {
    const data = await api.contentProductionGroup(site.id, groupId);
    setGroup(data.group);
  }

  useEffect(() => { setErr(''); load().catch((error: Error) => setErr(error.message)); }, [site.id, groupId]);
  const active = Boolean(group && (ACTIVE_GROUPS.has(group.status) || (group.parent_run_status && ACTIVE_RUNS.has(group.parent_run_status))));
  useEffect(() => {
    if (!active) return;
    // Background tabs stop polling; each poll re-reads the whole group, so keep the cadence modest.
    const timer = window.setInterval(attendedPoll(() => { load().catch((error: Error) => setErr(error.message)); }), 10000);
    return () => window.clearInterval(timer);
  }, [site.id, groupId, active]);

  const published = group?.items.filter((item) => item.job_status === 'published').length || 0;
  const awaiting = group?.items.filter((item) => item.job_status === 'awaiting_review').length || 0;

  return <Shell sites={sites} site={site} active="content-list"
    crumb={<><Link className="muted" to={agentPage(site.id, 'content_production')}>{I.back}</Link><Link className="muted" to={agentPage(site.id, 'content_production')}>Editor-in-Chief</Link><span className="sep">›</span><span className="cur">Content Group {shortId(groupId)}</span></>}>
    <div className="production-page content-group-detail-page">
      {err ? <p className="flash">{err}</p> : null}
      {!group ? <p className="empty">{err || 'Loading content group…'}</p> : <>
        <header className="content-group-detail-head">
          <div><span className="business-eyebrow">GROUP {shortId(group.id)} · PARENT RUN {shortId(group.parent_run_id)}</span><h1>{group.group_goal || 'Content Production Group'}</h1><p>{group.group_hypothesis}</p></div>
          <span className={`production-status ${contentGroupTone(group.status)}`}>{contentGroupStatus(group.status)}</span>
        </header>
        <section className="content-group-summary">
          <Summary value={`${group.produced_items}/${group.total_items}`} label="Drafts generated" />
          <Summary value={String(awaiting)} label="Pending pre-publish review" tone="ready" />
          <Summary value={String(published)} label="Published" tone="ready" />
          <Summary value={String(Math.max(0, group.total_items - group.ready_items))} label="Still needs Agent handling" tone={group.status === 'needs_attention' ? 'bad' : ''} />
        </section>
        <GroupBlocker group={group} />
        <section className="content-review-list">
          <header><div><span className="business-eyebrow">ARTICLE REVIEW FLOWS</span><h2>Review and publish article by article</h2></div><small>Each article flows independently; sibling Tasks do not block each other</small></header>
          {group.items.map((item, index) => <ArticleReviewCard key={item.job_id} item={item} index={index} site={site} />)}
        </section>
      </>}
    </div>
  </Shell>;
}

function Summary({ value, label, tone = '' }: { value: string; label: string; tone?: string }) {
  return <div className={`content-group-summary-item ${tone}`}><strong>{value}</strong><span>{label}</span></div>;
}

function GroupBlocker({ group }: { group: ContentProductionGroupView }) {
  const error = group.parent_run_error || group.latest_model_error || group.error;
  const summary = String(group.latest_event_payload?.judgment_summary || '');
  const hasArticleError = group.items.some((item) => item.child_run_error || item.review_run_error);
  return <section className={`content-group-blocker${error ? ' bad' : ''}`}>
    <div><span className="business-eyebrow">PARENT AGENT</span><strong>{parentRunLabel(group)}</strong></div>
    <p>{error || summary || 'The parent Agent continuously observes the drafts and, article by article, decides whether to send them back for revision or push them to pre-publish review.'}</p>
    {error && !hasArticleError ? <small>No article drafts were lost because of this; the current blockage comes from the parent Agent or the model Execution phase, and does not mean every article below has content errors.</small> : null}
    <small>{group.latest_model ? `Model ${group.latest_model}` : 'No model call records yet'}{group.parent_run_updated_at ? ` · ${formatDateTime(group.parent_run_updated_at)}` : ''}</small>
    {group.model_attempts?.some((attempt) => attempt.status === 'failed' || Number(attempt.attempt || 1) > 1) ? <details>
      <summary>View model retry trace ({group.model_attempts.length}  requests)</summary>
      {group.model_attempts.slice(-8).map((attempt) => <small key={attempt.id}>
        Decision {attempt.decision_turn || attempt.turn} · Attempt {attempt.attempt || 1} · {attempt.model} · {attempt.status}
        {attempt.error_kind ? ` · ${attempt.error_kind}` : ''}{attempt.error ? `: ${attempt.error}` : ''}
      </small>)}
    </details> : null}
  </section>;
}

function ArticleReviewCard({ item, index, site }: { item: ContentProductionItemView; index: number; site: Site }) {
  const state = articleState(item);
  const interactions = item.interactions || [];
  const canOpen = Boolean(item.artifact_id || item.current_artifact_id);
  return <article className="content-review-card">
    <header>
      <span className={`production-agent-index ${state.tone}`}>{String(index + 1).padStart(2, '0')}</span>
      <div><div className="content-review-card-title"><h3>{item.title_direction}</h3><span>{item.group_role}</span></div><p>{item.primary_keyword}</p></div>
      <div className="production-agent-meta"><span>Agent {shortId(item.decision_item_id)}</span><span>{item.attempt ? `Draft No. ${item.attempt}` : 'Waiting for first draft'}</span></div>
      <span className={`production-child-state ${state.tone}`}><i />{state.label}</span>
      {canOpen ? <Link className="btn" to={jobPage(site.id, item.job_id)}>{item.job_status === 'awaiting_review' ? 'Pre-publish review' : 'View full text'}</Link> : <button className="btn" type="button" disabled>No drafts yet</button>}
    </header>
    {item.child_run_error ? <p className="content-item-error"><strong>Article sub-Agent Execution failed: </strong>{item.child_run_error}</p> : null}
    {item.review_run_error ? <p className="content-item-error"><strong>This article's parent review Run failed: </strong>{item.review_run_error}</p> : null}
    {!item.child_run_error && !item.review_run_error && item.review_run_phase === 'deferred' ? <p className="content-item-note">This article's parent review has been deferred: {item.review_run_output?.reason || 'Waiting for the resume conditions to be met.'}</p> : null}
    {!item.child_run_error && !item.review_run_error && item.artifact_id && !item.parent_review?.decision ? <p className="content-item-note">{item.self_check ? `Author's new-session self-check: ${item.self_check.summary || 'No major issues'} (${item.self_check.findings} comments, rejected ${item.self_check.declined}).` : 'The draft has been fully preserved.'}{item.internal_link_counts?.length ? ` Internal links: ${item.internal_link_counts.map((count) => `${count.locale} ${count.internal_links} items`).join('，')}.` : ''}</p> : null}
    {item.parent_review?.decision ? <div className={`content-parent-review ${item.parent_review.decision === 'pass' ? 'ready' : 'warn'}`}><strong>{item.parent_review.decision === 'pass' ? 'Parent Agent approved' : 'Parent Agent requested revisions'}</strong><p>{item.parent_review.value_assessment || 'Judgment for this article completed.'}</p>{item.parent_review.seo_geo_risks?.length ? <small>SEO/GEO risks:{item.parent_review.seo_geo_risks.join('; ')}</small> : null}{item.parent_review.seo_strategy_assessment ? <small>SEO strategy: {item.parent_review.seo_strategy_assessment}</small> : null}{item.parent_review.topic_requirement_assessment ? <small>Topic requirements: {item.parent_review.topic_requirement_assessment}</small> : null}{item.parent_review.author_self_check_assessment ? <small>Author self-check verification: {item.parent_review.author_self_check_assessment}</small> : null}{item.parent_review.link_assessment ? <small>Internal links: {item.parent_review.link_assessment}</small> : null}{item.parent_review.link_findings?.length ? <small>Problem links: {item.parent_review.link_findings.map((finding) => `[${finding.locale}]“${finding.anchor_text || 'Missing internal links'}”→ ${finding.target}: ${finding.problem} (suggestion: ${finding.recommended_change})`).join('; ')}</small> : null}{item.parent_review.required_changes?.length ? <small>Revision requirements:{item.parent_review.required_changes.join('; ')}</small> : null}</div> : null}
    <div className="content-interaction-timeline">
      <div className="content-interaction-title"><strong>Parent–child Agent interaction records</strong><span>{interactions.length}  entries</span></div>
      {interactions.length ? interactions.map((interaction) => <Interaction key={interaction.id} interaction={interaction} />) : <p className="content-interaction-empty">No interaction records yet; the first assignment, draft submission, and parent Agent reviews will be recorded here in sequence.</p>}
    </div>
  </article>;
}

function Interaction({ interaction }: { interaction: ContentReviewInteractionView }) {
  return <div className="content-interaction-row">
    <span className={`content-interaction-dot ${interactionTone(interaction.kind)}`} />
    <div><strong>{interactionLabel(interaction.kind)}</strong><p>{interaction.summary}</p><small>{formatDateTime(interaction.created_at)}{interaction.artifact_id ? ` · Artifact ${shortId(interaction.artifact_id)}` : ''}</small></div>
  </div>;
}

const SELF_CHECK_ACTIONS = new Set(['save_article_draft', 'run_self_check']);

/** Ordered by precedence: publication, failures, active review, author work, then work waiting on the parent. */
function articleState(item: ContentProductionItemView) {
  if (item.job_status === 'published') return { label: 'Published', tone: 'ready' };
  if (item.job_status === 'publishing') return { label: 'Publishing', tone: 'active' };
  if (item.job_status === 'awaiting_review') return { label: 'Pending pre-publish review', tone: 'ready' };
  if (item.child_run_status === 'failed' || item.child_run_status === 'cancelled') return { label: 'Sub-agent failed', tone: 'bad' };
  if (item.child_run_phase === 'deferred') return { label: 'Sub-agent paused', tone: 'warn' };
  if (item.review_run_status === 'failed' || item.review_run_status === 'cancelled') return { label: 'Review Run failed', tone: 'bad' };
  if (item.review_run_phase === 'deferred') return { label: 'Review paused', tone: 'warn' };
  if (item.review_run_status === 'running' || item.review_run_status === 'queued') return { label: 'Reviewing', tone: 'review' };
  if (item.child_run_status === 'running' || item.child_run_status === 'queued') {
    if (item.child_last_action && SELF_CHECK_ACTIONS.has(item.child_last_action) && item.child_last_action_status !== 'succeeded') return { label: 'Self-checking', tone: 'active' };
    return { label: item.artifact_status === 'rejected' ? 'Revising' : 'Writing', tone: item.artifact_status === 'rejected' ? 'warn' : 'active' };
  }
  if (item.artifact_status === 'rejected') return { label: 'Pending handoff for revision', tone: 'warn' };
  if (item.artifact_status === 'candidate') return { label: 'Pending review assignment', tone: 'review' };
  return { label: 'Awaiting assignment', tone: 'idle' };
}

const PARENT_ACTION_LABELS: Record<string, string> = {
  save_coverage_plan: 'Parent agent is drafting the coverage plan',
  start_article_tasks: 'Parent agent has assigned writing, waiting for the Writer to submit',
  read_content_article: 'Parent agent is reading candidate drafts',
  read_published_articles: 'Parent agent is finding published articles',
  edit_article_internal_links: 'Parent agent is editing internal links',
  start_content_reviews: 'Parent agent has dispatched reviews, waiting for review results',
  inspect_content_group: 'Parent agent is checking progress across all articles',
  complete_content_group: 'Parent agent is wrapping up this group',
  defer_content_group: 'Parent agent is pausing this group',
};

function parentRunLabel(group: ContentProductionGroupView) {
  if (group.parent_run_status === 'failed') return 'Parent agent Run failed';
  if (group.parent_run_status === 'cancelled') return 'Parent agent was interrupted';
  if (group.parent_run_status === 'succeeded') return 'Parent agent finished this round';
  if (group.parent_run_status === 'queued') return 'Waiting for parent agent to start';
  const action = group.parent_last_action || '';
  if (group.parent_last_action_status !== 'succeeded' && PARENT_ACTION_LABELS[action]) return PARENT_ACTION_LABELS[action];
  return 'Parent agent is deciding the next step';
}

function interactionLabel(kind: string) {
  const labels: Record<string, string> = {
    child_started: 'Parent agent assigns writing',
    child_revision_started: 'Parent agent delivers revision feedback',
    child_submitted: 'Sub-agent delivers a self-checked candidate draft',
    parent_review_started: 'Parent agent starts single-article review',
    parent_review_retried: 'Parent agent partially retries single-article review',
    parent_review_deferred: 'Parent agent pauses single-article review',
    parent_review_failed: 'Parent agent single-article review failed',
    parent_accepted: 'Parent Agent approved',
    parent_revision_requested: 'Parent agent returns for revision',
    human_approved: 'Manually approved for publishing',
    human_revision_requested: 'Manually returned for revision',
  };
  return labels[kind] || kind;
}

function interactionTone(kind: string) {
  if (kind === 'parent_accepted' || kind === 'human_approved') return 'ready';
  if (kind.includes('failed')) return 'bad';
  if (kind.includes('revision')) return 'warn';
  return 'active';
}
