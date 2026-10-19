'use client';
import * as React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { useModKeyLabel } from '@/lib/use-hotkeys';
import { shortcutSections } from '@/components/nav-config';

/** "?" help: every keyboard shortcut in the app, grouped by where it works. */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mod = useModKeyLabel();
  const sections = shortcutSections(mod);
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" description="Single-key shortcuts work when you are not typing in a field." size="lg">
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2" data-autofocus tabIndex={-1}>
        {sections.map((s) => (
          <section key={s.title} aria-label={s.title}>
            <h3 className="mb-2 text-sm font-semibold text-stone-900">{s.title}</h3>
            <dl className="space-y-1.5 text-sm">
              {s.items.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3">
                  <dt className="text-stone-700">{item.label}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {item.keys.map((k, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && item.keys.length === 2 && item.keys[0] === 'G' && <span className="text-xs text-stone-400">then</span>}
                        <kbd className="min-w-6 rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 text-center font-sans text-xs text-stone-700">{k}</kbd>
                      </React.Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
