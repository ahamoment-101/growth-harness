import { useEffect, useState } from 'react';
import { api } from '../api';
import type { LeaderConfiguration } from '../../shared/growth-leader';

export type ConfigurationView = LeaderConfiguration | { state: 'checking' | 'unavailable' };

/** Recheck on site changes, window focus, or an explicit retry; never call a paid model. */
export function useLeaderConfiguration(siteId: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ siteId: string; configuration: ConfigurationView } | null>(null);
  useEffect(() => {
    let live = true;
    let request = 0;
    const check = async () => {
      const sequence = ++request;
      try {
        const configuration = await api.leaderConfiguration(siteId);
        if (live && sequence === request) setResult({ siteId, configuration });
      } catch {
        if (live && sequence === request) setResult({ siteId, configuration: { state: 'unavailable' } });
      }
    };
    void check();
    window.addEventListener('focus', check);
    return () => { live = false; window.removeEventListener('focus', check); };
  }, [siteId, revision]);
  return {
    configuration: result?.siteId === siteId ? result.configuration : { state: 'checking' } as ConfigurationView,
    recheck: () => { setResult(null); setRevision(value => value + 1); },
  };
}
