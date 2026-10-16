'use client';

import { useEffect, useState } from 'react';
import { THEME_KEY, nextThemePref, parseThemePref, resolveDark } from '@/lib/theme';
import type { ThemePref } from '@/lib/theme';

/** Inline script run before paint (see layout.tsx) to avoid a flash; keep in sync with resolveDark(). */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}`;

function apply(pref: ThemePref) {
  const sys = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', resolveDark(pref, sys));
}

const LABEL: Record<ThemePref, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };
const ICON: Record<ThemePref, string> = { system: '◐', light: '☀', dark: '☾' };

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>('system');

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      /* storage unavailable: stay on system */
    }
    setPref(parseThemePref(stored));
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply(pref);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const cycle = () => {
    const next = nextThemePref(pref);
    setPref(next);
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
    apply(next);
  };

  return (
    <button type="button" className="btn-ghost btn-sm" onClick={cycle} aria-label={`${LABEL[pref]}. Activate to change.`} title={LABEL[pref]}>
      <span aria-hidden="true">{ICON[pref]}</span>
      <span className="hidden sm:inline">{pref}</span>
    </button>
  );
}
