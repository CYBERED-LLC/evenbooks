'use client';
import * as React from 'react';

/**
 * Global single-key and two-key shortcuts ("n", "/", "g i", "mod+k", "shift+?").
 * Plain keys are ignored while typing in a field or when a dialog is open;
 * combinations with mod (Cmd on Mac, Ctrl elsewhere) always fire.
 */
export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
  }
  return false;
}

function keyName(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // shift is implied by characters like "?"; only name it for letters and named keys
  if (e.shiftKey && (/^[a-z]$/.test(k) || k.length > 1)) parts.push('shift');
  parts.push(k);
  return parts.join('+');
}

export function useHotkeys(map: HotkeyMap, enabled = true) {
  const ref = React.useRef(map);
  ref.current = map;
  React.useEffect(() => {
    if (!enabled) return;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const name = keyName(e);
      const hasMod = name.startsWith('mod+');
      if (!hasMod && (isTypingTarget(e.target) || document.querySelector('dialog[open]'))) return;
      const bindings = ref.current;
      const seq = pending ? `${pending} ${name}` : null;
      if (seq && bindings[seq]) {
        e.preventDefault();
        pending = null;
        bindings[seq]!(e);
        return;
      }
      if (bindings[name]) {
        e.preventDefault();
        pending = null;
        bindings[name]!(e);
        return;
      }
      // start of a two-key sequence?
      if (!hasMod && Object.keys(bindings).some((k) => k.startsWith(`${name} `))) {
        pending = name;
        clearTimeout(timer);
        timer = setTimeout(() => (pending = null), 1200);
      } else pending = null;
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [enabled]);
}

/**
 * Keyboard handler for a form container: Cmd/Ctrl+Enter runs the primary action
 * from any field. Spread onto the element wrapping the form.
 */
export function useSubmitShortcut(onSubmit: () => void, enabled = true) {
  const ref = React.useRef(onSubmit);
  ref.current = onSubmit;
  return React.useMemo(
    () => ({
      onKeyDown: (e: React.KeyboardEvent) => {
        if (!enabled) return;
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          ref.current();
        }
      },
    }),
    [enabled],
  );
}

/** "⌘" on Apple devices, "Ctrl" elsewhere. Starts as "Ctrl" so server and client render alike. */
export function useModKeyLabel(): string {
  const [label, setLabel] = React.useState('Ctrl');
  React.useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setLabel('⌘');
  }, []);
  return label;
}
