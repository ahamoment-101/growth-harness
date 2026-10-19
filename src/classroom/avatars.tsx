// "Digital employee" figures for the home classroom. The stool is a flat SVG; the person
// on it is a three.js brick-toy minifigure rendered to a snapshot (see figure3d.ts).
// Appearance is derived from the agent id so a given agent always looks the same.
import { SEAT_ASPECT, SEAT_ORIGIN_Y, portraitSnapshot, portraitSnapshotKey, seatSnapshot, seatSnapshotKey, type Look, type V3 } from './figure3d';
import { useSnapshot } from './useSnapshot';

// Brick-toy colours spread round the whole wheel; figure3d softens their saturation.
const SHIRTS = ['#C9463D', '#E07A3F', '#D9A534', '#8DB04A', '#3E8E6A', '#2F8F8A', '#4AA3D8', '#3F66C9', '#5A4FB8', '#8A72D1', '#C0609E', '#E48FA8', '#8A5A3C', '#2F3B55', '#F1F0EC'];
const PANTS = ['#34405A', '#5B616B', '#8A6A4A', '#2F3440', '#5E7A4A', '#C9B48A', '#7A3E3E', '#4A6FA5'];
// No yellow hats: they would melt into the yellow heads.
const CAP_COLORS = ['#C9463D', '#E07A3F', '#8DB04A', '#3E8E6A', '#2F8F8A', '#4AA3D8', '#3F66C9', '#8A72D1', '#C0609E', '#2F3B55', '#F1F0EC', '#8A5A3C'];
const HELMET_COLORS = ['#F1F0EC', '#E07A3F', '#4AA3D8', '#C9463D', '#8DB04A'];

function hash(value: string) {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  // Avalanche the bits: plain FNV barely separates ids that differ in one character.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Picks from `list`, starting at this id's hashed preference but yielding to the nearest colour worn by fewer people. */
function balanced<T>(list: readonly T[], used: Map<T, number>, key: string, skip?: T) {
  const start = hash(key) % list.length;
  let best: T | undefined;
  for (let step = 0; step < list.length; step++) {
    const c = list[(start + step) % list.length];
    if (c === skip) continue;
    if (best === undefined || (used.get(c) ?? 0) < (used.get(best) ?? 0)) best = c;
  }
  used.set(best!, (used.get(best!) ?? 0) + 1);
  return best!;
}

const crowds = new Map<string, Map<string, Look>>();

/**
 * Looks for the site's whole team, so colours spread across the room instead of clumping.
 * The seats and the employee card both ask through here, so one agent looks the same in each.
 */
function crowdLooks(crowd: readonly string[]) {
  const key = crowd.join('|');
  let looks = crowds.get(key);
  if (!looks) {
    looks = new Map();
    const shirts = new Map<string, number>();
    const pants = new Map<string, number>();
    const hats = new Map<string, number>();
    for (const id of crowd) looks.set(id, pickLook(id, shirts, pants, hats));
    crowds.set(key, looks);
  }
  return looks;
}

function pickLook(id: string, shirts = new Map<string, number>(), pants = new Map<string, number>(), hats = new Map<string, number>()): Look {
  const hat: Look['hat'] = hash(`${id}:hat`) % 3 === 0 ? 'helmet' : 'cap';
  const shirt = balanced(SHIRTS, shirts, `${id}:shirt`);
  return {
    shirt,
    pants: balanced(PANTS, pants, `${id}:pants`, shirt),
    hat,
    hatColor: balanced(hat === 'helmet' ? HELMET_COLORS : CAP_COLORS, hats, `${id}:hat-color`, shirt),
  };
}

function lookOf(crowd: readonly string[], id: string) {
  return crowdLooks(crowd).get(id) ?? pickLook(id);
}

const STOOLS = ['#F4A7A0', '#8FD3B8', '#F6CF6B', '#8EC5F2', '#C3A8EE'];

/** Stool top centre in the 100×100 seat box; the 3D snapshot is anchored here. */
const STOOL_TOP = { x: 50, y: 81 };
/** Snapshot width as a share of the seat box (figure units → box). */
const FIGURE_WIDTH = 83;

/**
 * Seen from where the classroom camera sees this seat: the figure is turned by `yaw` toward
 * the stage, and `view` is the unit vector from the seat to the camera.
 */
export function SeatedBack({ crowd, id, yaw, view, face = false }: { crowd: readonly string[]; id: string; yaw: number; view: V3; face?: boolean }) {
  const l = lookOf(crowd, id);
  const stool = STOOLS[hash(`${id}-stool`) % STOOLS.length];
  const url = useSnapshot(() => seatSnapshot(id, l, yaw, view, face), seatSnapshotKey(id, l, yaw, view, face));
  const height = FIGURE_WIDTH * SEAT_ASPECT;
  return (
    <>
      <svg viewBox="0 0 100 100" aria-hidden>
        <ellipse cx="50" cy="95" rx="25" ry="5.5" fill="rgba(40,48,90,.16)" />
        <path d="M36 84l-3 11M64 84l3 11M50 87v9" stroke={stool} strokeWidth="4" strokeLinecap="round" />
        <path d="M36 84l-3 11M64 84l3 11M50 87v9" stroke="rgba(0,0,0,.14)" strokeWidth="4" strokeLinecap="round" />
        <ellipse cx="50" cy="83.5" rx="20" ry="7" fill={stool} />
        <ellipse cx="50" cy="83.5" rx="20" ry="7" fill="rgba(0,0,0,.14)" />
        <ellipse cx="50" cy="81" rx="20" ry="6.5" fill={stool} />
        <ellipse cx="50" cy="80" rx="15" ry="4" fill="rgba(255,255,255,.28)" />
      </svg>
      {url ? (
        <img
          className="figure-3d"
          src={url}
          alt=""
          draggable={false}
          style={{ left: `${STOOL_TOP.x - FIGURE_WIDTH / 2}%`, top: `${STOOL_TOP.y - height * SEAT_ORIGIN_Y}%`, width: `${FIGURE_WIDTH}%`, height: `${height}%` }}
        />
      ) : null}
      {face ? (
        // A figure facing the room sits behind a desk; its top meets the hands, the front hides the legs.
        <svg className="seat-desk" viewBox="0 0 100 100" aria-hidden>
          <ellipse cx="50" cy="97" rx="44" ry="4.5" fill="rgba(40,48,90,.16)" />
          <path d="M13 60h74l5 5.5H8z" fill="#FBF6EE" />
          <path d="M8 65.5h84v1.8H8z" fill="#E6D6BD" />
          <rect x="10" y="67.3" width="80" height="28" rx="1.5" fill="#EFE3D1" />
          <rect x="16" y="72" width="68" height="18" rx="1.5" fill="none" stroke="#E0CFB4" strokeWidth="1.2" />
        </svg>
      ) : null}
    </>
  );
}

/** Front three-quarter bust, used on the employee card. */
export function Portrait({ crowd, id }: { crowd: readonly string[]; id: string }) {
  const l = lookOf(crowd, id);
  const url = useSnapshot(() => portraitSnapshot(id, l), portraitSnapshotKey(id, l));
  return url ? <img className="portrait-3d" src={url} alt="" draggable={false} /> : null;
}
