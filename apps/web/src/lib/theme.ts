export type ThemePref = 'system' | 'light' | 'dark';
export const THEME_KEY = 'rq-theme';

export function parseThemePref(v: string | null | undefined): ThemePref {
  return v === 'light' || v === 'dark' ? v : 'system';
}
export function resolveDark(pref: ThemePref, systemDark: boolean): boolean {
  return pref === 'dark' || (pref === 'system' && systemDark);
}
export function nextThemePref(p: ThemePref): ThemePref {
  return p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system';
}
