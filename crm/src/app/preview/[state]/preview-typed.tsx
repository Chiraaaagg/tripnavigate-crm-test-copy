'use client';

import { useEffect } from 'react';

/*
 * Local preview only. A refusal state starts with the refusal already on
 * screen, so nothing was typed in the open dialog. The desk commands keep
 * what the person typed after a refusal (useDeskCommand prevents the form
 * reset), so this fills the named fields once, as if typed, to show that.
 * Values are synthetic. Fields that already hold a value are left alone.
 */
/** `values` keys are field names, or CSS selectors when they hold "[", "#" or "."; `firstOnly` fills only the first match. */
export function PreviewTyped({ values, firstOnly = false }: { values: Record<string, string>; firstOnly?: boolean }) {
  useEffect(() => {
    let tries = 0;
    let timer = 0;
    const fill = () => {
      let missing = 0;
      for (const [name, value] of Object.entries(values)) {
        const selector = /[[#.]/.test(name) ? name : `input[name="${name}"]:not([type=hidden]):not([type=file]), textarea[name="${name}"]`;
        const all = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(selector)];
        if (all.length === 0) missing += 1;
        for (const el of firstOnly ? all.slice(0, 1) : all) {
          if (el.value.trim() !== '') continue;
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      // The dialog mounts in a portal after the page: try again for a moment.
      if (missing > 0 && tries < 20) {
        tries += 1;
        timer = window.setTimeout(fill, 50);
      }
    };
    fill();
    return () => window.clearTimeout(timer);
  }, [values, firstOnly]);
  return null;
}
