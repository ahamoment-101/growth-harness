import { useLayoutEffect, useState, type RefObject } from 'react';

/** The room is laid out once at this width; every window sees the same picture, scaled. */
export const STAGE_W = 1440;
/** The part of that width with something on it (the screen wall); the bare floor either side may fall outside the window. */
export const STAGE_CONTENT_W = 1180;
/** Below this the stage stops shrinking and the window scrolls instead (a very large team). */
const MIN_SCALE = 0.5;

/**
 * Fits the fixed-size stage inside the viewport, by width and height alike, and returns the
 * scale. The stage's own height still follows the team, so it is observed along with the window.
 */
export function useStageFit(viewport: RefObject<HTMLElement | null>, stage: RefObject<HTMLElement | null>) {
  const [fit, setFit] = useState({ scale: 1, height: 0 });

  useLayoutEffect(() => {
    const view = viewport.current;
    const room = stage.current;
    if (!view || !room) return;
    const measure = () => {
      // offsetHeight is the untransformed layout height, whatever scale is applied now.
      const height = room.offsetHeight;
      const scale = Math.max(MIN_SCALE, Math.min(view.clientWidth / STAGE_CONTENT_W, view.clientHeight / height));
      setFit((cur) => (cur.scale === scale && cur.height === height ? cur : { scale, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(view);
    observer.observe(room);
    return () => observer.disconnect();
  }, [viewport, stage]);

  return fit;
}
