// Shared by everything in the classroom that is drawn by three.js and shown as an <img>:
// figures, and the room's props. See figure3d.ts for the renderer and its snapshot cache.
import { useEffect, useState } from 'react';

/** Resolves a cached snapshot URL; null until three has drawn it. `key` must change whenever the picture would. */
export function useSnapshot(make: () => Promise<string>, key: string) {
  const [state, setState] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    let live = true;
    make().then((url) => { if (live) setState({ key, url }); }).catch(() => undefined);
    return () => { live = false; };
  }, [key]);
  return state?.key === key ? state.url : null;
}
