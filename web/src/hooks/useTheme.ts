import { useCallback, useEffect, useState } from 'react';
import type { ThemePref } from '../../../shared/types';

const KEY = 'awsmon.theme';

function resolve(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'auto') return pref;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** In kiosk mode the admin's default theme always wins (the kiosk browser keeps no storage anyway). */
export function useTheme(defaultPref: ThemePref | undefined, ignoreLocal = false) {
  const [pref, setPref] = useState<ThemePref | null>(() => (ignoreLocal ? null : ((localStorage.getItem(KEY) as ThemePref | null) ?? null)));
  const effective: ThemePref = pref ?? defaultPref ?? 'dark';

  useEffect(() => {
    const apply = () => document.documentElement.setAttribute('data-theme', resolve(effective));
    apply();
    if (effective !== 'auto') return;
    const mq = matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [effective]);

  const cycle = useCallback(() => {
    const order: ThemePref[] = ['dark', 'light', 'auto'];
    const next = order[(order.indexOf(effective) + 1) % order.length] ?? 'dark';
    localStorage.setItem(KEY, next);
    setPref(next);
  }, [effective]);

  return { theme: effective, cycle };
}
