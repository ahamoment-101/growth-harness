import { useEffect, useRef, useState } from 'react';
import { api, formatDateTime } from '../api';
import type {
  LearningRecord,
  LearningDetail,
  LearningSection,
  LearningUse,
} from '../../shared/learning';
import { go, agentPage, sitePage } from '../nav';
import './learning.css';

export const experienceUrl = (siteId: string, id: string) =>
  `${sitePage(siteId, 'cabinet')}?category=experience&experience=${encodeURIComponent(id)}`;
const learningTaskUrl = (siteId: string, agentId: string, taskId: string) =>
  agentId === 'growth_leader'
    ? `${agentPage(siteId, 'cmo')}&conversation=${encodeURIComponent(taskId)}`
    : `${agentPage(siteId, agentId)}&task=${encodeURIComponent(taskId)}`;
const labels: Record<string, string> = {
  preparing: 'Preparing',
  observing: 'Awaiting outcomes',
  incomplete: 'Evidence incomplete',
  evaluated: 'Outcome evaluated',
};
function ThreeParts({
  record,
  full = false,
  adoptedBy = [],
}: {
  record: LearningRecord;
  full?: boolean;
  adoptedBy?: LearningUse[];
}) {
  const e = record.experience,
    u = record.utility;
  const practices = new Set(adoptedBy.map((use) => use.practice_id)).size;
  return (
    <div className="learning-parts">
      <section>
        <span className="learning-number">01</span>
        <h3>Intent</h3>
        <small>What were we trying to achieve?</small>
        <p>{record.intent.goal}</p>
        {full && (
          <>
            <h4>Conditions</h4>
            <p>{record.intent.context || 'Not yet established'}</p>
            <h4>Expected outcome</h4>
            <p>{record.intent.expectation || 'No supported expectation yet'}</p>
          </>
        )}
      </section>
      <section>
        <span className="learning-number">02</span>
        <h3>Experience</h3>
        <small>What did practice teach us?</small>
        <p>
          {e.insight ||
            e.assessment?.conclusion ||
            e.hypothesis ||
            'The learning Agent is preparing this practice.'}
        </p>
        {full && (
          <>
            <h4>Original hypothesis</h4>
            <p>{e.hypothesis || 'Not established before action'}</p>
            <h4>Approach</h4>
            <p>{e.approach || 'Not reported yet'}</p>
            <h4>Changes during practice</h4>
            {e.adjustments.length ? (
              <ul>
                {e.adjustments.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            ) : (
              <p>No adjustments recorded separately yet.</p>
            )}
            <h4>Actual delivery</h4>
            <p>{e.delivery || 'Not delivered yet'}</p>
            <h4>This practice’s outcome</h4>
            <p>
              {e.assessment?.reward == null
                ? 'Not yet assessable'
                : `${e.assessment.reward.toFixed(2)} / 1 · goal attainment`}
            </p>
          </>
        )}
      </section>
      <section>
        <span className="learning-number">03</span>
        <h3>Utility</h3>
        <small>Has this helped later work?</small>
        <div className="learning-score">
          {u.score == null ? (
            'Not yet validated'
          ) : (
            <>
              {u.score.toFixed(2)} <small>/ 1</small>
            </>
          )}
        </div>
        <p>
          {u.feedback_count} evaluated {u.feedback_count === 1 ? 'use' : 'uses'}
        </p>
        <p className="learning-note">
          {u.feedback_count
            ? 'An estimate from later use, not proof of causation.'
            : 'Later adoption and actual results will establish its usefulness.'}
        </p>
        {full && (
          <p className="learning-note">
            Returning or reading an experience is not adoption. Several Agents
            using it in one practice contribute one outcome.
          </p>
        )}
        {full && adoptedBy.length > 0 && (
          <>
            <h4>Changed later decisions</h4>
            <p>{adoptedBy[0].reason}</p>
            <p className="learning-note">
              {practices} later {practices === 1 ? 'practice' : 'practices'} ·{' '}
              {adoptedBy.length} Agent {adoptedBy.length === 1 ? 'use' : 'uses'}{' '}
              on this page
            </p>
            <a href="#learning-impact">See adopting tasks and results ↓</a>
          </>
        )}
      </section>
    </div>
  );
}
export function BusinessExperience({ siteId }: { siteId: string }) {
  const [records, setRecords] = useState<LearningRecord[]>([]),
    [detail, setDetail] = useState<LearningDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('experience'),
  );
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState(''),
    [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(true),
    [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    let live = true;
    setBusy(true);
    setError('');
    setDetail(null);
    const timer = setTimeout(
      () => {
        void (
          selected
            ? api.learningDetail(siteId, selected)
            : api.learningRecords(siteId, query, status)
        )
          .then((result) => {
            if (!live) return;
            if ('record' in result) setDetail(result);
            else {
              setRecords(result.records);
              setCursor(result.next_cursor);
            }
          })
          .catch((e) => {
            if (live) setError(e.message);
          })
          .finally(() => {
            if (live) setBusy(false);
          });
      },
      selected ? 0 : 200,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [siteId, query, status, selected, reload]);
  const open = (id: string | null) => {
    setSelected(id);
    history.replaceState(
      null,
      '',
      id
        ? experienceUrl(siteId, id)
        : `${sitePage(siteId, 'cabinet')}?category=experience`,
    );
  };
  const more = async () => {
    if (!cursor || busy) return;
    const requestGeneration = generation.current;
    setBusy(true);
    try {
      const result = await api.learningRecords(siteId, query, status, cursor);
      if (requestGeneration !== generation.current) return;
      setRecords((old) => [...old, ...result.records]);
      setCursor(result.next_cursor);
    } catch (e) {
      if (requestGeneration === generation.current) setError(String(e));
    } finally {
      if (requestGeneration === generation.current) setBusy(false);
    }
  };
  const moreDetail = async (section: LearningSection) => {
    if (!detail || busy) return;
    const after = detail.next_cursors[section];
    if (!after) return;
    const requestGeneration = generation.current;
    setBusy(true);
    try {
      const page = await api.learningPage(
        siteId,
        detail.record.id,
        section,
        after,
      );
      if (requestGeneration !== generation.current) return;
      setDetail((old) =>
        old
          ? {
              ...old,
              [section]: [...old[section], ...page.items],
              next_cursors: {
                ...old.next_cursors,
                [section]: page.next_cursor || undefined,
              },
            }
          : old,
      );
    } catch (e) {
      if (requestGeneration === generation.current) setError(String(e));
    } finally {
      if (requestGeneration === generation.current) setBusy(false);
    }
  };
  return (
    <div className="business-experience">
      <header className="learning-intro">
        <div>
          <span className="room-eyebrow">Shared learning · This site</span>
          <h2>From business intent to better decisions</h2>
          <p>
            See what the team tried, what the results taught it, and how that
            experience informed later work.
          </p>
        </div>
        <button
          className="room-back"
          onClick={() => setReload((n) => n + 1)}
          disabled={busy}
        >
          Refresh
        </button>
      </header>
      {selected ? (
        <button className="room-back" onClick={() => open(null)}>
          ← All business experience
        </button>
      ) : (
        <div className="learning-filters">
          <input
            type="search"
            aria-label="Search business experience"
            placeholder="Search goals, judgments or lessons…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="Observation status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All observation states</option>
            {Object.entries(labels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <div role="alert" className="room-read-error">
          {error}
          <button className="room-back" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {busy && (
        <p role="status" className="learning-note">
          Reading saved learning…
        </p>
      )}
      {!selected && !busy && !error && !records.length && (
        <div className="learning-empty">
          <h3>
            {query || status
              ? 'No matching experience'
              : 'Every experience starts with an intent'}
          </h3>
          {query || status ? (
            <p>
              Try another search or observation state.{' '}
              <button
                className="room-back"
                onClick={() => {
                  setQuery('');
                  setStatus('');
                }}
              >
                Clear filters
              </button>
            </p>
          ) : (
            <>
              <p>
                As the team completes new work, its judgments and results will
                appear here. Utility becomes known only after later use receives
                feedback.
              </p>
              <div className="learning-empty-flow">
                Intent <span>→</span> Experience <span>→</span> Utility
              </div>
            </>
          )}
        </div>
      )}
      {!selected &&
        records.map((r) => (
          <article className="learning-card" key={r.id}>
            <header>
              <div>
                <span className="learning-status">
                  {labels[r.status] || r.status}
                </span>
                <h2>
                  <button onClick={() => open(r.id)}>{r.title}</button>
                </h2>
              </div>
              <time>{formatDateTime(r.updated_at)}</time>
            </header>
            <ThreeParts record={r} />
            <footer>
              <span>Shared across Agents · v{r.version}</span>
              <button className="room-back" onClick={() => open(r.id)}>
                View decisions & evidence ↗
              </button>
            </footer>
          </article>
        ))}
      {!selected && cursor && (
        <button
          className="room-back"
          disabled={busy}
          onClick={() => void more()}
        >
          Load more experience
        </button>
      )}
      {detail && (
        <article className="learning-card learning-detail">
          <header>
            <div>
              <span className="learning-status">
                {labels[detail.record.status] || detail.record.status}
              </span>
              <h2>{detail.record.title}</h2>
            </div>
            <time>Updated {formatDateTime(detail.record.updated_at)}</time>
          </header>
          <ThreeParts
            record={detail.record}
            full
            adoptedBy={detail.adopted_by}
          />
          {!!detail.record.experience.gaps.length && (
            <aside className="learning-gaps">
              <h3>What we still do not know</h3>
              <ul>
                {detail.record.experience.gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </aside>
          )}
          {!!detail.processing.length && (
            <aside className="learning-gaps">
              <h3>Learning work in progress</h3>
              {detail.processing.map((p) => (
                <p key={p.id}>
                  {p.phase} · {p.status}
                  {p.error ? ` · ${p.error}` : ''}
                  {p.failure_count
                    ? ` · ${p.failure_count} failed attempts`
                    : ''}
                </p>
              ))}
            </aside>
          )}
          <section className="learning-impact" id="learning-impact">
            <h3>How this experience changed later decisions</h3>
            {detail.adopted_by.length ? (
              detail.adopted_by.map((u) => (
                <div key={`${u.practice_id}:${u.task_id}`}>
                  <strong>{u.agent_id.replaceAll('_', ' ')}</strong>
                  <p>{u.reason}</p>
                  <p className="learning-note">{u.compatibility}</p>
                  <p className="learning-note">
                    {!u.feedback_received
                      ? 'Awaiting outcome feedback'
                      : u.feedback_reward == null
                        ? 'Outcome is not yet comparable or assessable'
                        : `Later outcome reward: ${u.feedback_reward.toFixed(2)} / 1`}
                  </p>
                  <a
                    href={learningTaskUrl(siteId, u.agent_id, u.task_id)}
                  >
                    Open adopting task ↗
                  </a>
                  <br />
                  <a
                    href={experienceUrl(siteId, u.practice_id)}
                    onClick={(e) => {
                      e.preventDefault();
                      open(u.practice_id);
                    }}
                  >
                    View later practice and its results ↗
                  </a>
                </div>
              ))
            ) : (
              <p>
                No later adoption has been reported. Reading this record does
                not count as using it.
              </p>
            )}
          </section>
          <details className="learning-evidence">
            <summary>Evaluation agreement & observation</summary>
            {detail.record.experience.evaluation ? (
              <>
                <p>{detail.record.experience.evaluation.objective}</p>
                <p>{detail.record.experience.evaluation.score_meaning}</p>
                <pre>
                  {JSON.stringify(detail.record.experience.evaluation, null, 2)}
                </pre>
              </>
            ) : (
              <p>No pre-action evaluation agreement was established.</p>
            )}
            {detail.observations.map((o) => (
              <div key={o.id}>
                <a href={o.url} target="_blank" rel="noreferrer">
                  Observed page ↗
                </a>
                <p>
                  {o.start_date} – {o.end_date} · {o.status}
                </p>
                {o.error && <p>{o.error}</p>}
              </div>
            ))}
          </details>
          <details className="learning-evidence">
            <summary>
              Formal evidence · {detail.evidence.length}
              {detail.next_cursors.evidence ? '+' : ''}
            </summary>
            {detail.evidence.map((e) => (
              <div key={e.id}>
                <h4>
                  {e.kind} · {formatDateTime(e.created_at)}
                </h4>
                <small>{e.source_ref}</small>
                <pre>{JSON.stringify(e.payload, null, 2)}</pre>
              </div>
            ))}
          </details>
          <section className="learning-related">
            <h3>Related work</h3>
            {detail.tasks.map((t) => (
              <a
                key={t.task_id}
                href={learningTaskUrl(siteId, t.agent_id, t.task_id)}
              >
                {t.agent_id.replaceAll('_', ' ')} ↗
              </a>
            ))}
            {detail.uses.map((u) => (
              <a
                key={`${u.experience_id}:${u.task_id}`}
                href={experienceUrl(siteId, u.experience_id)}
                onClick={(e) => {
                  e.preventDefault();
                  open(u.experience_id);
                }}
              >
                Experience used: {u.reason} ↗
              </a>
            ))}
          </section>
          {Object.entries(detail.next_cursors)
            .filter(([, cursor]) => cursor)
            .map(([section]) => (
              <button
                className="room-back"
                key={section}
                disabled={busy}
                onClick={() => void moreDetail(section as LearningSection)}
              >
                Load more {section.replaceAll('_', ' ')}
              </button>
            ))}
        </article>
      )}
    </div>
  );
}
export function TaskLearningLinks({
  siteId,
  taskId,
  version,
}: {
  siteId: string;
  taskId: string;
  version: string;
}) {
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof api.taskLearning>
  > | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setResult(null);
    setError('');
    void api
      .taskLearning(siteId, taskId)
      .then((r) => {
        if (live) setResult(r);
      })
      .catch(() => {
        if (live) setError('Learning links could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [siteId, taskId, version]);
  if (error)
    return (
      <p className="learning-note" role="status">
        {error}
      </p>
    );
  if (!result?.formed && !result?.used.length) return null;
  return (
    <aside className="task-learning">
      <strong>Business experience</strong>
      {result?.formed && (
        <button onClick={() => go(experienceUrl(siteId, result.formed!.id))}>
          Experience formed by this practice ↗
        </button>
      )}
      {!!result?.used.length && (
        <div>
          <span>Experience used in this task</span>
          {result.used.map((r) => (
            <button key={r.id} onClick={() => go(experienceUrl(siteId, r.id))}>
              {r.title} ↗
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
