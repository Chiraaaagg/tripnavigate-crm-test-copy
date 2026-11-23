'use client';

import { useEffect, useRef } from 'react';
import { useFocusTarget } from './open-parts';

/*
 * A page opened at a section or a field (legacy redirect, a checklist or
 * error-summary link, the /book entry, the Deal header's "Review and submit"):
 * `#target` or, if a redirect dropped the fragment, `?at=target` (freeze note
 * §2.1; Batch 2: the target may also be a field id). Opens the closed part
 * that holds the target, moves keyboard focus to the field or the section
 * heading and scrolls it into view. In-page `#…` links do the same, also when
 * the address already ends with that fragment. Losing the anchor only lands at
 * the top of the right step; it never loses data.
 */
export function SectionFocus() {
  const latest = useFocusTarget();
  const ref = useRef(latest);
  useEffect(() => {
    ref.current = latest;
  });
  useEffect(() => {
    const focusTarget = (id: string) => ref.current(id);
    const fromAddress = () => {
      const fromHash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
      const fromQuery = new URLSearchParams(window.location.search).get('at') ?? '';
      for (const target of [fromHash, fromQuery]) {
        if (target && /^[A-Za-z][\w-]*$/.test(target) && focusTarget(target)) return;
      }
    };
    const onClick = (e: MouseEvent) => {
      // Not bailing on defaultPrevented: a next/link to '#id' prevents the default itself and only scrolls; focus must still move.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.('a[href^="#"]');
      const href = link?.getAttribute('href') ?? '';
      const target = decodeURIComponent(href.slice(1));
      if (!target || !/^[A-Za-z][\w-]*$/.test(target)) return;
      if (!document.getElementById(target)) return;
      const handled = e.defaultPrevented;
      e.preventDefault();
      if (!handled && window.location.hash !== href) window.history.pushState(null, '', href);
      focusTarget(target);
    };
    fromAddress();
    window.addEventListener('hashchange', fromAddress);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('hashchange', fromAddress);
      document.removeEventListener('click', onClick);
    };
  }, []);
  return null;
}
