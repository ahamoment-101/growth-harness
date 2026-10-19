import { useEffect, type RefObject } from 'react';

function topmostLayer(): Element | null {
  const visible = (selector: string) => Array.from(document.querySelectorAll(selector))
    .filter((element) => element.getClientRects().length > 0);
  return visible(':popover-open').at(-1)
    ?? visible('dialog[open]').at(-1)
    ?? visible('[role="dialog"][aria-modal="true"], .switcher-menu').at(-1)
    ?? null;
}

export function isTopmostDismissLayer(layer: Element | null) {
  return !!layer && topmostLayer() === layer;
}

export function useEscapeDismiss(active: boolean, layer: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopmostDismissLayer(layer.current)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, layer, close]);
}
