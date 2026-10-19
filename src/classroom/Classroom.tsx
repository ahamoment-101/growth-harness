import { LeaderPanel } from './LeaderPanel';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { RosterMember } from '../../shared/agent-roster';
import { api, type Site } from '../api';
import { SiteMenu, siteLogoUrl, useDismiss } from '../components/Shell';
import { I, classroomPage, go } from '../nav';
import { SeatedBack } from './avatars';
import { layoutHall, VIEW_W, type Slot } from './hall-layout';
import { ScreenWall } from './Screens';
import { StatusBubble } from './StatusBubble';
import { screenFigures, useTeamStatus } from './useTeamStatus';
import { STAGE_W, useStageFit } from './useStageFit';
import { useUnstackedBubbles } from './useUnstackedBubbles';
import type { AgentBubble } from '../../shared/team-status';
import { SiteMark } from './ui';
import './classroom.css';
import { AgentPanels } from './AgentPanels';

type Agent = { id: string; name: string; mission: string };

/** Not in the runtime registry yet, so the AI Growth Leader's desk is the one seat written here. */
const GROWTH_LEADER: Agent = { id: 'cmo', name: 'AI Growth Leader', mission: 'Your AI Growth Leader: understands your business, breaks down the growth goals you set, coordinates the specialized Agents, and follows up on results.' };

/**
 * The site's home: a classroom of digital employees. The AI Growth Leader sits at the desk; every team
 * Agent from the runtime roster takes the next seat in order, filling one row before the next.
 */
export default function Classroom({ site, sites, active, openAgentId, openReviewJobId, openConversationId, openTaskId }: { site: Site; sites: Site[]; active: boolean; openAgentId: string | null; openReviewJobId: string | null; openConversationId: string | null; openTaskId: string | null }) {
  const [team, setTeam] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(active ? openAgentId : null);
  const crowd = useMemo(() => [GROWTH_LEADER, ...team].map((a) => a.id), [team]);
  const selected = [GROWTH_LEADER, ...team].find((a) => a.id === selectedId) ?? null;
  const status = useTeamStatus(site.id);
  const figures = status.figures ?? screenFigures(status.bubbles);
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const fit = useStageFit(viewport, stage);
  const select = (id: string) => {
    setSelectedId((cur) => (cur === id ? null : id));
  };

  useEffect(() => {
    let live = true;
    setSelectedId(null);
    setTeam([]);
    api.agentRoster(site.id).then((d) => { if (live) setTeam(d.members.map(toAgent)); }).catch(() => undefined);
    return () => { live = false; };
  }, [site.id]);

  useEffect(() => { setSelectedId(active ? openAgentId : null); }, [active, openAgentId]);

  return (
    <div ref={viewport} className="classroom">
      {/* The stage keeps one layout at every window size and is scaled whole so its content fits; the bare floor either side may be cut by the window. */}
      <div className="room-fit" style={{ height: fit.height * fit.scale }}>
        <div ref={stage} className="room-stage" style={{ width: STAGE_W, left: `calc(50% - ${(STAGE_W * fit.scale) / 2}px)`, transform: `scale(${fit.scale})` }}>
          <Brand site={site} sites={sites} />
          <ScreenWall site={site} headcount={crowd.length} {...figures} />
          <Seating team={team} crowd={crowd} bubbles={status.byAgent} selectedId={selectedId} onSelect={select} />
        </div>
      </div>

      {status.error && <p role="status" className="classroom-status-error">{status.error}</p>}
      {selected?.id === 'cmo' ? <LeaderPanel key={site.id} site={site} crowd={crowd} names={Object.fromEntries(team.map(member => [member.id, member.name]))} missions={Object.fromEntries(team.map(member => [member.id, member.mission]))} initialConversationId={openConversationId || undefined} onSeen={status.markSeen} onClose={() => setSelectedId(null)} /> : selected ? <AgentPanels key={`${site.id}:${selected.id}`} site={site} siteId={site.id} agent={selected} crowd={crowd} names={Object.fromEntries(team.map((member) => [member.id, member.name]))} bubble={status.byAgent.get(selected.id)} onSeen={status.markSeen} onClose={() => setSelectedId(null)} initialReviewJobId={openReviewJobId || undefined} initialTaskId={openTaskId || undefined} /> : null}
    </div>
  );
}

const toAgent = (m: RosterMember): Agent => ({ id: m.agentId, name: m.name, mission: m.mission });

/** The site's name at the top of the room; it opens the site menu, and switching lands in the other site's classroom. */
function Brand({ site, sites }: { site: Site; sites: Site[] }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(root, open, close);
  const name = site.name || site.root_domain || site.domain;
  const logo = siteLogoUrl(site, 128);
  return (
    <header className={`room-brand${open ? ' open' : ''}`}>
      <div className="room-brand-switch" ref={root}>
        <button type="button" className="room-brand-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {logo && !failed ? <img className="room-brand-logo" src={logo} alt="" width={40} height={40} onError={() => setFailed(true)} /> : <SiteMark name={name} size={40} />}
          <strong className="room-brand-name">{name}</strong>
          {site.root_domain && site.root_domain !== name ? <span className="room-brand-domain">{site.root_domain}</span> : null}
          <span className="room-brand-chevron">{I.chevron}</span>
        </button>
        {open ? <SiteMenu sites={sites} current={site} onSwitch={(next) => go(classroomPage(next.id))} onClose={close} /> : null}
      </div>
    </header>
  );
}

/* ───────── tiered seating ───────── */

/** Occupied seats (stool and figure together) draw at this share of the seat size; spacing is unchanged. */
const FIGURE_SCALE = 0.7;
/** The front-row figure turned toward the room sits at a desk and draws larger than the crowd. */
const FACING_SCALE = 0.85;
/** Its desk keeps this size on its own, whatever FACING_SCALE the figure uses. */
const DESK_SCALE = 1.05;
/** Nearer seats stack above farther ones; every seat stays below this (a hovered seat rises to it, see .seat.agent:hover). */
const SEAT_Z_TOP = 4000;

/** Bubbles float above every seat, so a nearer figure never hides a farther one's bubble. */
const BUBBLE_Z = SEAT_Z_TOP + 1;
/** A bubble's tail sits this share of the figure's height above the seat's floor point. */
const BUBBLE_LIFT = 0.8;

function Seating({ team, crowd, bubbles, selectedId, onSelect }: { team: Agent[]; crowd: readonly string[]; bubbles: ReadonlyMap<string, AgentBubble>; selectedId: string | null; onSelect: (id: string) => void }) {
  const { rows, height, lift, rings, stage } = useMemo(() => layoutHall(GROWTH_LEADER, team), [team]);
  const names = (id: string) => team.find((a) => a.id === id)?.name ?? 'Teammates';
  const room = useRef<HTMLDivElement>(null);
  useUnstackedBubbles(room, bubbles);
  const pct = (slot: Slot, extra: CSSProperties = {}): CSSProperties => ({
    left: `${(slot.x / VIEW_W) * 100}%`,
    top: `${(slot.y / height) * 100}%`,
    width: `${slot.scale * 10}%`,
    zIndex: Math.round(SEAT_Z_TOP - slot.depth * 100),
    ...extra,
  });

  return (
    // One view unit is 0.1cqw of the room, so the stage's lift converts straight into margin.
    <div ref={room} className="seating" style={{ aspectRatio: `${VIEW_W} / ${height}`, marginTop: `calc(0px - ${(lift / 10).toFixed(2)}cqw)` }}>
      <svg className="tiers" viewBox={`0 0 ${VIEW_W} ${height}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="stage-top" gradientUnits="userSpaceOnUse" x1="0" y1={stage.topSpan.y1} x2="0" y2={stage.topSpan.y2}>
            <stop offset="0" stopColor="#EADBC4" />
            <stop offset="1" stopColor="#F4EADB" />
          </linearGradient>
          <filter id="glow" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="2.4" /></filter>
        </defs>
        <path d={stage.face} fill="#C9B08C" />
        <path d={stage.top} fill="url(#stage-top)" />
        <path d={stage.lip} fill="none" stroke="#fff" strokeWidth="3" opacity=".8" filter="url(#glow)" />
        {rings.map((ring) => <path key={ring.radius} d={ring.path} fill="none" stroke="#fff" strokeWidth="2" opacity=".55" />)}
      </svg>

      {rows.map((row) => row.seats.map(({ agent, plate, facing }) => agent && !facing ? (
        <span key={`${agent.id}-name`} className="floor-name" aria-hidden
          style={pct(plate.slot, { width: 'auto', zIndex: 1, fontSize: `${(plate.slot.scale * 0.95).toFixed(2)}cqw`, transform: `translate(-50%, -50%) ${plate.matrix}` })}>
          {agent.name}
        </span>
      ) : null))}
      {rows.map((row) => row.seats.map(({ slot, agent, yaw, view, facing }) => agent ? (
        <button
          key={agent.id}
          type="button"
          data-agent-id={agent.id}
          className={`seat agent${agent.id === selectedId ? ' selected' : ''}`}
          style={pct(slot, { width: `${slot.scale * 10 * (facing ? FACING_SCALE : FIGURE_SCALE)}%`, ...(facing ? { '--desk-scale': DESK_SCALE / FACING_SCALE } : {}) } as CSSProperties)}
          onClick={() => onSelect(agent.id)}
          aria-label={agent.name}
          aria-pressed={agent.id === selectedId}
        >
          <span className="seat-figure"><SeatedBack crowd={crowd} id={agent.id} yaw={yaw} view={view} face={facing} /></span>
          {/* The desk figure's name is lettered on the desk front instead of the floor. */}
          {facing ? <span className="desk-name" style={{ fontSize: `${(slot.scale * 0.58).toFixed(2)}cqw`, letterSpacing: 0 }}>{agent.name}</span> : null}
        </button>
      ) : null))}
      {rows.map((row) => row.seats.map(({ slot, agent, facing }) => {
        const bubble = agent ? bubbles.get(agent.id) : undefined;
        if (!bubble) return null;
        // The figure is square and as wide as its seat, so its height in room units is its width.
        const figure = slot.scale * 10 * (facing ? FACING_SCALE : FIGURE_SCALE);
        return (
          <StatusBubble key={`${agent!.id}-bubble`} bubble={bubble} names={names}
            style={pct(slot, { width: 'auto', zIndex: BUBBLE_Z, transform: `translate(-50%, calc(-100% - ${(figure * BUBBLE_LIFT).toFixed(2)}cqw - var(--bubble-raise, 0px)))` })} />
        );
      }))}
    </div>
  );
}
