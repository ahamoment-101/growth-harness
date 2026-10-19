// Where everything in the classroom sits. The hall is laid out in world units (x right, y up,
// z toward the camera, stage at the origin) and projected through a camera above and behind
// the back row, so rows curve and grow toward the viewer like a real lecture hall seen from
// the balcony. Pure geometry: no DOM, so the seating rules are testable on their own.

import type { V3 } from './figure3d';

export type Slot = { x: number; y: number; scale: number; depth: number };
/** `plate` is where the name lies on the floor, with the floor's own slant as a 2D matrix. */
type Seat<A> = { slot: Slot; agent?: A; yaw: number; view: V3; facing: boolean; plate: { slot: Slot; matrix: string } };
type PlacedRow<A> = { radius: number; seats: Seat<A>[]; ring: boolean };

/** Width of the hall's view box; every projected x and y is in these units. */
export const VIEW_W = 1000;
const ROW0_RADIUS = 3.6;
export const ROW_PITCH = 1.3;
/** Camera and framing assume this pitch, so tightening ROW_PITCH packs seats closer instead of zooming the room. */
const FRAME_PITCH = 1.75;
const FRAME_ROWS = 4;
const ROW_SPAN = 1.1; // radians either side of the aisle
const SEAT_GAP = 0.95;
const SEAT_SIZE = 1.5;
const STAGE_H = 0.14;
/** The hall is framed from this point in front of the screens' foot; rows keep their place whatever the stage's size. */
const FRAME_ANCHOR_Z = 2.3;
/** The stage is an ellipse centred under the screens' foot: wide like them, shallow from front to back. */
export const STAGE_RZ = 1.0;
const STAGE_RX = 2.8;
/** The AI Growth Leader's desk stands on the floor just in front of the stage lip, ahead of the first row. */
export const CMO_RADIUS = 1.7;
export const MAX_HALF_WIDTH = 440;
const STAGE_TOP_MARGIN = 6;
/** How far behind the stool (toward the viewer) a name lies on the floor, in world units. */
const NAME_OFFSET = 0.3;
/** Seats sit a little outside their ring line. */
const SEAT_INSET = 0.08;
/** Ring lines reach this far either side of the aisle, past the widest row. */
const RING_SPAN = 1.52;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const onArc = (radius: number, theta: number, y: number): V3 => [radius * Math.sin(theta), y, radius * Math.cos(theta)];
const onStage = (theta: number, y: number): V3 => [STAGE_RX * Math.sin(theta), y, STAGE_RZ * Math.cos(theta)];

type Projection = ((p: V3) => Slot) & { eye: V3; lift: number };

function makeProjection(rowCount: number): Projection {
  // The camera frames at least FRAME_ROWS rows, so a small team doesn't zoom the stage and screens out of place.
  const back = ROW0_RADIUS + FRAME_PITCH * (Math.max(rowCount, FRAME_ROWS) - 1);
  const eye: V3 = [0, back * 1.35 + 4, back + 5];
  const forward = unit(sub([0, 0, ROW0_RADIUS * 0.5], eye));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const raw = (p: V3) => { const d = sub(p, eye); const depth = dot(d, forward); return { x: dot(d, right) / depth, y: -dot(d, up) / depth, depth }; };
  // Fit the third row's span to the view width, then put the stage lip near the top edge.
  const fitRow = ROW0_RADIUS + FRAME_PITCH * 2;
  const f = MAX_HALF_WIDTH / raw(onArc(fitRow, ROW_SPAN, 0)).x;
  const lipY = 150 - f * raw([0, 0, FRAME_ANCHOR_Z]).y;
  // The whole stage must fit inside the view; any extra room it needs at the top is
  // reported as `lift` so the hall can be pulled up by the same amount and nothing else moves.
  const lift = Math.max(0, STAGE_TOP_MARGIN - (lipY + f * raw([0, STAGE_H, -STAGE_RZ]).y));
  const oy = lipY + lift;
  const project = (p: V3): Slot => { const r = raw(p); return { x: VIEW_W / 2 + f * r.x, y: oy + f * r.y, scale: (f * SEAT_SIZE) / r.depth / 100, depth: r.depth }; };
  return Object.assign(project, { eye, lift });
}

/** The desk figure stands alone before the stage; the team fills the rows from the first ring outward, each row centred on the aisle. */
function placeRows<A>(desk: A, team: readonly A[]) {
  const layout = (rowCount: number) => {
    const project = makeProjection(rowCount);
    // The desk figure turns round instead of facing the stage, facing the room (and the camera).
    const deskAt = onArc(CMO_RADIUS, 0, 0);
    const placed: PlacedRow<A>[] = [{
      radius: CMO_RADIUS,
      ring: false,
      seats: [{ slot: project(deskAt), agent: desk, yaw: Math.PI, view: unit(sub(project.eye, deskAt)), facing: true, plate: floorPlate(project, CMO_RADIUS + NAME_OFFSET, 0) }],
    }];
    let rest = team;
    for (let r = 0; r === 0 || rest.length; r++) {
      const radius = ROW0_RADIUS + ROW_PITCH * r;
      let span = ROW_SPAN;
      while (span > 0.3 && Math.abs(project(onArc(radius, span, 0)).x - VIEW_W / 2) > MAX_HALF_WIDTH) span -= 0.02;
      const capacity = Math.max(3, Math.floor((2 * span * radius) / SEAT_GAP) + 1);
      const take = rest.slice(0, capacity);
      rest = rest.slice(capacity);
      const offset = Math.floor((capacity - take.length) / 2);
      const step = (2 * span) / (capacity - 1);
      placed.push({
        radius,
        ring: true,
        seats: Array.from({ length: capacity }, (_, i) => {
          // Each figure turns to face the stage; the camera sees it along seat → eye.
          const theta = -span + step * i;
          const at = onArc(radius + SEAT_INSET, theta, 0);
          return { slot: project(at), agent: take[i - offset], yaw: theta, view: unit(sub(project.eye, at)), facing: false, plate: floorPlate(project, radius + SEAT_INSET + NAME_OFFSET, theta) };
        }),
      });
    }
    return { placed, project };
  };
  // Row capacity depends on the camera, which depends on the row count: lay out once, then again if the guess was off.
  const guess = 1 + Math.max(1, Math.ceil(team.length / 10));
  const first = layout(guess);
  return first.placed.length === guess ? first : layout(first.placed.length);
}

function arcPoints(project: Projection, radius: number, y: number, from: number, to: number) {
  const n = 48;
  return Array.from({ length: n + 1 }, (_, i) => project(onArc(radius, from + ((to - from) * i) / n, y)));
}
const pathOf = (pts: Slot[], close = false) => `M${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}${close ? 'Z' : ''}`;

/**
 * A point on the floor plus the matrix that lays flat text onto it: the text's x axis follows the
 * row's arc and its y axis runs outward toward the viewer, foreshortened as the floor is.
 */
function floorPlate(project: Projection, radius: number, theta: number) {
  const u = 0.05;
  const at = project(onArc(radius, theta, 0));
  const along = project(onArc(radius, theta + u / radius, 0));
  const out = project(onArc(radius + u, theta, 0));
  const tx = along.x - at.x, ty = along.y - at.y;
  const len = Math.hypot(tx, ty);
  const m = [tx / len, ty / len, (out.x - at.x) / len, (out.y - at.y) / len].map((v) => v.toFixed(3)).join(',');
  return { slot: at, matrix: `matrix(${m},0,0)` };
}

/** The whole hall for one team: seats, ring lines, the stage and the view box height, in view units. */
export function layoutHall<A>(desk: A, team: readonly A[]) {
  const { placed, project } = placeRows(desk, team);
  // One empty ring always waits beyond the last row, ready for the next hire.
  const rings = [...placed.filter((row) => row.ring).map((row) => row.radius), placed[placed.length - 1].radius + ROW_PITCH];
  const height = Math.round(project(onArc(rings[rings.length - 1] + 0.35, 0, 0)).y + 8);

  const stageEdge = (y: number, from: number, to: number) => Array.from({ length: 49 }, (_, i) => project(onStage(from + ((to - from) * i) / 48, y)));
  // The screens stand across the disc and cover its back half; the front half lies below their foot, so one layer behind them suffices.
  const stageFace = [...stageEdge(STAGE_H, -Math.PI / 2, Math.PI / 2), ...stageEdge(0, Math.PI / 2, -Math.PI / 2)];
  const stageTop = stageEdge(STAGE_H, -Math.PI, Math.PI);

  return {
    rows: placed,
    height,
    /** Extra room the stage needs above the view box; the hall is pulled up by the same amount. */
    lift: project.lift,
    rings: rings.map((radius) => ({ radius, path: pathOf(arcPoints(project, radius + SEAT_INSET, 0, -RING_SPAN, RING_SPAN)) })),
    stage: {
      face: pathOf(stageFace, true),
      top: pathOf(stageTop, true),
      topSpan: { y1: Math.min(...stageTop.map((p) => p.y)), y2: Math.max(...stageTop.map((p) => p.y)) },
      lip: pathOf(stageEdge(STAGE_H, -Math.PI / 2, Math.PI / 2)),
    },
  };
}
