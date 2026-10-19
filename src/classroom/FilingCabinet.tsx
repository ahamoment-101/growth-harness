import type { Site } from '../api';
import { go, sitePage } from '../nav';
import { PROP_ASPECT, PROP_ORIGIN_Y, cabinetSnapshot, cabinetSnapshotKey, type V3 } from './figure3d';
import { useSnapshot } from './useSnapshot';

/** Face the room straight on, retaining the classroom camera’s elevated view. */
const VIEW: V3 = [0, 0.6, 0.74];
/** Its floor point in the 100×100 box, and the snapshot's width there. */
const FLOOR = { x: 50, y: 78 };
const WIDTH = 78;

/** A room object, not a seat: the site's research and reference shelf, in the crowd's own plastic. */
export function FilingCabinet({ site }: { site: Site }) {
  const url = useSnapshot(() => cabinetSnapshot(VIEW), cabinetSnapshotKey(VIEW));
  const height = WIDTH * PROP_ASPECT;
  return <button type="button" className="room-filing-cabinet" aria-label="File Cabinet" onClick={() => go(sitePage(site.id, 'cabinet'))}>
    <span className="cabinet-figure">
      <svg viewBox="0 0 100 100" aria-hidden>
        <ellipse cx="50" cy="78" rx="27" ry="6" fill="rgba(40,48,90,.16)" />
      </svg>
      {url ? <img className="figure-3d" src={url} alt="" draggable={false}
        style={{ left: `${FLOOR.x - WIDTH / 2}%`, top: `${FLOOR.y - height * PROP_ORIGIN_Y}%`, width: `${WIDTH}%`, height: `${height}%` }} /> : null}
    </span>
    <span className="cabinet-label" aria-hidden="true">File Cabinet</span>
  </button>;
}
