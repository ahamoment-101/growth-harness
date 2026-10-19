import { useEffect, useState } from 'react';
import { api, formatDateTime, type ContentArtifactView, type ContentReviewInteractionView, type Job, type QaReport } from '../api';
import { MarkdownDocument } from '../components/MarkdownDocument';

export function PublicationReview({ siteId, jobId, onBack }: { siteId: string; jobId: string; onBack: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [qa, setQa] = useState<QaReport | null>(null);
  const [artifact, setArtifact] = useState<ContentArtifactView | null>(null);
  const [interactions, setInteractions] = useState<ContentReviewInteractionView[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    const result = await api.job(jobId);
    if (result.job.site_id !== siteId) throw new Error('Article does not belong to the current site');
    setJob(result.job); setQa(result.qa); setArtifact(result.artifact); setInteractions(result.interactions || []);
  }
  useEffect(() => { setJob(null); setError(''); void load().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }, [siteId, jobId]);

  async function act(action: 'approve' | 'reject') {
    if (busy || !job || job.status !== 'awaiting_review' || (action === 'reject' && !note.trim())) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'approve') await api.approve(jobId);
      else await api.reject(jobId, note.trim());
      await load();
      setMessage(action === 'approve' ? 'Approved for publication' : 'Sent back for rewrite');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <div className="ap-publication">
    <button className="room-back" onClick={onBack}>← Back to Agent work</button>
    {!job ? <p>{error || 'Loading article…'}</p> : <>
      <header><span>Pre-publication review · {job.status}</span><h2>{job.title || job.versions[0]?.title || 'Article Review'}</h2><p>{job.category || 'Uncategorized'} · Source language {job.source_locale} · {job.versions.length} language versions</p></header>
      {qa && <section><h3>QA Report</h3>{qa.issues.length ? qa.issues.map(issue => <p key={issue.code}>{issue.message}</p>) : <p>No QA issues.</p>}</section>}
      {job.versions.map(version => <section key={version.locale}><h3>{version.title} · {version.locale}</h3><p>{version.excerpt}</p><MarkdownDocument markdown={version.content || ''} /></section>)}
      {artifact && <section><h3>Agent Acceptance</h3><p>{artifact.parent_review.value_assessment || 'No acceptance summary yet'}</p>{artifact.parent_review.required_changes?.length ? <p>Revision requirements:{artifact.parent_review.required_changes.join('; ')}</p> : null}{artifact.parent_review.seo_geo_risks?.length ? <p>SEO/GEO risks:{artifact.parent_review.seo_geo_risks.join('; ')}</p> : null}</section>}
      {!!interactions.length && <section><h3>Agent Round Trips</h3>{interactions.map(item => <p key={item.id}>{formatDateTime(item.created_at)} · {item.summary}</p>)}</section>}
      {job.status === 'awaiting_review' && <section className="ap-publication-actions"><label>Reason for return<textarea value={note} onChange={event => setNote(event.target.value)} placeholder="Explain what needs to change in the next draft" disabled={busy} /></label><div><button className="btn" disabled={busy || !note.trim()} onClick={() => void act('reject')}>Send back for rewrite</button><button className="btn primary" disabled={busy} onClick={() => void act('approve')}>Approve and Publish</button></div></section>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert" className="ap-error">{error}</p>}
    </>}
  </div>;
}
