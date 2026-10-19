'use client';
import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { THEME_MODES, type ThemeMode, isThemeMode } from '@/lib/themes';
import { cn } from '@/lib/utils';

const icons = { system: Monitor, light: Sun, dark: Moon } as const;

/**
 * Three-way appearance control (system / light / dark). Applies instantly on
 * the client and persists in the eb-theme cookie for the next server render.
 */
export function AppearanceToggle({ className, compact = false }: { className?: string; compact?: boolean }) {
  const [mode, setMode] = React.useState<ThemeMode>('system');
  React.useEffect(() => {
    const m = document.documentElement.getAttribute('data-mode');
    if (isThemeMode(m)) setMode(m);
  }, []);

  function apply(next: ThemeMode) {
    setMode(next);
    const h = document.documentElement;
    h.setAttribute('data-mode', next);
    if (next === 'system') (window as unknown as { __ebApplyTheme?: () => void }).__ebApplyTheme?.();
    else h.setAttribute('data-theme', next);
    void fetch('/api/theme', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: next }) }).catch(() => {});
  }

  return (
    <div role="radiogroup" aria-label="Appearance" className={cn('inline-flex rounded-md border border-stone-200 bg-stone-50 p-0.5', className)}>
      {THEME_MODES.map((m) => {
        const Icon = icons[m.id];
        const active = m.id === mode;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${m.label} appearance`}
            title={m.description}
            onClick={() => apply(m.id)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-[calc(var(--radius-md)-2px)] px-2 text-xs font-medium transition-colors',
              active ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {!compact && <span>{m.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
