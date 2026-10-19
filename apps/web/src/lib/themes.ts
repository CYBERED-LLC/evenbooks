/**
 * Appearance modes. The visual themes are Ledger (light) and Midnight (dark),
 * defined in globals.css; the mode says which one to use. "system" follows
 * the operating system and is the default. Stored per browser in a cookie.
 * See docs/brand-bible.md.
 */
export const THEME_COOKIE = 'eb-theme';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_MODES: { id: ThemeMode; label: string; description: string }[] = [
  { id: 'system', label: 'System', description: 'Follow the device setting' },
  { id: 'light', label: 'Light', description: 'Ledger: cream paper, ink, forest green' },
  { id: 'dark', label: 'Dark', description: 'Midnight: charcoal, mint, monospaced figures' },
];

export const DEFAULT_MODE: ThemeMode = 'system';

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'system' || v === 'light' || v === 'dark';
}

/** What the server renders before the client knows the system preference. */
export function initialThemeFor(mode: ThemeMode): ResolvedTheme {
  return mode === 'dark' ? 'dark' : 'light';
}

/** Inline script that resolves "system" before first paint and tracks changes. Keep it tiny and dependency-free. */
export const THEME_BOOT_SCRIPT = `(function(){try{var h=document.documentElement;var q=window.matchMedia('(prefers-color-scheme: dark)');function a(){if(h.getAttribute('data-mode')==='system'){h.setAttribute('data-theme',q.matches?'dark':'light')}}a();q.addEventListener('change',a);window.__ebApplyTheme=a}catch(e){}})();`;
