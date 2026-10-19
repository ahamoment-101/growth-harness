import { useLayoutEffect, type RefObject } from 'react';

const GAP = 4;

type Box = { left: number; right: number; top: number; bottom: number };
const overlaps = (a: Box, b: Box) => a.left < b.right + GAP && a.right > b.left - GAP && a.top < b.bottom + GAP && a.bottom > b.top - GAP;

/**
 * Keeps status bubbles from covering each other. Nearer bubbles (lower on screen) keep their
 * place; a farther one that would overlap rises just clear of it, through --bubble-raise.
 * Re-runs when the room resizes or `version` changes (bubble text changes their widths).
 */
export function useUnstackedBubbles(ref: RefObject<HTMLElement | null>, version: unknown) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const place = () => {
      // Boxes are measured on screen, where the stage is scaled; the raise is set in its own layout units.
      const scale = root.getBoundingClientRect().width / root.offsetWidth || 1;
      const bubbles = [...root.querySelectorAll<HTMLElement>('.status-bubble')];
      bubbles.forEach((el) => el.style.setProperty('--bubble-raise', '0px'));
      const measured = bubbles.map((el) => ({ el, box: el.getBoundingClientRect() })).sort((a, b) => b.box.bottom - a.box.bottom);
      const placed: Box[] = [];
      for (const { el, box } of measured) {
        const at: Box = { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        for (let hit = placed.find((p) => overlaps(at, p)); hit; hit = placed.find((p) => overlaps(at, p))) {
          const shift = at.bottom - (hit.top - GAP);
          at.top -= shift;
          at.bottom -= shift;
        }
        el.style.setProperty('--bubble-raise', `${Math.round((box.top - at.top) / scale)}px`);
        placed.push(at);
      }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => observer.disconnect();
  }, [ref, version]);
}
